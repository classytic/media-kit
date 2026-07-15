/**
 * Upload verbs — upload, uploadMany, replace (+ the internal upload pipeline).
 *
 * Extracted from MediaRepository; each function takes the repository as its
 * first parameter. The class methods in media.repository.ts are thin
 * delegates that preserve the public API surface.
 */

import { createError } from '@classytic/repo-core/errors';
import { assertAndClaim } from '@classytic/primitives/state-machine';
import type { IMediaDocument, UploadInput, GeneratedVariant, MediaVisibility, StorageDriver } from '../../types.js';
import type { MediaContext } from '../../engine/engine-types.js';
import type { ScanResult } from '../../bridges/scan.bridge.js';
import { MEDIA_MACHINE } from '../../models/media-state-machine.js';
import { MEDIA_EVENTS } from '../../events/event-constants.js';
import { createMediaEvent } from '../../events/helpers.js';
import { resolveVisibility } from '../../utils/visibility.js';
import { computeFileHash } from '../../utils/hash.js';
import { isImage } from '../../utils/mime.js';
import { normalizeFolderPath } from '../../utils/folders.js';
import { isExternalMedia } from '../../utils/external.js';
import { generateAltText, generateAltTextWithOptions } from '../../utils/alt-text.js';
import { processImage } from '../../operations/process-image.js';
import {
  deleteKeysBestEffort,
  deriveAspectRatio,
  generateKey,
  generateTitle,
  validateFile as validateFileHelper,
} from '../../operations/helpers.js';
import type { MediaRepository } from '../media.repository.js';

/**
 * Upload a single file with status-driven flow.
 * pending → processing → ready | error.
 * Publishes media:asset.uploaded on success.
 */
export async function uploadVerb(
  repo: MediaRepository,
  input: UploadInput,
  ctx?: MediaContext,
): Promise<IMediaDocument> {
  const { buffer, filename, mimeType } = input;

  // Validate
  validateFileHelper({ config: repo.mediaConfig }, buffer, filename, mimeType);

  // Scan (if bridge provided) — reject / quarantine per verdict.
  // 'quarantine' is handled after upload — we allow write but mark status: 'error'.
  let scanQuarantine: ScanResult | null = null;
  if (repo.bridges.scan) {
    let scan: ScanResult;
    try {
      scan = await repo.bridges.scan.scan(buffer, mimeType, filename, {
        organizationId: ctx?.organizationId ? String(ctx.organizationId) : undefined,
        userId: ctx?.userId ? String(ctx.userId) : undefined,
      });
    } catch (err) {
      // Thrown scan errors → reject the upload
      throw new Error(`[media-kit] scan failed: ${(err as Error).message}`);
    }
    if (scan.verdict === 'reject') {
      throw new Error(`[media-kit] upload rejected by scan: ${scan.reason ?? 'no reason given'}`);
    }
    if (scan.verdict === 'quarantine') {
      scanQuarantine = scan;
    }
  }

  // Compute hash
  const hashAlgorithm = repo.mediaConfig.deduplication?.algorithm || 'sha256';
  const hash = computeFileHash(buffer, hashAlgorithm);

  // Deduplication check
  if (repo.mediaConfig.deduplication?.enabled) {
    const existing = await repo.getByHash(hash, ctx);
    if (existing && repo.mediaConfig.deduplication.returnExisting !== false) {
      repo._log('info', 'Deduplication hit: returning existing file', { hash, existingId: existing._id });
      return existing;
    }
  }

  // Use semaphore for concurrency control
  let media = await repo.uploadSemaphore.run(async () => {
    return performUpload(repo, { ...input, hash }, ctx);
  });

  // Apply quarantine verdict from scan bridge (if present)
  if (scanQuarantine) {
    const quarantined = await repo.update(
      String(media._id),
      {
        status: 'error',
        errorMessage: `Quarantined: ${scanQuarantine.reason ?? 'manual review required'}`,
        metadata: { ...media.metadata, scanMetadata: scanQuarantine.metadata ?? {} },
      },
      { session: ctx?.session, organizationId: ctx?.organizationId },
    );
    if (!quarantined) throw new Error(`[media-kit] Media disappeared during quarantine update: ${media._id}`);
    media = quarantined;
  }

  repo._log('info', 'Media uploaded', { id: media._id, folder: media.folder, size: media.size });

  await repo.events.publish(
    createMediaEvent(
      MEDIA_EVENTS.ASSET_UPLOADED,
      {
        assetId: String(media._id),
        filename: media.filename,
        mimeType: media.mimeType,
        size: media.size,
        folder: media.folder,
        key: media.key,
        url: media.url,
        hash: media.hash,
      },
      ctx,
      { resource: 'media', resourceId: String(media._id) },
    ),
  );

  return media;
}

