/**
 * Presigned upload operations — generate signed URL, confirm upload,
 * multipart orchestration (S3/GCS), and batch presigned URLs.
 *
 * **Provider routing: presigned flows target the DEFAULT provider by
 * design.** The presign URL, existence/stat checks at confirm time, and the
 * assembled multipart object all live in `deps.driver` (the registry's
 * default driver) — there is deliberately no per-call `provider` option:
 * the URL minted at presign time and the object verified at confirm time
 * MUST come from the same driver, and splitting them across two calls with
 * independent provider params would reintroduce the mismatch this package
 * guards against. Confirm/complete stamp `provider: registry.defaultName`
 * on the created doc so later per-doc routing (delete, read, transforms,
 * move) stays correct even if the engine's default provider changes.
 * To land client-completed uploads in a non-default provider, run a
 * dedicated engine whose default IS that provider.
 */

import type { OperationDeps } from './types.js';
import type { ConfirmUploadInput, OperationContext } from '../types/uploads.js';
import type { IMediaDocument } from '../types/media.js';
import type {
  PresignedUploadResult,
  HashStrategy,
  InitiateMultipartInput,
  MultipartUploadSession,
  CompleteMultipartInput,
  SignedPartResult,
  BatchPresignInput,
  BatchPresignResult,
} from '../types/storage.js';
import type { EventError } from './event-types.js';
import { createError } from '@classytic/repo-core/errors';
import { computeFileHash } from '../utils/hash';
import { isAllowedMimeType, isImage } from '../utils/mime';
import { normalizeFolderPath } from '../utils/folders';
import { assertAndClaim } from '@classytic/primitives/state-machine';
import { MEDIA_MACHINE } from '../models/media-state-machine.js';
import {
  log,
  requireTenant,
  generateScopedKey,
  generateTitle,
  assertGeneratedKeyShape,
  tenantKeySegment,
  deleteKeysBestEffort,
  deriveAspectRatio,
  fileTypeNotAllowed,
  fileTooLarge,
  assertStoredContentMatches,
} from './helpers';
import { MEDIA_ERROR_CODES, mediaError } from '../errors.js';
import { processImage } from './process-image';
import { resolveVisibility } from '../utils/visibility';
import { toStoredVariants } from './derivatives.js';

/**
 * Enforce the engine's upload policy (allowed MIME types + max size) before
 * signing. Presigned URLs bypass upload()'s buffer checks entirely, so the
 * policy must gate at signing time; `size` is the client-declared size and
 * is re-checked from storage at confirm time.
 */
export function enforcePresignPolicy(deps: OperationDeps, contentType: string, size?: number): void {
  const { allowed = [], maxSize } = deps.config.fileTypes || {};

  if (allowed.length > 0 && !isAllowedMimeType(contentType, allowed)) {
    throw fileTypeNotAllowed(contentType, allowed);
  }

  if (maxSize && size && size > maxSize) {
    throw fileTooLarge(maxSize);
  }
}

/**
 * Validate a client-supplied `url` against the driver-derived public URL.
 * The stored URL is ALWAYS derived server-side — this check only surfaces
 * forged/malformed input loudly instead of silently ignoring it.
 * Throws a 400 HttpError (`code: 'media.confirm.invalid_url'`).
 */
function assertClientUrlMatchesDriver(clientUrl: string, derivedUrl: string, key: string): void {
  const fail = (reason: string): never => {
    const err = createError(400, `Invalid url for key '${key}': ${reason}`);
    err.code = 'media.confirm.invalid_url';
    throw err;
  };

  let parsedOrNull: URL | null = null;
  try {
    parsedOrNull = new URL(clientUrl);
  } catch {
    parsedOrNull = null;
  }
  if (!parsedOrNull) fail('not an absolute URL');
  const parsed = parsedOrNull as URL;
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    fail(`unsupported scheme '${parsed.protocol}'`);
  }

  // Drivers with relative public URLs (e.g. LocalProvider baseUrl '/uploads')
  // can't be origin-compared — scheme validation above still applies.
  let derived: URL | null = null;
  try {
    derived = new URL(derivedUrl);
  } catch {
    derived = null;
  }
  if (derived && parsed.origin !== derived.origin) {
    fail(`origin '${parsed.origin}' does not match storage origin '${derived.origin}'`);
  }
}

/**
 * Verify a client-submitted key's tenant binding against the caller's scope.
 * Keys minted by generateScopedKey() under a tenant context carry a
 * `__t-<orgId>` segment; confirm-time requires an exact match BOTH ways:
 * a tenant-scoped caller can only claim keys minted for that tenant, and a
 * tenantless caller can only claim segmentless keys. Runs before any DB
 * lookup so it cannot leak whether a key exists.
 * Throws a 403 HttpError (`code: 'media.confirm.tenant_mismatch'`).
 */
function assertTenantBinding(tenantSegment: string | undefined, organizationId: unknown): void {
  const expected =
    organizationId !== undefined && organizationId !== null && organizationId !== ''
      ? tenantKeySegment(organizationId)
      : undefined;
  if (tenantSegment !== expected) {
    const err = createError(403, 'Storage key is not bound to this tenant scope');
    err.code = 'media.confirm.tenant_mismatch';
    throw err;
  }
}