/**
 * Upload multiple files. Partial failures do not block successful uploads.
 */
export async function uploadManyVerb(
  repo: MediaRepository,
  inputs: UploadInput[],
  ctx?: MediaContext,
): Promise<IMediaDocument[]> {
  const settled = await Promise.allSettled(inputs.map((input) => repo.upload(input, ctx)));
  const successes: IMediaDocument[] = [];
  for (const result of settled) {
    if (result.status === 'fulfilled') successes.push(result.value);
  }
  return successes;
}

/**
 * Replace file content while preserving the document ID.
 */
export async function replaceVerb(
  repo: MediaRepository,
  id: string,
  input: UploadInput,
  ctx?: MediaContext,
): Promise<IMediaDocument> {
  const existing = await repo.getById(id, { ...ctx });
  if (!existing) throw new Error(`Media ${id} not found`);

  // External records own no bytes to replace — and their sentinel key must
  // never flow into storage writes/deletes. Re-host via importFromUrl() or
  // upload() + hardDelete() instead.
  if (isExternalMedia(existing)) {
    const err = createError(
      400,
      `[media-kit] replace() is not supported for external media ${id} — ` +
        `it references a third-party URL and owns no bytes. Upload a new asset or use importFromUrl().`,
    );
    err.code = 'media.external.no_bytes';
    throw err;
  }

  const previousKey = existing.key;
  const previousVariants = [...(existing.variants || [])];

  // Process new file through the upload pipeline
  const { buffer, filename, mimeType } = input;
  validateFileHelper({ config: repo.mediaConfig }, buffer, filename, mimeType);

  const hashAlgorithm = repo.mediaConfig.deduplication?.algorithm || 'sha256';
  const hash = computeFileHash(buffer, hashAlgorithm);
  const targetFolder = normalizeFolderPath(input.folder || existing.folder || 'general');

  // Resolve provider key BEFORE processing: explicit input > existing doc >
  // default. processImage writes the `__original` + size variants through
  // its deps driver — binding it here keeps variants in the SAME provider
  // as the main file (a default-driver deps bag would scatter them).
  const providerKey = input.provider ?? existing.provider ?? repo.registry.defaultName;
  const driver = repo.registry.resolve(providerKey);

  // Every key written during this replace, in write order — fed FIRST by
  // processImage's onWrite collector (`__original` + size variants as they
  // land, INCLUDING keys processImage itself cleans up when it fails
  // internally and falls back), then by the main write below. processImage
  // owns cleanup of its own failure window; this list covers the
  // post-return window (main write / DB update failure). Rollback deletes
  // are best-effort, so re-deleting an already-cleaned key is a no-op.
  const newlyWrittenKeys: string[] = [];

  // Process image (variants written via the resolved driver)
  const processed = await processImage(repo._opDepsWith(driver), {
    buffer,
    filename,
    mimeType,
    skipProcessing: input.skipProcessing,
    contentType: input.contentType,
    focalPoint: input.focalPoint,
    targetFolder,
    context: repo._opCtx(ctx),
    quality: input.quality,
    format: input.format,
    maxWidth: input.maxWidth,
    maxHeight: input.maxHeight,
    onWrite: (key) => {
      newlyWrittenKeys.push(key);
    },
  });

  const newKey = generateKey(processed.finalFilename, targetFolder, repo.mediaConfig.folders?.keyPrefix);

  // Visibility: explicit input wins, otherwise preserve the existing doc's.
  const visibility: MediaVisibility = input.visibility ?? existing.visibility ?? 'public';

  // Write new main file + update DB. Same storage-DB consistency contract
  // as executeKeyRewrite: the doc's `key` must always point at a live
  // object. If the main write or the DB update fails, every newly-written
  // key (variants from processImage + the main object if it landed) is
  // rolled back best-effort through the SAME driver, the old object stays
  // untouched (the doc still references it), and the error propagates.
  let updated: IMediaDocument | null;
  let writeResult: Awaited<ReturnType<StorageDriver['write']>>;
  try {
    writeResult = await driver.write(
      newKey,
      processed.finalBuffer,
      processed.finalMimeType,
      visibility === 'private' ? { acl: 'private' } : undefined,
    );
    newlyWrittenKeys.push(writeResult.key);

    updated = await repo.update(
      id,
      {
        filename: processed.finalFilename,
        originalFilename: filename,
        mimeType: processed.finalMimeType,
        size: writeResult.size,
        url: writeResult.url,
        key: writeResult.key,
        hash,
        provider: providerKey,
        width: processed.width,
        height: processed.height,
        aspectRatio: processed.aspectRatio,
        variants: processed.variants,
        status: 'ready',
        thumbhash: processed.thumbhash,
        dominantColor: processed.dominantColor,
        exif: processed.exif,
        ...(writeResult.metadata && { providerMetadata: writeResult.metadata }),
        ...(input.alt !== undefined && { alt: input.alt }),
        ...(input.title !== undefined && { title: input.title }),
        ...(input.visibility !== undefined && { visibility: input.visibility }),
      },
      { session: ctx?.session },
    );
    if (!updated) throw new Error(`[media-kit] Media not found after replace: ${id}`);
  } catch (err) {
    // Best-effort orphan rollback through the SAME driver the writes went to.
    await deleteKeysBestEffort(driver, newlyWrittenKeys);
    throw err;
  }

  // Cleanup old files from old provider (best-effort)
  const oldDriver = repo.registry.resolve(existing.provider ?? repo.registry.defaultName);
  try {
    await oldDriver.delete(previousKey);
  } catch {
    /* ignore */
  }
  for (const v of previousVariants) {
    try {
      await oldDriver.delete(v.key);
    } catch {
      /* ignore */
    }
  }

  // Evict the replaced keys from the CDN edge (best-effort) — without this
  // a CDN keeps serving the OLD bytes for up to its cache TTL.
  await repo._purgeCdn([previousKey, ...previousVariants.map((v) => v.key)], ctx);

  await repo.events.publish(
    createMediaEvent(
      MEDIA_EVENTS.ASSET_REPLACED,
      {
        assetId: String(updated._id),
        filename: updated.filename,
        mimeType: updated.mimeType,
        size: updated.size,
        previousKey,
        newKey: writeResult.key,
      },
      ctx,
      { resource: 'media', resourceId: String(updated._id) },
    ),
  );

  return updated;
}