/**
 * Generate a presigned upload URL for direct browser → cloud uploads.
 * After the client PUTs the file, call confirmUpload() to register it in the DB.
 * Tenant-scoped calls mint tenant-bound keys — see generateScopedKey().
 *
 * Always signs against the DEFAULT provider — see the module JSDoc for why
 * presigned flows have no per-call `provider` option.
 */
/**
 * The ONE answer for "this storage key already belongs to a media record".
 *
 * Raised from two places that must agree: the `isKeyRegistered()` pre-check,
 * and the unique-index violation when two confirmations race that pre-check.
 * A caller must not be able to tell which one fired — otherwise the concurrent
 * path would surface a raw E11000 as a 500 and look like a server fault rather
 * than the ownership refusal it is.
 */
function keyInUse(key: string): Error & { code?: string } {
  const err = createError(403, `Storage key '${key}' is already registered to an existing media record`);
  err.code = 'media.confirm.key_in_use';
  return err;
}

/**
 * The slice of the host's scan bridge the presigned path uses.
 *
 * Structural on purpose: media-kit calls a scanner without depending on one,
 * so a host can wire ClamAV, a cloud API or its own heuristic without this file
 * knowing which.
 */
interface ScanBridgeLike {
  scan(
    buffer: Buffer,
    mimeType: string,
    filename: string,
    ctx?: { organizationId?: string; userId?: string },
  ): Promise<{ verdict: string; reason?: string }>;
}

/**
 * MongoDB duplicate-key, at either layer it can surface from.
 *
 * The raw driver raises `E11000`, but the repository layer intercepts it first
 * and rethrows a 409 carrying a structural `duplicate` descriptor. Both are
 * matched, and both STRUCTURALLY — never by parsing the human message, which is
 * the layer most likely to be reworded and would take this guard blind without
 * failing anything.
 */
function isDuplicateKeyError(err: unknown): boolean {
  const e = err as {
    code?: unknown;
    codeName?: unknown;
    message?: unknown;
    status?: unknown;
    duplicate?: unknown;
  } | null;
  if (!e) return false;
  if (e.code === 11000 || e.codeName === 'DuplicateKey') return true;
  if (e.status === 409 && e.duplicate !== undefined) return true;
  return /E11000/.test(String(e.message ?? ''));
}

/**
 * Create the record that CLAIMS a storage key, translating the unique-index
 * violation into the same refusal the sequential pre-check produces.
 *
 * The pre-check reads and the create writes, with nothing binding them — so
 * under concurrency both callers pass the check and the DATABASE is the only
 * thing that can still say no. Here that "no" is normalised, because a caller
 * must not be able to distinguish the raced path (which would otherwise be a
 * 500 E11000) from the ordinary one.
 */
async function createOwningKey<T>(_deps: OperationDeps, key: string, create: () => Promise<T>): Promise<T> {
  try {
    return await create();
  } catch (err) {
    if (isDuplicateKeyError(err)) throw keyInUse(key);
    throw err;
  }
}

export async function getSignedUploadUrl(
  deps: OperationDeps,
  filename: string,
  contentType: string,
  options: { folder?: string; expiresIn?: number; size?: number } = {},
  context?: OperationContext,
): Promise<PresignedUploadResult> {
  if (!deps.driver.getSignedUploadUrl) {
    throw new Error(`Driver '${deps.driver.name}' does not support presigned uploads`);
  }

  // Same MIME/size gate as upload() — reject before signing anything
  enforcePresignPolicy(deps, contentType, options.size);

  const organizationId = requireTenant(deps, context);
  const folder = normalizeFolderPath(options.folder || deps.config.folders?.defaultFolder || 'uploads');
  const key = generateScopedKey(filename, folder, organizationId, deps.config.folders?.keyPrefix);

  const eventData = { filename, contentType, folder, key };

  await deps.events.emit('before:presignedUpload', {
    data: eventData,
    timestamp: new Date(),
  });

  try {
    const result = await deps.driver.getSignedUploadUrl(key, contentType, options.expiresIn);

    await deps.events.emit('after:presignedUpload', {
      context: { data: eventData, timestamp: new Date() },
      result,
      timestamp: new Date(),
    });

    return result;
  } catch (error) {
    const errorEvent: EventError<typeof eventData> = {
      context: { data: eventData, timestamp: new Date() },
      error: error as Error,
      timestamp: new Date(),
    };
    await deps.events.emit('error:presignedUpload', errorEvent);
    throw error;
  }
}

/**
 * Confirm a presigned upload. Verifies the file exists in storage
 * and creates the database record with status 'ready'.
 */
export async function confirmUpload(
  deps: OperationDeps,
  input: ConfirmUploadInput,
  context?: OperationContext,
): Promise<IMediaDocument> {
  const organizationId = requireTenant(deps, context);

  const eventCtx = {
    data: input,
    context,
    timestamp: new Date(),
  };
  await deps.events.emit('before:confirmUpload', eventCtx);

  try {
    // Enforce the same file policy as upload() — MIME type + size checks
    const { allowed = [], maxSize } = deps.config.fileTypes || {};

    if (allowed.length > 0 && !isAllowedMimeType(input.mimeType, allowed)) {
      throw fileTypeNotAllowed(input.mimeType, allowed);
    }

    if (maxSize && input.size > maxSize) {
      throw fileTooLarge(maxSize);
    }

    // Never trust the client-submitted key. It must have exactly the shape
    // getSignedUploadUrl()'s generateScopedKey() produced (folder prefix +
    // optional tenant segment + random basename) — anything else (traversal,
    // URLs, hand-crafted paths) is rejected before any storage call.
    const keyShape = assertGeneratedKeyShape(input.key);

    // Tenant binding: the key must have been minted FOR this caller's scope.
    // Closes the leaked-unconfirmed-key hole — knowing another tenant's key
    // is not enough to claim it. Checked before any DB/storage call.
    assertTenantBinding(keyShape.tenantSegment, organizationId);

    // Ownership guard: a key already registered to ANY media record (any
    // tenant, incl. soft-deleted) can't be confirmed again. Without this, a
    // caller who learns another tenant's key could register it under their
    // own tenant and later hardDelete() the other tenant's storage object.
    if (await deps.repository.isKeyRegistered(input.key)) throw keyInUse(input.key);

    // Verify the file actually exists in storage
    const exists = await deps.driver.exists(input.key);
    if (!exists) {
      throw mediaError(
        409,
        MEDIA_ERROR_CODES.UPLOAD_NOT_FOUND,
        `File not found in storage at key: ${input.key}. Upload may not have completed.`,
      );
    }

    // Fetch real metadata from storage for validation (fail-closed: stat errors reject the upload)
    let actualSize = input.size;
    let storageMimeType: string | undefined;
    const stat = await deps.driver.stat(input.key).catch((err: Error) => {
      throw new Error(
        `Cannot verify uploaded file metadata for key '${input.key}': ${err.message}. ` +
          `Refusing to trust client-provided metadata.`,
      );
    });

    actualSize = stat.size || input.size;
    storageMimeType = stat.contentType;

    // Cross-check: storage MIME vs client-claimed MIME
    if (storageMimeType && storageMimeType !== input.mimeType) {
      if (allowed.length > 0 && !isAllowedMimeType(storageMimeType, allowed)) {
        throw mediaError(
          415,
          MEDIA_ERROR_CODES.FILE_TYPE_NOT_ALLOWED,
          `File type mismatch: client claimed '${input.mimeType}' but storage reports '${storageMimeType}' which is not allowed. Allowed: ${allowed.join(', ')}`,
          { mimeType: storageMimeType },
        );
      }
      log(deps, 'warn', 'MIME type mismatch in confirmUpload', {
        key: input.key,
        clientMime: input.mimeType,
        storageMime: storageMimeType,
      });
    }

    // Re-check actual size from storage against limit
    if (maxSize && actualSize > maxSize) {
      throw fileTooLarge(maxSize);
    }

    // Use storage-reported MIME type as authoritative when available
    const effectiveMimeType = storageMimeType || input.mimeType;

    // verifyContent on bytes the API never saw: sniff the stored head (ranged read).
    await assertStoredContentMatches(deps, input.key, [effectiveMimeType, input.mimeType]);

    // Compute hash based on strategy (default: 'skip' — no file download, no storage cost)
    // Hash is only functionally useful when deduplication is enabled.
    const hashStrategy: HashStrategy = input.hashStrategy || 'skip';
    let hash = '';

    if (hashStrategy === 'sha256') {
      // Stream entire file for SHA-256 (expensive — only use when deduplication is enabled)
      /**
       * An EXPLICIT `hashStrategy: 'sha256'` must produce a real content hash
       * or FAIL. It used to fall back to `hash(key:size)` on any error — a
       * placeholder that is unique per object and therefore matches nothing,
       * so deduplication was silently off for exactly the caller who asked for
       * the strongest guarantee. The record looked identical to a correctly
       * hashed one; only the dedup that never fired would have shown it.
       */
      const { computeStreamHash } = await import('../utils/hash');
      const stream = await deps.driver.read(input.key);
      const algorithm = deps.config.deduplication?.algorithm || 'sha256';
      hash = await computeStreamHash(stream, algorithm);
      if (!hash) {
        throw createError(
          500,
          `Could not compute a ${algorithm} hash for '${input.key}'. ` +
            'Refusing to store a placeholder in its place — it would match nothing and ' +
            'disable deduplication for this asset without saying so.',
        );
      }
    } else if (hashStrategy === 'etag') {
      // Use ETag from storage stat — no file download
      hash = input.etag || stat.etag || computeFileHash(Buffer.from(`${input.key}:${actualSize}`));
    } else if (input.sha256) {
      /**
       * The CLIENT's content hash — the one dedup actually searches by.
       *
       * `start-write` answers "have I seen these bytes?" with
       * `existsByHash(sha256)`, where the sha256 is computed on the device from
       * the final blob. Confirm then stored `hash(key:size)` instead, so the
       * stored value and the searched value were different things and a repeat
       * upload of identical bytes could never hit. Deduplication was configured
       * on, reported no error, and deduplicated nothing.
       *
       * Same trust model as the display hints above: worst case a client
       * mis-reports its own tenant's hash and loses its own dedup. Note the
       * ordering — an explicit `hashStrategy` still wins, because a caller that
       * asked for a server-computed hash stated something specific and a
       * client-supplied value must not override it.
       */
      hash = input.sha256;
    } else {
      // 'skip' — deterministic placeholder from key+size (default)
      hash = computeFileHash(Buffer.from(`${input.key}:${actualSize}`));
    }

    // Determine folder from the key WITHOUT the tenant segment — the segment
    // is a key-format detail and must not leak into the doc's `folder` field
    // (visibility.byFolder rules and folder listings operate on it).
    const folder = input.folder || keyShape.folder || 'uploads';

    // Build public URL — ALWAYS derived from the driver. A client-supplied
    // `url` is validated (absolute http(s), matching storage origin) purely
    // to reject forged input loudly, then discarded.
    const url = deps.driver.getPublicUrl(input.key);
    if (input.url !== undefined) {
      assertClientUrlMatchesDriver(input.url, url, input.key);
    }

    // Generate title
    const title = input.title || generateTitle(input.filename);

    // Client-computed display hints (width/height/thumbhash/dominantColor)
    // — the client-processed flow (e.g. @classytic/media-transform) skips
    // server processing, so these are the only source of placeholder
    // metadata. If `process: true` runs below, server-computed values
    // overwrite them in the processing → ready patch.
    const clientAspectRatio = deriveAspectRatio(input.width, input.height);

    /**
     * Run the host's SCAN BRIDGE on the presigned path too, when one is wired.
     *
     * The bridge was honoured on buffered uploads and skipped here — so a
     * deployment that deliberately configured a scanner had it silently not run
     * on the flow that carries almost every upload. That is a declared
     * capability enforced in one place out of two; the operator sees "scanning
     * enabled" and gets it for the path nobody uses.
     *
     * This adds NO policy of its own: with no bridge configured — be-prod today
     * — nothing changes and nothing is downloaded. Whether to scan, and what to
     * do about SVG or mislabelled bytes, stays the host's decision. This only
     * makes that decision effective.
     *
     * Reading the object back is the cost of the presigned design (the API
     * never saw the bytes), and it is paid ONLY when a host asked for it.
     */
    let scanQuarantineReason: string | null = null;
    const scanBridge = (deps.repository as { bridges?: { scan?: ScanBridgeLike } }).bridges?.scan;
    if (scanBridge) {
      const chunks: Buffer[] = [];
      for await (const chunk of await deps.driver.read(input.key)) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as unknown as Uint8Array));
      }
      const bytes = Buffer.concat(chunks);

      let verdict: { verdict: string; reason?: string };
      try {
        verdict = await scanBridge.scan(bytes, effectiveMimeType, input.filename, {
          ...(organizationId ? { organizationId: String(organizationId) } : {}),
        });
      } catch (err) {
        // A scanner that ERRORS is not a clean bill of health — absence of an
        // answer is not a negative answer. Refuse rather than admit unscanned
        // bytes to a library whose operator believes scanning is on.
        throw mediaError(
          502,
          MEDIA_ERROR_CODES.SCAN_FAILED,
          `[media] scan failed for '${input.key}': ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      if (verdict.verdict === 'reject') {
        throw mediaError(
          422,
          MEDIA_ERROR_CODES.SCAN_REJECTED,
          `[media] upload rejected by scan: ${verdict.reason ?? 'no reason given'}`,
        );
      }
      if (verdict.verdict === 'quarantine') {
        scanQuarantineReason = verdict.reason ?? 'quarantined by scan';
      }
    }

    /**
     * Verify + normalise client derivatives BEFORE the record exists.
     *
     * Resolved here rather than inline so a rejected variant fails with NO media
     * row written. Building the row first and throwing during its construction
     * would be the same outcome by luck, not by design — and a rejected key
     * THROWS rather than dropping that variant, because a record silently
     * missing its variants is indistinguishable from a client that produced
     * none.
     */
    const storedVariants = input.variants?.length ? await toStoredVariants(deps, input.key, input.variants) : [];

    let media = await createOwningKey(deps, input.key, () =>
      deps.repository.createMedia(
        {
          filename: input.filename,
          /**
           * What the USER picked, which is not always what we store.
           *
           * A `photo.jpg` re-encoded to WebP is stored as `photo.webp` so the key
           * matches the bytes — but the provenance is still `photo.jpg`, and that
           * is what an operator recognises in a list. Defaulting this to the
           * stored name meant the original was overwritten by the derived one and
           * the user's own filename was simply gone.
           */
          originalFilename: input.originalFilename || input.filename,
          title,
          mimeType: effectiveMimeType,
          size: actualSize,
          url,
          key: input.key,
          hash,
          // Presigned flows always land in the default provider (see module
          // JSDoc). Stamp its registry key so per-doc routing survives a
          // later defaultProvider change.
          provider: deps.registry.defaultName,
          // A quarantined asset is NOT `ready`. The buffered path marks these
          // `error` so nothing serves them; the two paths must agree, or the same
          // verdict would mean two different things depending on how the file
          // arrived.
          status: scanQuarantineReason ? 'error' : 'ready',
          ...(scanQuarantineReason ? { errorMessage: scanQuarantineReason } : {}),
          folder,
          alt: input.alt,
          // Same precedence as upload(): explicit input > byFolder rule > default.
          visibility: resolveVisibility(deps.config.visibility, folder, input.visibility),
          tokenVersion: 0,
          variants: storedVariants,
          tags: [],
          metadata: {},
          ...(organizationId && { organizationId }),
          ...(input.expiresAt && { expiresAt: input.expiresAt }),
          ...(input.width !== undefined && { width: input.width }),
          ...(input.height !== undefined && { height: input.height }),
          ...(clientAspectRatio !== undefined && { aspectRatio: clientAspectRatio }),
          ...(input.thumbhash !== undefined && { thumbhash: input.thumbhash }),
          ...(input.dominantColor !== undefined && { dominantColor: input.dominantColor }),
        },
        context,
      ),
    );

    // Optional post-confirm processing (ThumbHash, dominant color, variants)
    if (input.process && deps.processor && isImage(effectiveMimeType)) {
      const mediaIdStr = media._id.toString();
      // Rollback list for the reprocess window, fed by processImage's onWrite.
      // processImage cleans up its OWN internal failures; this list covers
      // variant keys that landed in storage but were never persisted to the
      // doc because the finalising CAS below threw or lost its race — nothing
      // references those keys, so they must not outlive this block.
      // (Re-deleting a key processImage already cleaned is a no-op.)
      const reprocessKeys: string[] = [];
      try {
        // ready → processing — declared transition in MEDIA_MACHINE
        // for the post-confirm reprocess flow. assertAndClaim
        // validates the transition is legal AND wins the race in one
        // call. If another reprocess is in flight, claim returns null
        // and we skip silently (file is in storage and accessible;
        // redundant work is the only thing we're avoiding).
        const claimed = await assertAndClaim(MEDIA_MACHINE, deps.repository, mediaIdStr, {
          from: 'ready',
          to: 'processing',
          options: context as Record<string, unknown>,
        });
        if (!claimed) {
          log(deps, 'info', 'Skipping post-confirm processing — record not in ready state', {
            key: input.key,
            id: mediaIdStr,
          });
        } else {
          media = claimed;

          // Read file from storage for processing
          const stream = await deps.driver.read(input.key);
          const chunks: Buffer[] = [];
          for await (const chunk of stream) {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as unknown as Uint8Array));
          }
          const buffer = Buffer.concat(chunks);

          // Run through the same processImage pipeline as regular uploads
          const processed = await processImage(deps, {
            buffer,
            filename: input.filename,
            mimeType: effectiveMimeType,
            skipProcessing: false,
            targetFolder: folder,
            context,
            onWrite: (key) => {
              reprocessKeys.push(key);
            },
          });

          /**
           * WRITE THE PROCESSED BYTES BACK OVER THE PRIMARY.
           *
           * Without this, `process: true` was metadata-only: it computed
           * dimensions, placeholders and variants from the processed image and
           * then persisted the ORIGINAL object untouched. So the downloadable
           * primary kept its EXIF — including GPS — while every layer above
           * reported the asset as processed, and commerce-ui's own upload
           * contract told users the server had stripped it. A guarantee claimed
           * and not delivered, on the one path taken by clients that could not
           * process locally (old browsers) — i.e. exactly the uploads nobody
           * checks.
           *
           * Same key on purpose: the URL is already public and the record
           * already points at it, so replacing in place keeps one object with
           * one identity. `size` and `mimeType` are re-derived from what was
           * actually written — leaving the original's size beside re-encoded
           * bytes is how a later integrity check fails for no visible reason.
           *
           * Best-effort: a failed rewrite must NOT fail the upload, because the
           * original is still a valid asset. It is logged, and the metadata
           * below still describes what the user will see.
           */
          let rewrittenSize: number | undefined;
          let rewrittenMime: string | undefined;
          if (processed.finalBuffer && processed.finalBuffer.length > 0) {
            try {
              await deps.driver.write(input.key, processed.finalBuffer, processed.finalMimeType);
              rewrittenSize = processed.finalBuffer.length;
              rewrittenMime = processed.finalMimeType;
            } catch (rewriteErr) {
              log(deps, 'warn', 'Failed to replace primary with processed bytes — original retained', {
                key: input.key,
                error: rewriteErr instanceof Error ? rewriteErr.message : String(rewriteErr),
              });
            }
          }

          // processing → ready with payload merge in the same CAS.
          const payload: Record<string, unknown> = {
            width: processed.width,
            height: processed.height,
            aspectRatio: processed.aspectRatio,
            thumbhash: processed.thumbhash,
            dominantColor: processed.dominantColor,
            exif: processed.exif,
            ...(rewrittenSize !== undefined ? { size: rewrittenSize } : {}),
            ...(rewrittenMime !== undefined ? { mimeType: rewrittenMime } : {}),
          };
          if (processed.variants.length > 0) {
            payload.variants = processed.variants;
          }

          const finalised = await assertAndClaim(MEDIA_MACHINE, deps.repository, mediaIdStr, {
            from: 'processing',
            to: 'ready',
            patch: payload,
            options: context as Record<string, unknown>,
          });
          if (finalised) {
            media = finalised;
          } else {
            // Race lost — another worker moved the record out of
            // 'processing', so the variants we just wrote were never
            // persisted to the doc. Delete them or they orphan silently.
            await deleteKeysBestEffort(deps.driver, reprocessKeys, (orphanKey, deleteErr) => {
              log(deps, 'warn', 'Failed to delete orphaned reprocess variant', {
                key: orphanKey,
                error: deleteErr.message,
              });
            });
          }
        }
      } catch (processError) {
        // Processing failure is non-blocking — file is already uploaded and accessible.
        // Best-effort revert to ready via the same processing → ready
        // transition declared in MEDIA_MACHINE (the state graph doesn't
        // distinguish "successful reprocess" from "rolled-back reprocess";
        // both land the row in `ready`).
        try {
          await assertAndClaim(MEDIA_MACHINE, deps.repository, mediaIdStr, {
            from: 'processing',
            to: 'ready',
            options: context as Record<string, unknown>,
          });
        } catch {
          /* ignore revert failure */
        }
        // Variants written before the failure were never persisted to the
        // doc (the finalising CAS is the only thing that references them).
        await deleteKeysBestEffort(deps.driver, reprocessKeys, (orphanKey, deleteErr) => {
          log(deps, 'warn', 'Failed to delete orphaned reprocess variant', {
            key: orphanKey,
            error: deleteErr.message,
          });
        });
        log(deps, 'warn', 'Post-confirm processing failed (file still available)', {
          key: input.key,
          error: (processError as Error).message,
        });
      }
    }

    await deps.events.emit('after:confirmUpload', {
      context: eventCtx,
      result: media,
      timestamp: new Date(),
    });

    log(deps, 'info', 'Presigned upload confirmed', {
      id: media._id,
      key: input.key,
      folder,
    });

    return media;
  } catch (error) {
    const errorEvent: EventError<ConfirmUploadInput> = {
      context: eventCtx,
      error: error as Error,
      timestamp: new Date(),
    };
    await deps.events.emit('error:confirmUpload', errorEvent);
    throw error;
  }
}

// ============================================
// MULTIPART UPLOAD OPERATIONS
// ============================================

/**
 * Initiate a multipart upload session.
 * Auto-detects driver capabilities: S3-style multipart or GCS-style resumable.
 * Returns a discriminated union — client checks `session.type` for the upload strategy.
 */
export async function initiateMultipartUpload(
  deps: OperationDeps,
  input: InitiateMultipartInput,
  context?: OperationContext,
): Promise<MultipartUploadSession> {
  const organizationId = requireTenant(deps, context);

  if (!deps.driver.createMultipartUpload) {
    // Fall back to GCS resumable if available
    if (deps.driver.createResumableUpload) {
      const folder = normalizeFolderPath(input.folder || deps.config.folders?.defaultFolder || 'uploads');
      const key = generateScopedKey(input.filename, folder, organizationId, deps.config.folders?.keyPrefix);
      const result = await deps.driver.createResumableUpload(key, input.contentType);
      return {
        type: 'resumable',
        key: result.key,
        uploadUrl: result.uploadUrl,
        publicUrl: result.publicUrl,
        minChunkSize: result.minChunkSize,
        expiresAt: result.expiresAt,
      };
    }
    throw new Error(`Driver '${deps.driver.name}' does not support multipart or resumable uploads`);
  }

  const folder = normalizeFolderPath(input.folder || deps.config.folders?.defaultFolder || 'uploads');
  const key = generateScopedKey(input.filename, folder, organizationId, deps.config.folders?.keyPrefix);

  await deps.events.emit('before:multipartUpload', { data: input, timestamp: new Date() });

  const { uploadId } = await deps.driver.createMultipartUpload(key, input.contentType);

  // Optionally sign all parts upfront if partCount is provided
  let parts: SignedPartResult[] | undefined;
  if (input.partCount && deps.driver.signUploadPart) {
    parts = await Promise.all(
      Array.from({ length: input.partCount }, (_, i) =>
        deps.driver.signUploadPart!(key, uploadId, i + 1, input.expiresIn),
      ),
    );
  }

  const session: MultipartUploadSession = {
    type: 'multipart',
    key,
    uploadId,
    publicUrl: deps.driver.getPublicUrl(key),
    parts,
  };

  await deps.events.emit('after:multipartUpload', {
    context: { data: input, timestamp: new Date() },
    result: session,
    timestamp: new Date(),
  });

  return session;
}

/**
 * Sign a single upload part (for on-demand part signing).
 */
export async function signUploadPart(
  deps: OperationDeps,
  key: string,
  uploadId: string,
  partNumber: number,
  expiresIn?: number,
): Promise<SignedPartResult> {
  if (!deps.driver.signUploadPart) {
    throw new Error(`Driver '${deps.driver.name}' does not support part signing`);
  }
  return deps.driver.signUploadPart(key, uploadId, partNumber, expiresIn);
}

/**
 * Sign multiple upload parts at once.
 */
export async function signUploadParts(
  deps: OperationDeps,
  key: string,
  uploadId: string,
  partNumbers: number[],
  expiresIn?: number,
): Promise<SignedPartResult[]> {
  if (!deps.driver.signUploadPart) {
    throw new Error(`Driver '${deps.driver.name}' does not support part signing`);
  }
  return Promise.all(partNumbers.map((pn) => deps.driver.signUploadPart!(key, uploadId, pn, expiresIn)));
}

/**
 * Complete a multipart upload: assemble parts in storage + create DB record.
 * Optionally runs post-upload processing (ThumbHash, variants) for images.
 */
export async function completeMultipartUpload(
  deps: OperationDeps,
  input: CompleteMultipartInput,
  context?: OperationContext,
): Promise<IMediaDocument> {
  if (!deps.driver.completeMultipartUpload) {
    throw new Error(`Driver '${deps.driver.name}' does not support multipart completion`);
  }

  const organizationId = requireTenant(deps, context);

  await deps.events.emit('before:completeMultipart', {
    data: input,
    context,
    timestamp: new Date(),
  });

  try {
    // Enforce the same file policy as upload()/confirmUpload() — MIME type + size checks
    const { allowed = [], maxSize } = deps.config.fileTypes || {};

    if (allowed.length > 0 && !isAllowedMimeType(input.mimeType, allowed)) {
      throw fileTypeNotAllowed(input.mimeType, allowed);
    }

    if (maxSize && input.size > maxSize) {
      throw fileTooLarge(maxSize);
    }

    // Same key defenses as confirmUpload(): the client-submitted key must
    // have the minted shape, be bound to this caller's tenant scope, and not
    // already belong to a media record. Storage additionally binds key ↔
    // uploadId, but the DB row below is created from the raw input — these
    // checks are what keep it trustworthy.
    const keyShape = assertGeneratedKeyShape(input.key);
    assertTenantBinding(keyShape.tenantSegment, organizationId);
    if (await deps.repository.isKeyRegistered(input.key)) throw keyInUse(input.key);

    // Assemble parts in storage
    const { etag, size } = await deps.driver.completeMultipartUpload(input.key, input.uploadId, input.parts);

    // Use actual size from storage (more reliable than client-reported)
    const actualSize = size || input.size;

    // Re-check actual size from storage against limit (client may have lied)
    if (maxSize && actualSize > maxSize) {
      throw fileTooLarge(maxSize);
    }

    // verifyContent on the assembled object (ranged read of its head).
    await assertStoredContentMatches(deps, input.key, [input.mimeType]);

    // Hash from ETag (zero cost — already computed by S3 during multipart)
    const hash = etag || computeFileHash(Buffer.from(`${input.key}:${actualSize}`));

    // Folder from the key WITHOUT the tenant segment (same as confirmUpload)
    const folder = input.folder || keyShape.folder || 'uploads';
    const url = deps.driver.getPublicUrl(input.key);
    const title = input.title || generateTitle(input.filename);

    // Client-computed display hints — same contract as confirmUpload():
    // server-computed values overwrite these when `process: true` runs.
    const clientAspectRatio = deriveAspectRatio(input.width, input.height);

    // Create DB record
    let media = await createOwningKey(deps, input.key, () =>
      deps.repository.createMedia(
        {
          filename: input.filename,
          /**
           * What the USER picked, which is not always what we store.
           *
           * A `photo.jpg` re-encoded to WebP is stored as `photo.webp` so the key
           * matches the bytes — but the provenance is still `photo.jpg`, and that
           * is what an operator recognises in a list. Defaulting this to the
           * stored name meant the original was overwritten by the derived one and
           * the user's own filename was simply gone.
           */
          originalFilename: input.originalFilename || input.filename,
          title,
          mimeType: input.mimeType,
          size: actualSize,
          url,
          key: input.key,
          hash,
          // Presigned/multipart flows always land in the default provider (see
          // module JSDoc). Stamp its registry key so per-doc routing survives
          // a later defaultProvider change.
          provider: deps.registry.defaultName,
          status: 'ready',
          folder,
          alt: input.alt,
          // Same precedence as upload()/confirmUpload(): byFolder rule > default.
          visibility: resolveVisibility(deps.config.visibility, folder),
          tokenVersion: 0,
          variants: [],
          tags: [],
          metadata: {},
          ...(organizationId && { organizationId }),
          ...(input.width !== undefined && { width: input.width }),
          ...(input.height !== undefined && { height: input.height }),
          ...(clientAspectRatio !== undefined && { aspectRatio: clientAspectRatio }),
          ...(input.thumbhash !== undefined && { thumbhash: input.thumbhash }),
          ...(input.dominantColor !== undefined && { dominantColor: input.dominantColor }),
        },
        context,
      ),
    );

    // Optional post-upload processing (same as confirmUpload process flag)
    if (input.process && deps.processor && isImage(input.mimeType)) {
      const mediaIdStr = media._id.toString();
      // Same reprocess rollback contract as confirmUpload — see the comment
      // there. Keys written by processImage but never persisted by the
      // finalising CAS must not outlive this block.
      const reprocessKeys: string[] = [];
      try {
        // ready → processing — same MEDIA_MACHINE transition used by
        // confirmUpload's reprocess flow.
        const claimed = await assertAndClaim(MEDIA_MACHINE, deps.repository, mediaIdStr, {
          from: 'ready',
          to: 'processing',
          options: context as Record<string, unknown>,
        });
        if (!claimed) {
          log(deps, 'info', 'Skipping post-multipart processing — record not in ready state', {
            key: input.key,
            id: mediaIdStr,
          });
        } else {
          media = claimed;

          const stream = await deps.driver.read(input.key);
          const chunks: Buffer[] = [];
          for await (const chunk of stream) {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as unknown as Uint8Array));
          }
          const buffer = Buffer.concat(chunks);

          const processed = await processImage(deps, {
            buffer,
            filename: input.filename,
            mimeType: input.mimeType,
            skipProcessing: false,
            targetFolder: folder,
            context,
            onWrite: (key) => {
              reprocessKeys.push(key);
            },
          });

          const payload: Record<string, unknown> = {
            width: processed.width,
            height: processed.height,
            aspectRatio: processed.aspectRatio,
            thumbhash: processed.thumbhash,
            dominantColor: processed.dominantColor,
            exif: processed.exif,
          };
          if (processed.variants.length > 0) {
            payload.variants = processed.variants;
          }

          const finalised = await assertAndClaim(MEDIA_MACHINE, deps.repository, mediaIdStr, {
            from: 'processing',
            to: 'ready',
            patch: payload,
            options: context as Record<string, unknown>,
          });
          if (finalised) {
            media = finalised;
          } else {
            // Race lost — the variants we wrote were never persisted.
            await deleteKeysBestEffort(deps.driver, reprocessKeys, (orphanKey, deleteErr) => {
              log(deps, 'warn', 'Failed to delete orphaned reprocess variant', {
                key: orphanKey,
                error: deleteErr.message,
              });
            });
          }
        }
      } catch (processError) {
        // Best-effort revert if we left the record stuck in 'processing'.
        // Same processing → ready transition as the success path.
        try {
          await assertAndClaim(MEDIA_MACHINE, deps.repository, mediaIdStr, {
            from: 'processing',
            to: 'ready',
            options: context as Record<string, unknown>,
          });
        } catch {
          /* ignore */
        }
        // Variants written before the failure were never persisted to the doc.
        await deleteKeysBestEffort(deps.driver, reprocessKeys, (orphanKey, deleteErr) => {
          log(deps, 'warn', 'Failed to delete orphaned reprocess variant', {
            key: orphanKey,
            error: deleteErr.message,
          });
        });
        log(deps, 'warn', 'Post-multipart processing failed (file still available)', {
          key: input.key,
          error: (processError as Error).message,
        });
      }
    }

    await deps.events.emit('after:completeMultipart', {
      context: { data: input, context, timestamp: new Date() },
      result: media,
      timestamp: new Date(),
    });

    return media;
  } catch (error) {
    await deps.events.emit('error:completeMultipart', {
      context: { data: input, context, timestamp: new Date() },
      error: error as Error,
      timestamp: new Date(),
    });
    throw error;
  }
}

/**
 * Abort a multipart upload and clean up parts in storage.
 *
 * When a `context` is provided (wire-facing callers — e.g. an arc-media
 * abort route), the key runs the SAME guard as confirm: generated-shape
 * check + both-ways tenant binding (403 `media.confirm.tenant_mismatch`),
 * so an authenticated caller can only abort sessions minted for their own
 * scope — knowing another tenant's key+uploadId is not enough to kill their
 * in-flight upload. Trusted server-side cleanup can omit `context`
 * (pre-3.7 behavior, no guard).
 */
export async function abortMultipartUpload(
  deps: OperationDeps,
  key: string,
  uploadId: string,
  context?: OperationContext,
): Promise<void> {
  if (context !== undefined) {
    const organizationId = requireTenant(deps, context);
    const keyShape = assertGeneratedKeyShape(key);
    assertTenantBinding(keyShape.tenantSegment, organizationId);
  }
  if (!deps.driver.abortMultipartUpload) {
    throw new Error(`Driver '${deps.driver.name}' does not support multipart abort`);
  }
  await deps.driver.abortMultipartUpload(key, uploadId);
  log(deps, 'info', 'Multipart upload aborted', { key, uploadId });
}

/**
 * Generate presigned PUT URLs for multiple files in parallel.
 * Useful for HLS segment uploads or batch file uploads.
 */
export async function generateBatchPutUrls(
  deps: OperationDeps,
  input: BatchPresignInput,
  context?: OperationContext,
): Promise<BatchPresignResult> {
  if (!deps.driver.getSignedUploadUrl) {
    throw new Error(`Driver '${deps.driver.name}' does not support presigned uploads`);
  }

  // Same MIME/size gate as upload() — reject the whole batch before signing
  for (const file of input.files) {
    enforcePresignPolicy(deps, file.contentType, file.size);
  }

  const organizationId = requireTenant(deps, context);
  const folder = normalizeFolderPath(input.folder || deps.config.folders?.defaultFolder || 'uploads');

  const uploads = await Promise.all(
    input.files.map((file) => {
      const key = generateScopedKey(file.filename, folder, organizationId, deps.config.folders?.keyPrefix);
      return deps.driver.getSignedUploadUrl!(key, file.contentType, input.expiresIn);
    }),
  );

  return { uploads };
}