// ============================================================
// INTERNAL — Upload pipeline
// ============================================================

/**
 * Internal upload implementation. Status lifecycle: pending → processing → ready | error.
 */
async function performUpload(
  repo: MediaRepository,
  input: UploadInput & { hash: string },
  ctx?: MediaContext,
): Promise<IMediaDocument> {
  const { buffer, filename, mimeType, folder, hash } = input;
  let { alt } = input;

  // Generate alt text
  if (!alt && isImage(mimeType)) {
    const generateAltConfig = repo.mediaConfig.processing?.generateAlt;
    if (generateAltConfig) {
      const enabled = typeof generateAltConfig === 'boolean' ? generateAltConfig : generateAltConfig.enabled;
      if (enabled) {
        if (typeof generateAltConfig === 'object' && generateAltConfig.generator) {
          try {
            alt = (await generateAltConfig.generator(filename, buffer)) || generateAltConfig.fallback || 'Image';
          } catch {
            alt = generateAltConfig.fallback || generateAltText(filename);
          }
        } else if (typeof generateAltConfig === 'object' && generateAltConfig.strategy === 'filename') {
          alt = generateAltTextWithOptions(filename, { fallback: generateAltConfig.fallback });
        } else {
          alt = generateAltText(filename);
        }
      }
    }
  }

  const targetFolder = normalizeFolderPath(folder || repo.mediaConfig.folders?.defaultFolder || 'general');
  const finalTitle = input.title || generateTitle(filename);
  let key = generateKey(filename, targetFolder, repo.mediaConfig.folders?.keyPrefix);

  // Visibility: explicit per-upload > byFolder rule > config default > 'public'.
  const visibility = resolveVisibility(repo.mediaConfig.visibility, targetFolder, input.visibility);
  // Per-object ACL hint — honored by S3; other drivers ignore it (GCS
  // privacy is bucket-level IAM; Local/Cloudinary/etc. have no object ACL).
  const writeOptions = visibility === 'private' ? { acl: 'private' as const } : undefined;

  // Resolve which driver handles this upload — store the registry key, not
  // the driver's own `name`, so that lookup always works regardless of whether
  // the driver reuses a generic name (e.g. two MemoryStorageDrivers both have
  // `name = 'memory'` but live under different registry keys).
  const providerKey = input.provider ?? repo.registry.defaultName;
  const driver = repo.registry.resolve(providerKey);

  // Step 1: Create DB record with status: 'pending'
  let media = await repo.create(
    {
      filename,
      originalFilename: filename,
      title: finalTitle,
      mimeType,
      size: buffer.length,
      url: driver.getPublicUrl(key),
      key,
      hash,
      provider: providerKey,
      status: 'pending',
      visibility,
      tokenVersion: 0,
      folder: targetFolder,
      alt,
      description: input.description,
      tags: input.tags || [],
      focalPoint: input.focalPoint,
      variants: [],
      metadata: {},
      ...(input.sourceId && { sourceId: input.sourceId }),
      ...(input.sourceModel && { sourceModel: input.sourceModel }),
      ...(input.expiresAt && { expiresAt: input.expiresAt }),
    },
    { session: ctx?.session, organizationId: ctx?.organizationId },
  );

  const mediaId = String(media._id);
  const variants: GeneratedVariant[] = [];

  // Rollback bookkeeping for the catch below:
  // - pendingDocKey: the create-time key the pending doc references — the
  //   only storage key an error-state record may legitimately point at.
  // - writtenKeys: every variant key processImage writes (fed by onWrite —
  //   a superset of `processed.variants`, it also sees keys written before
  //   an internal processImage fallback, which processImage already cleans;
  //   re-deleting those is a best-effort no-op).
  // - mainWriteKey: the Step-3 main object key, orphaned when it differs
  //   from pendingDocKey (format change regenerated the key) and the
  //   processing → ready CAS never landed.
  const pendingDocKey = key;
  const writtenKeys: string[] = [];
  let mainWriteKey: string | undefined;

  const updateOpts: Record<string, unknown> = { session: ctx?.session, organizationId: ctx?.organizationId };

  try {
    // Step 2: pending → processing. State machine + atomic CAS in
    // one call via primitives' `assertAndClaim`:
    //   - `MEDIA_MACHINE.assertTransition` rejects malformed
    //     transitions (compile-time-typed targets, sync, fast).
    //   - `repo.claim()` rejects concurrent writers (atomic CAS,
    //     null on race-loss).
    // Race-safe against retry-driven re-uploads (cron reaping stuck
    // uploads, host-side retries) — concurrent claimers see one
    // winner + N-1 nulls.
    const processing = await assertAndClaim(MEDIA_MACHINE, repo, mediaId, {
      from: 'pending',
      to: 'processing',
      options: updateOpts,
    });
    if (!processing) {
      throw new Error(
        `[media-kit] Failed to claim pending → processing for ${mediaId}: ` +
          `record may have been claimed by another worker, deleted, or already past pending.`,
      );
    }
    media = processing;

    // Bind processImage to the upload's resolved driver so `__original` +
    // size variants land in the SAME provider as the main file.
    const processed = await processImage(repo._opDepsWith(driver), {
      buffer,
      filename,
      mimeType,
      skipProcessing: input.skipProcessing,
      contentType: input.contentType,
      focalPoint: input.focalPoint,
      targetFolder,
      context: repo._opCtx(ctx),
      quality: input.quality,
      format: input.format,
      maxWidth: input.maxWidth,
      maxHeight: input.maxHeight,
      onWrite: (writtenKey) => {
        writtenKeys.push(writtenKey);
      },
    });
    variants.push(...processed.variants);

    if (processed.finalMimeType !== mimeType) {
      key = generateKey(processed.finalFilename, targetFolder);
    }

    // Step 3: Write to storage via the resolved provider
    const writeResult = await driver.write(key, processed.finalBuffer, processed.finalMimeType, writeOptions);
    mainWriteKey = writeResult.key;

    // Step 4: processing → ready. State transition + payload write
    // in one atomic CAS — partial-failure can't leave a record
    // half-updated.
    //
    // Display-hint precedence: server-computed values ALWAYS win; the
    // client-computed hints (width/height/thumbhash/dominantColor from
    // e.g. @classytic/media-transform) only land when processing left
    // the corresponding value unset (skipProcessing, processing
    // disabled, or no processor installed).
    const ready = await assertAndClaim(MEDIA_MACHINE, repo, mediaId, {
      from: 'processing',
      to: 'ready',
      patch: {
        filename: processed.finalFilename,
        mimeType: processed.finalMimeType,
        size: writeResult.size,
        url: writeResult.url,
        key: writeResult.key,
        width: processed.width ?? input.width,
        height: processed.height ?? input.height,
        aspectRatio: processed.aspectRatio ?? deriveAspectRatio(input.width, input.height),
        variants: variants.length > 0 ? variants : [],
        thumbhash: processed.thumbhash ?? input.thumbhash,
        dominantColor: processed.dominantColor ?? input.dominantColor,
        videoMetadata: processed.videoMetadata,
        exif: processed.exif,
        ...(processed.duration !== undefined && { duration: processed.duration }),
        ...(writeResult.metadata && { providerMetadata: writeResult.metadata }),
      },
      options: updateOpts,
    });
    if (!ready) {
      throw new Error(
        `[media-kit] Failed to claim processing → ready for ${mediaId}: ` +
          `record may have been moved out of processing by another worker.`,
      );
    }
    media = ready;

    return media;
  } catch (error) {
    // Step 5: error — multi-source CAS via `MEDIA_MACHINE.validSources('error')`.
    // The reverse-adjacency lookup returns ['pending', 'processing']
    // from the state-machine declaration — one source of truth. If
    // we ever add a state that can also error (e.g. 'reviewing'),
    // updating the machine table propagates to this catch handler
    // for free.
    //
    // Best-effort — wrapped in try/catch to keep the original error
    // rethrowing. `claim` returns null when the row already reached
    // a terminal state via an out-of-band update; we don't clobber
    // it.
    try {
      await assertAndClaim(MEDIA_MACHINE, repo, mediaId, {
        from: MEDIA_MACHINE.validSources('error'),
        to: 'error',
        patch: { errorMessage: (error as Error).message },
        options: updateOpts,
      });
    } catch {
      /* ignore */
    }

    // Cleanup every orphaned storage write from the same provider.
    // `writtenKeys` (fed by processImage's onWrite) covers ALL variant
    // writes — including any processImage already cleaned internally
    // (re-delete is a no-op) — and the main object is rolled back when the
    // error-state doc never came to reference it (a format change
    // regenerated the key after the pending doc was created). When
    // mainWriteKey === pendingDocKey the doc still points at a live object,
    // which purge/hard-delete flows clean up through doc.key later.
    const orphanKeys = [...writtenKeys];
    if (mainWriteKey !== undefined && mainWriteKey !== pendingDocKey) {
      orphanKeys.push(mainWriteKey);
    }
    await deleteKeysBestEffort(driver, orphanKeys, (orphanKey, deleteErr) => {
      repo._log('warn', 'Failed to delete orphaned storage key after upload failure', {
        id: mediaId,
        key: orphanKey,
        error: deleteErr.message,
      });
    });

    throw error;
  }
}
