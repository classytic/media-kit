/**
 * Media Repository — v3
 *
 * The API surface for @classytic/media-kit (PACKAGE_RULES §1).
 * Extends mongokit Repository. Domain verbs live here.
 * Proxy methods removed — callers use inherited mongokit methods directly.
 *
 * Domain verbs:
 *   upload, uploadMany, replace, hardDelete, hardDeleteMany,
 *   move, importFromUrl, addTags, removeTags, setFocalPoint,
 *   purgeDeleted, purgeStalePending, getSignedUploadUrl, confirmUpload,
 *   multipart suite,
 *   folder operations, analytics
 */

import type { Model } from 'mongoose';
import { Repository, type PluginType, type PaginationConfig } from '@classytic/mongokit';
import type {
  IMediaDocument,
  UploadInput,
  ConfirmUploadInput,
  OperationContext,
  PresignedUploadResult,
  FolderTree,
  FolderStats,
  FolderNode,
  BreadcrumbItem,
  BulkResult,
  RewriteResult,
  FocalPoint,
  ImportOptions,
  ImageAdapter,
  InitiateMultipartInput,
  MultipartUploadSession,
  CompleteMultipartInput,
  SignedPartResult,
  BatchPresignInput,
  BatchPresignResult,
  MediaKitLogger,
  GeneratedVariant,
  MediaVisibility,
  RegisterExternalInput,
  StorageDriver,
} from '../types.js';
import { createError } from '@classytic/repo-core/errors';
import type { UrlSigner } from '../signing/index.js';
import type { SharpModule, SharpInstanceSource } from '../processing/image.js';
import { resolveVisibility } from '../utils/visibility.js';
import type { EventTransport } from '@classytic/primitives/events';
import { assertAndClaim } from '@classytic/primitives/state-machine';
import { MEDIA_MACHINE } from '../models/media-state-machine.js';
import type { ResolvedMediaConfig, MediaContext } from '../engine/engine-types.js';
import type { MediaBridges } from '../bridges/types.js';
import type { ScanResult } from '../bridges/scan.bridge.js';
import type { SourceRef } from '../bridges/source.bridge.js';
import type { TransformOpOutput } from '../bridges/transform.bridge.js';
import type { OperationDeps } from '../operations/types.js';
import type { DriverRegistry } from '../providers/driver-registry.js';
import { MEDIA_EVENTS } from '../events/event-constants.js';
import { createMediaEvent } from '../events/helpers.js';
import type { ImageProcessor } from '../processing/image.js';
import { Semaphore } from '../utils/semaphore.js';
import { computeFileHash } from '../utils/hash.js';
import { isImage } from '../utils/mime.js';
import { normalizeFolderPath, buildFolderTree } from '../utils/folders.js';
import {
  EXTERNAL_PROVIDER,
  isExternalMedia,
  assertExternalUrl,
  assertExternalOriginAllowed,
  buildExternalKey,
  externalUrlHash,
} from '../utils/external.js';
import { generateAltText, generateAltTextWithOptions } from '../utils/alt-text.js';
import { processImage } from '../operations/process-image.js';
import {
  deleteKeysBestEffort,
  deriveAspectRatio,
  generateKey,
  generateTitle,
  validateFile as validateFileHelper,
  rewriteKey,
  rewriteKeyPrefix,
  executeKeyRewrite,
  getContentType as getContentTypeHelper,
  type RewritableFile,
} from '../operations/helpers.js';

// ── Constants ────────────────────────────────────────────────

/**
 * Default staleness window for `purgeStalePending()`: 24 hours.
 *
 * `upload()` flips pending → processing → ready within a single request; a
 * genuinely in-flight upload never stays `'pending'` this long, so anything
 * older is a crashed/abandoned upload.
 */
export const STALE_PENDING_MAX_AGE_MS = 24 * 60 * 60 * 1000;

// ── Repository Dependencies ──────────────────────────────────

export interface MediaRepositoryDeps {
  events: EventTransport;
  config: ResolvedMediaConfig;
  registry: DriverRegistry;
  processor?: ImageProcessor | ImageAdapter | null;
  processorReady?: Promise<void> | null;
  logger?: MediaKitLogger;
  bridges?: MediaBridges;
  /** Shared HMAC URL signer — constructed by createMedia() from `config.signing`. */
  signing?: UrlSigner;
}

// ── Repository Class ─────────────────────────────────────────

export class MediaRepository extends Repository<IMediaDocument> {
  private readonly events: EventTransport;
  private readonly registry: DriverRegistry;
  private readonly processor: ImageProcessor | ImageAdapter | null;
  private readonly processorReady: Promise<void> | null;
  private readonly mediaConfig: ResolvedMediaConfig;
  private readonly uploadSemaphore: Semaphore;
  private readonly mediaLogger?: MediaKitLogger;
  private readonly signer: UrlSigner | null;
  public readonly bridges: MediaBridges;

  constructor(
    model: Model<IMediaDocument>,
    plugins: PluginType[],
    deps: MediaRepositoryDeps,
    pagination?: PaginationConfig,
  ) {
    super(model, plugins, pagination);
    this.events = deps.events;
    this.registry = deps.registry;
    this.processor = deps.processor ?? null;
    this.processorReady = deps.processorReady ?? null;
    this.mediaConfig = deps.config;
    this.uploadSemaphore = new Semaphore(deps.config.concurrency?.maxConcurrent ?? 5);
    this.mediaLogger = deps.logger;
    this.signer = deps.signing ?? null;
    this.bridges = deps.bridges ?? {};
  }

  // ── Internal: bridge to legacy operation helpers ──────────

  /**
   * Build OperationDeps for delegating to existing operation helpers.
   *
   * `driver` is the DEFAULT driver — operation flows that target a specific
   * provider (upload/replace with `input.provider`, per-doc routing) must go
   * through {@link _opDepsWith} instead, otherwise storage writes silently
   * land in the default provider's backend.
   */
  private get _opDeps(): OperationDeps {
    return this._opDepsWith(this.registry.defaultDriver);
  }

  /**
   * Build OperationDeps bound to a SPECIFIC storage driver — used when the
   * target provider is known up front (upload/replace resolve
   * `input.provider ?? doc.provider ?? default`), so `processImage()` writes
   * the `__original` + size variants to the SAME provider as the main file.
   */
  private _opDepsWith(driver: StorageDriver): OperationDeps {
    // Minimal shim: events emitter that maps new transport → old event emitter shape
    const self = this;
    return {
      config: this.mediaConfig,
      driver,
      registry: this.registry,
      repository: this,
      get processor() {
        return self.processor;
      },
      processorReady: this.processorReady,
      events: {
        emit: async () => {},
        on: () => () => {},
        removeAllListeners: () => {},
        listenerCount: () => 0,
      },
      uploadSemaphore: this.uploadSemaphore,
      logger: this.mediaLogger,
    };
  }

  /**
   * Convert a MediaContext into the operations-layer OperationContext bag.
   * Interfaces don't carry the implicit index signature the ops context
   * requires, so we spread into a fresh literal (same values, by reference).
   */
  private _opCtx(ctx?: MediaContext): OperationContext | undefined {
    return ctx ? { ...ctx } : undefined;
  }

  private _log(level: 'info' | 'warn' | 'error', message: string, meta?: Record<string, unknown>): void {
    this.mediaLogger?.[level]?.(message, meta);
  }

  /**
   * Build the options bag used to forward tenant + session context to plugin-
   * routed Repository methods (`getAll`, `getByQuery`, `aggregatePipeline`,
   * `update`, etc.).
   *
   * Reads the org id from `ctx.organizationId` (the canonical field on
   * `MediaContext`) and forwards it under the multiTenantPlugin's configured
   * `contextKey` — defaults to `'organizationId'` but hosts may override.
   * Without this indirection, scoping silently breaks when a host configures
   * a non-default `contextKey`.
   */
  private _tenantOpts(ctx?: MediaContext): Record<string, unknown> {
    const opts: Record<string, unknown> = {};
    if (ctx?.session !== undefined) opts.session = ctx.session;
    const tenant = this.mediaConfig.tenant;
    if (tenant?.enabled && ctx?.organizationId !== undefined) {
      const contextKey = tenant.contextKey ?? 'organizationId';
      opts[contextKey] = ctx.organizationId;
    } else if (ctx?.organizationId !== undefined) {
      // Tenant scoping disabled — still pass for any custom plugin that reads it.
      opts.organizationId = ctx.organizationId;
    }
    return opts;
  }

  // ============================================================
  // DOMAIN VERBS — Upload
  // ============================================================

  /**
   * Upload a single file with status-driven flow.
   * pending → processing → ready | error.
   * Publishes media:asset.uploaded on success.
   */
  async upload(input: UploadInput, ctx?: MediaContext): Promise<IMediaDocument> {
    const { buffer, filename, mimeType } = input;

    // Validate
    validateFileHelper({ config: this.mediaConfig }, buffer, filename, mimeType);

    // Scan (if bridge provided) — reject / quarantine per verdict.
    // 'quarantine' is handled after upload — we allow write but mark status: 'error'.
    let scanQuarantine: ScanResult | null = null;
    if (this.bridges.scan) {
      let scan: ScanResult;
      try {
        scan = await this.bridges.scan.scan(buffer, mimeType, filename, {
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
    const hashAlgorithm = this.mediaConfig.deduplication?.algorithm || 'sha256';
    const hash = computeFileHash(buffer, hashAlgorithm);

    // Deduplication check
    if (this.mediaConfig.deduplication?.enabled) {
      const existing = await this.getByHash(hash, ctx);
      if (existing && this.mediaConfig.deduplication.returnExisting !== false) {
        this._log('info', 'Deduplication hit: returning existing file', { hash, existingId: existing._id });
        return existing;
      }
    }

    // Use semaphore for concurrency control
    let media = await this.uploadSemaphore.run(async () => {
      return this._performUpload({ ...input, hash }, ctx);
    });

    // Apply quarantine verdict from scan bridge (if present)
    if (scanQuarantine) {
      const quarantined = await this.update(
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

    this._log('info', 'Media uploaded', { id: media._id, folder: media.folder, size: media.size });

    await this.events.publish(
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
  async uploadMany(inputs: UploadInput[], ctx?: MediaContext): Promise<IMediaDocument[]> {
    const settled = await Promise.allSettled(inputs.map((input) => this.upload(input, ctx)));
    const successes: IMediaDocument[] = [];
    for (const result of settled) {
      if (result.status === 'fulfilled') successes.push(result.value);
    }
    return successes;
  }

  /**
   * Replace file content while preserving the document ID.
   */
  async replace(id: string, input: UploadInput, ctx?: MediaContext): Promise<IMediaDocument> {
    const existing = await this.getById(id, { ...ctx });
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
    validateFileHelper({ config: this.mediaConfig }, buffer, filename, mimeType);

    const hashAlgorithm = this.mediaConfig.deduplication?.algorithm || 'sha256';
    const hash = computeFileHash(buffer, hashAlgorithm);
    const targetFolder = normalizeFolderPath(input.folder || existing.folder || 'general');

    // Resolve provider key BEFORE processing: explicit input > existing doc >
    // default. processImage writes the `__original` + size variants through
    // its deps driver — binding it here keeps variants in the SAME provider
    // as the main file (a default-driver deps bag would scatter them).
    const providerKey = input.provider ?? existing.provider ?? this.registry.defaultName;
    const driver = this.registry.resolve(providerKey);

    // Every key written during this replace, in write order — fed FIRST by
    // processImage's onWrite collector (`__original` + size variants as they
    // land, INCLUDING keys processImage itself cleans up when it fails
    // internally and falls back), then by the main write below. processImage
    // owns cleanup of its own failure window; this list covers the
    // post-return window (main write / DB update failure). Rollback deletes
    // are best-effort, so re-deleting an already-cleaned key is a no-op.
    const newlyWrittenKeys: string[] = [];

    // Process image (variants written via the resolved driver)
    const processed = await processImage(this._opDepsWith(driver), {
      buffer,
      filename,
      mimeType,
      skipProcessing: input.skipProcessing,
      contentType: input.contentType,
      focalPoint: input.focalPoint,
      targetFolder,
      context: this._opCtx(ctx),
      quality: input.quality,
      format: input.format,
      maxWidth: input.maxWidth,
      maxHeight: input.maxHeight,
      onWrite: (key) => {
        newlyWrittenKeys.push(key);
      },
    });

    const newKey = generateKey(processed.finalFilename, targetFolder);

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

      updated = await this.update(
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
    const oldDriver = this.registry.resolve(existing.provider ?? this.registry.defaultName);
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

    await this.events.publish(
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
  // DOMAIN VERBS — Delete
  // ============================================================

  /**
   * Hard-delete: removes file from storage AND database.
   * Use repo.delete(id) for soft delete (when softDeletePlugin is wired).
   */
  async hardDelete(id: string, ctx?: MediaContext): Promise<boolean> {
    let media: IMediaDocument | null;
    try {
      media = await this.getById(id, { ...ctx, includeDeleted: true, throwOnNotFound: false });
    } catch {
      return false;
    }
    if (!media) return false;

    const variantKeys = (media.variants || []).map((v) => v.key);

    // External (reference-only) records own no bytes — the sentinel key is
    // not a storage location and `'external'` is not a registered driver, so
    // the delete is DB-only. This also keeps every purge sweep
    // (purgeDeleted / purgeExpired / purgeStalePending / deleteFolder →
    // hardDeleteMany) storage-safe for external records.
    if (!isExternalMedia(media)) {
      // Resolve the driver that stored this file (fall back to default for pre-multi-provider docs)
      const driver = this.registry.resolve(media.provider ?? this.registry.defaultName);

      // Delete from storage (best-effort)
      try {
        await driver.delete(media.key);
      } catch (err) {
        this._log('warn', 'Failed to delete main file from storage', {
          id,
          key: media.key,
          error: (err as Error).message,
        });
      }
      for (const variant of media.variants || []) {
        try {
          await driver.delete(variant.key);
        } catch {
          /* ignore */
        }
      }
    }

    // Hard delete from DB (bypass softDeletePlugin) — idempotent on race:
    // parallel calls will both see the doc before either wins the delete,
    // so we treat a "not found" error as success (someone else deleted it).
    try {
      await this.delete(id, { ...ctx, mode: 'hard' });
    } catch (err) {
      if (!/not found/i.test((err as Error).message)) throw err;
    }

    this._log('info', 'Media hard-deleted', { id });

    await this.events.publish(
      createMediaEvent(
        MEDIA_EVENTS.ASSET_DELETED,
        {
          assetId: id,
          key: media.key,
          variantKeys,
        },
        ctx,
        { resource: 'media', resourceId: id },
      ),
    );

    return true;
  }

  /**
   * Hard-delete multiple files with semaphore-bounded concurrency.
   */
  async hardDeleteMany(ids: string[], ctx?: MediaContext): Promise<BulkResult> {
    const result: BulkResult = { success: [], failed: [] };

    await Promise.allSettled(
      ids.map((id) =>
        this.uploadSemaphore.run(async () => {
          try {
            const deleted = await this.hardDelete(id, ctx);
            if (deleted) result.success.push(id);
            else result.failed.push({ id, reason: 'Not found' });
          } catch (err) {
            result.failed.push({ id, reason: (err as Error).message });
          }
        }),
      ),
    );

    await this.events.publish(
      createMediaEvent(
        MEDIA_EVENTS.BATCH_DELETED,
        {
          deletedIds: result.success,
          failedIds: result.failed.map((f) => f.id),
        },
        ctx,
      ),
    );

    return result;
  }

  /**
   * Purge soft-deleted files older than a given date.
   * Hard-deletes from both storage and database.
   */
  async purgeDeleted(olderThan?: Date, ctx?: MediaContext): Promise<number> {
    const cutoff = olderThan || new Date(Date.now() - (this.mediaConfig.softDelete?.ttlDays ?? 30) * 86400000);
    // Plugin-routed read with `includeDeleted: true` so softDeletePlugin
    // returns soft-deleted rows (the whole point of the purge); multiTenant
    // still scopes by configured field. We pass the deletedAt filter
    // explicitly because we want only docs older than the cutoff.
    const found = await this.getAll({ filters: { deletedAt: { $ne: null, $lt: cutoff } } }, {
      lean: true,
      includeDeleted: true,
      ...this._tenantOpts(ctx),
    } as Record<string, unknown>);
    const docs = (Array.isArray(found) ? found : (found as { data: unknown[] }).data) as Array<{ _id: unknown }>;

    let purged = 0;
    for (const doc of docs) {
      try {
        await this.hardDelete(String(doc._id), ctx);
        purged++;
      } catch {
        this._log('warn', 'Failed to purge soft-deleted file', { id: String(doc._id) });
      }
    }

    if (purged > 0) {
      await this.events.publish(
        createMediaEvent(
          MEDIA_EVENTS.ASSET_PURGED,
          {
            count: purged,
            olderThan: cutoff,
          },
          ctx,
        ),
      );
    }

    return purged;
  }

  /**
   * Purge stale `status: 'pending'` rows left behind by crashed or abandoned
   * uploads.
   *
   * `upload()` creates the DB row as `'pending'` BEFORE writing to storage and
   * flips it to `'ready'` at the end — a process crash anywhere in between
   * strands the row (and possibly a storage object) forever. This sweep
   * hard-deletes (storage + DB) every pending row created before the cutoff.
   *
   * - **What counts as stale:** `status: 'pending'` AND `createdAt` older than
   *   `olderThan` (default: {@link STALE_PENDING_MAX_AGE_MS} = 24h ago — a
   *   genuinely in-flight upload never lives that long).
   * - **Cron-safe and idempotent:** already-purged rows simply don't match;
   *   a missing storage object (crash before the write) is tolerated — the
   *   DB row is still removed (`hardDelete()` treats storage deletion as
   *   best-effort and drivers treat missing keys as already-deleted).
   * - Emits `media:asset.purged` with `reason: 'stale_pending'` when anything
   *   was purged.
   *
   * Note: abandoned PRESIGNED uploads are the opposite shape — an unconfirmed
   * storage object with NO DB row (`confirmUpload()` creates the row). Those
   * are invisible to this sweep by design; use a bucket lifecycle rule on the
   * upload prefix instead.
   */
  async purgeStalePending(olderThan?: Date, ctx?: MediaContext): Promise<number> {
    const cutoff = olderThan ?? new Date(Date.now() - STALE_PENDING_MAX_AGE_MS);
    // Plugin-routed read — multiTenant scopes by configured field. Pending
    // rows are never soft-deleted (delete flows flip status or remove the
    // row), so no `includeDeleted` needed here.
    const found = await this.getAll({ filters: { status: 'pending', createdAt: { $lt: cutoff } } }, {
      lean: true,
      ...this._tenantOpts(ctx),
    } as Record<string, unknown>);
    const docs = (Array.isArray(found) ? found : (found as { data: unknown[] }).data) as Array<{ _id: unknown }>;

    let purged = 0;
    for (const doc of docs) {
      try {
        await this.hardDelete(String(doc._id), ctx);
        purged++;
      } catch {
        this._log('warn', 'Failed to purge stale pending upload', { id: String(doc._id) });
      }
    }

    if (purged > 0) {
      await this.events.publish(
        createMediaEvent(
          MEDIA_EVENTS.ASSET_PURGED,
          {
            count: purged,
            olderThan: cutoff,
            reason: 'stale_pending',
          },
          ctx,
        ),
      );
    }

    return purged;
  }

  /**
   * Purge all assets whose `expiresAt` is in the past (or before `before`).
   *
   * Queries in batches of 100 to avoid loading the entire collection. Re-queries
   * from the start each batch since hardDelete() shrinks the result set.
   * Fires `media:assets.expired` with purge summary after completion.
   *
   * Safe to call from a cron job — idempotent if some docs were already removed.
   * Does NOT touch soft-deleted files (status is not a filter here; purge is
   * unconditional once expiresAt passes).
   */
  async purgeExpired(before?: Date, ctx?: MediaContext): Promise<BulkResult> {
    const cutoff = before ?? new Date();
    const result: BulkResult = { success: [], failed: [] };
    const BATCH = 100;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const found = await this.getAll(
        { filters: { expiresAt: { $ne: null, $lte: cutoff } }, pagination: { limit: BATCH, page: 1 } },
        { lean: true, includeDeleted: true, ...this._tenantOpts(ctx) } as Record<string, unknown>,
      );
      const docs = (Array.isArray(found) ? found : (found as { data: unknown[] }).data) as Array<{ _id: unknown }>;
      if (docs.length === 0) break;

      for (const doc of docs) {
        const id = String(doc._id);
        try {
          await this.hardDelete(id, ctx);
          result.success.push(id);
        } catch (err) {
          result.failed.push({ id, reason: (err as Error).message });
          this._log('warn', 'Failed to purge expired asset', { id, error: (err as Error).message });
        }
      }
    }

    await this.events.publish(
      createMediaEvent(
        MEDIA_EVENTS.ASSETS_EXPIRED,
        {
          purgedIds: result.success,
          failedIds: result.failed.map((f) => f.id),
          before: cutoff,
          purgedCount: result.success.length,
          failedCount: result.failed.length,
        },
        ctx,
      ),
    );

    return result;
  }

  /**
   * Return assets that will expire within `withinHours` from now.
   * Useful for sending pre-expiry notifications before purgeExpired() runs.
   */
  async getExpiringSoon(withinHours: number, ctx?: MediaContext): Promise<IMediaDocument[]> {
    const now = new Date();
    const horizon = new Date(now.getTime() + withinHours * 3600000);
    const found = await this.getAll({ filters: { expiresAt: { $gt: now, $lte: horizon } } }, {
      lean: true,
      ...this._tenantOpts(ctx),
    } as Record<string, unknown>);
    return (Array.isArray(found) ? found : (found as { data: unknown[] }).data) as IMediaDocument[];
  }

  // ============================================================
  // DOMAIN VERBS — Move & Import
  // ============================================================

  /**
   * Move files to a different folder. Supports key rewriting.
   */
  async move(ids: string[], targetFolder: string, ctx?: MediaContext): Promise<RewriteResult> {
    const normalizedTarget = normalizeFolderPath(targetFolder);
    const rewriteKeys = this.mediaConfig.folders?.rewriteKeys !== false;

    if (!rewriteKeys) {
      // Metadata-only move — plugin-routed so multiTenant + softDelete scope.
      const result = await this.updateMany(
        { _id: { $in: ids } },
        { $set: { folder: normalizedTarget } },
        this._tenantOpts(ctx) as Parameters<MediaRepository['updateMany']>[2],
      );
      const modifiedCount = result.modifiedCount ?? 0;
      await this.events.publish(
        createMediaEvent(
          MEDIA_EVENTS.ASSET_MOVED,
          {
            assetIds: ids,
            fromFolder: '',
            toFolder: normalizedTarget,
            modifiedCount,
          },
          ctx,
        ),
      );
      return { modifiedCount, failed: [] };
    }

    // Full key rewrite — load via plugin-routed read so cross-tenant ids
    // can't leak into the rewrite plan.
    const found = await this.getAll({ filters: { _id: { $in: ids } } }, {
      lean: true,
      ...this._tenantOpts(ctx),
    } as Record<string, unknown>);
    const files = (Array.isArray(found) ? found : (found as { data: unknown[] }).data) as unknown as RewritableFile[];
    const result = await executeKeyRewrite(
      this._opDeps,
      files,
      (file) => ({ newKey: rewriteKey(file.key, normalizedTarget), newFolder: normalizedTarget }),
      (variantKey) => rewriteKey(variantKey, normalizedTarget),
      'progress:move',
      this._opCtx(ctx),
    );

    await this.events.publish(
      createMediaEvent(
        MEDIA_EVENTS.ASSET_MOVED,
        {
          assetIds: ids,
          fromFolder: '',
          toFolder: normalizedTarget,
          modifiedCount: result.modifiedCount,
        },
        ctx,
      ),
    );

    return result;
  }

  /**
   * Import a file from a URL.
   */
  async importFromUrl(url: string, options?: ImportOptions, ctx?: MediaContext): Promise<IMediaDocument> {
    // Delegate to existing import logic (has SSRF protection)
    const { importFromUrl: importFn } = await import('../operations/url-import.js');
    const result = await importFn(this._opDeps, url, options, this._opCtx(ctx));

    await this.events.publish(
      createMediaEvent(
        MEDIA_EVENTS.ASSET_IMPORTED,
        {
          assetId: String(result._id),
          sourceUrl: url,
          filename: result.filename,
          mimeType: result.mimeType,
          size: result.size,
        },
        ctx,
        { resource: 'media', resourceId: String(result._id) },
      ),
    );

    return result;
  }

  /**
   * Register an EXTERNALLY-HOSTED asset (Cloudflare Images delivery URL, an
   * existing CDN object, a partner's hosted image) as a first-class media
   * record — tenancy, visibility, folders, tags, listing, events — WITHOUT
   * media-kit owning the bytes.
   *
   * - The URL is validated (absolute http(s); optional
   *   `external.allowedOrigins` config allowlist) but NEVER fetched — this is
   *   a reference registry, not an importer. Use `importFromUrl()` to re-host
   *   (it carries the SSRF machinery).
   * - The record stores `provider: 'external'` (the canonical discriminator)
   *   and the sentinel key `__external__/<sha256-hex-16-of-url>` — never a
   *   storage location. `hash` is the full SHA-256 of the URL string, so
   *   `existsByHash()` / dedup answer "is this URL already registered?"
   *   within a tenant. Registering the same URL twice creates two records
   *   (no implicit dedup) unless `deduplication` handles it host-side.
   * - Storage-op verbs are external-aware: `hardDelete()` (and every purge
   *   sweep) is DB-only; folder `move()`/`renameFolder()` never rewrite the
   *   sentinel key; the serve path 302-redirects to the stored URL;
   *   `getContextPayload()`/`applyTransforms()`/`replace()` throw typed
   *   errors (no readable bytes).
   * - Emits `media:asset.externalRegistered`.
   *
   * @throws 400 `media.external.invalid_url` — not an absolute http(s) URL
   * @throws 403 `media.external.origin_not_allowed` — origin outside `external.allowedOrigins`
   */
  async registerExternal(input: RegisterExternalInput, ctx?: MediaContext): Promise<IMediaDocument> {
    const url = assertExternalUrl(input.url);
    assertExternalOriginAllowed(url, this.mediaConfig.external?.allowedOrigins);

    const targetFolder = normalizeFolderPath(input.folder || this.mediaConfig.folders?.defaultFolder || 'general');
    // Same precedence as uploads: explicit > byFolder rule > config default > 'public'.
    const visibility = resolveVisibility(this.mediaConfig.visibility, targetFolder, input.visibility);
    const key = buildExternalKey(input.url);

    // Filename: explicit > last URL path segment > sentinel-derived fallback.
    const pathSegment = decodeURIComponent(url.pathname.split('/').filter(Boolean).pop() ?? '');
    const filename = input.filename || pathSegment || `external-${externalUrlHash(input.url).slice(0, 16)}`;
    const sourceProvider = input.sourceProvider ?? EXTERNAL_PROVIDER;

    const media = await this.create(
      {
        filename,
        originalFilename: filename,
        title: input.title || generateTitle(filename),
        mimeType: input.mimeType ?? 'application/octet-stream',
        size: input.size ?? 0,
        url: input.url,
        key,
        hash: externalUrlHash(input.url),
        provider: EXTERNAL_PROVIDER,
        status: 'ready',
        visibility,
        tokenVersion: 0,
        folder: targetFolder,
        tags: input.tags ?? [],
        variants: [],
        metadata: input.metadata ?? {},
        providerMetadata: { sourceProvider },
        width: input.width,
        height: input.height,
        aspectRatio: deriveAspectRatio(input.width, input.height),
        ...(input.alt !== undefined && { alt: input.alt }),
        ...(input.thumbhash !== undefined && { thumbhash: input.thumbhash }),
        ...(input.dominantColor !== undefined && { dominantColor: input.dominantColor }),
      },
      { session: ctx?.session, organizationId: ctx?.organizationId },
    );

    this._log('info', 'External media registered', { id: media._id, url: input.url, sourceProvider });

    await this.events.publish(
      createMediaEvent(
        MEDIA_EVENTS.ASSET_EXTERNAL_REGISTERED,
        {
          assetId: String(media._id),
          url: input.url,
          sourceProvider,
          filename: media.filename,
          mimeType: media.mimeType,
          size: media.size,
          folder: media.folder,
          key: media.key,
        },
        ctx,
        { resource: 'media', resourceId: String(media._id) },
      ),
    );

    return media;
  }

  // ============================================================
  // DOMAIN VERBS — Tags & Focal Point
  // ============================================================

  async addTags(id: string, tags: string[], ctx?: MediaContext): Promise<IMediaDocument> {
    // Route through `this.findOneAndUpdate` (the repo method) — NOT
    // `this.Model.findOneAndUpdate` (the raw mongoose call). The repo
    // method threads the `before:findOneAndUpdate` plugin pipeline so
    // multi-tenant scope, soft-delete filter, audit, and cache
    // invalidation all fire. The raw mongoose call bypasses every
    // plugin — a silent cross-tenant write surface.
    const result = await this.findOneAndUpdate({ _id: id }, { $addToSet: { tags: { $each: tags } } }, {
      returnDocument: 'after',
      ...(ctx?.organizationId !== undefined && { organizationId: ctx.organizationId }),
      ...(ctx?.session !== undefined && { session: ctx.session }),
    } as Record<string, unknown>);
    if (!result) throw new Error(`Media ${id} not found`);

    await this.events.publish(
      createMediaEvent(
        MEDIA_EVENTS.ASSET_TAGGED,
        {
          assetId: id,
          tags,
        },
        ctx,
        { resource: 'media', resourceId: id },
      ),
    );

    return result;
  }

  async removeTags(id: string, tags: string[], ctx?: MediaContext): Promise<IMediaDocument> {
    const result = await this.findOneAndUpdate({ _id: id }, { $pull: { tags: { $in: tags } } }, {
      returnDocument: 'after',
      ...(ctx?.organizationId !== undefined && { organizationId: ctx.organizationId }),
      ...(ctx?.session !== undefined && { session: ctx.session }),
    } as Record<string, unknown>);
    if (!result) throw new Error(`Media ${id} not found`);

    await this.events.publish(
      createMediaEvent(
        MEDIA_EVENTS.ASSET_UNTAGGED,
        {
          assetId: id,
          tags,
        },
        ctx,
        { resource: 'media', resourceId: id },
      ),
    );

    return result;
  }

  async setFocalPoint(id: string, focalPoint: FocalPoint, ctx?: MediaContext): Promise<IMediaDocument> {
    if (focalPoint.x < 0 || focalPoint.x > 1 || focalPoint.y < 0 || focalPoint.y > 1) {
      throw new Error('Focal point coordinates must be between 0 and 1');
    }
    const result = await this.findOneAndUpdate({ _id: id }, { $set: { focalPoint } }, {
      returnDocument: 'after',
      ...(ctx?.organizationId !== undefined && { organizationId: ctx.organizationId }),
      ...(ctx?.session !== undefined && { session: ctx.session }),
    } as Record<string, unknown>);
    if (!result) throw new Error(`Media ${id} not found`);

    await this.events.publish(
      createMediaEvent(
        MEDIA_EVENTS.FOCAL_POINT_SET,
        {
          assetId: id,
          focalPoint,
        },
        ctx,
        { resource: 'media', resourceId: id },
      ),
    );

    return result;
  }

  // ============================================================
  // DOMAIN VERBS — Presigned Uploads
  // ============================================================

  async getSignedUploadUrl(
    filename: string,
    contentType: string,
    options: { folder?: string; expiresIn?: number; size?: number } = {},
    ctx?: MediaContext,
  ): Promise<PresignedUploadResult> {
    const { getSignedUploadUrl: fn } = await import('../operations/presigned.js');
    return fn(this._opDeps, filename, contentType, options, this._opCtx(ctx));
  }

  async confirmUpload(input: ConfirmUploadInput, ctx?: MediaContext): Promise<IMediaDocument> {
    const { confirmUpload: fn } = await import('../operations/presigned.js');
    const result = await fn(this._opDeps, input, this._opCtx(ctx));

    await this.events.publish(
      createMediaEvent(
        MEDIA_EVENTS.UPLOAD_CONFIRMED,
        {
          assetId: String(result._id),
          key: result.key,
          filename: result.filename,
          mimeType: result.mimeType,
          size: result.size,
        },
        ctx,
        { resource: 'media', resourceId: String(result._id) },
      ),
    );

    return result;
  }

  async initiateMultipartUpload(input: InitiateMultipartInput, ctx?: MediaContext): Promise<MultipartUploadSession> {
    const { initiateMultipartUpload: fn } = await import('../operations/presigned.js');
    return fn(this._opDeps, input, this._opCtx(ctx));
  }

  async signUploadPart(
    key: string,
    uploadId: string,
    partNumber: number,
    expiresIn?: number,
  ): Promise<SignedPartResult> {
    const { signUploadPart: fn } = await import('../operations/presigned.js');
    return fn(this._opDeps, key, uploadId, partNumber, expiresIn);
  }

  async signUploadParts(
    key: string,
    uploadId: string,
    partNumbers: number[],
    expiresIn?: number,
  ): Promise<SignedPartResult[]> {
    const { signUploadParts: fn } = await import('../operations/presigned.js');
    return fn(this._opDeps, key, uploadId, partNumbers, expiresIn);
  }

  async completeMultipartUpload(input: CompleteMultipartInput, ctx?: MediaContext): Promise<IMediaDocument> {
    const { completeMultipartUpload: fn } = await import('../operations/presigned.js');
    const result = await fn(this._opDeps, input, this._opCtx(ctx));

    await this.events.publish(
      createMediaEvent(
        MEDIA_EVENTS.MULTIPART_COMPLETED,
        {
          assetId: String(result._id),
          key: result.key,
          filename: result.filename,
          size: result.size,
        },
        ctx,
        { resource: 'media', resourceId: String(result._id) },
      ),
    );

    return result;
  }

  async abortMultipartUpload(key: string, uploadId: string): Promise<void> {
    const { abortMultipartUpload: fn } = await import('../operations/presigned.js');
    return fn(this._opDeps, key, uploadId);
  }

  async generateBatchPutUrls(input: BatchPresignInput, ctx?: MediaContext): Promise<BatchPresignResult> {
    const { generateBatchPutUrls: fn } = await import('../operations/presigned.js');
    return fn(this._opDeps, input, this._opCtx(ctx));
  }

  // ============================================================
  // DOMAIN VERBS — Folder Operations
  // ============================================================

  async getFolderTree(ctx?: MediaContext): Promise<FolderTree> {
    // Route through `aggregatePipeline` so multiTenantPlugin + softDeletePlugin
    // inject their `$match` predicates as the leading stage. Raw
    // `Model.aggregate()` would bypass them — and would scope on the wrong
    // field name when `tenant.tenantField` differs from 'organizationId'.
    const folders = (await this.aggregatePipeline(
      [
        {
          $group: { _id: '$folder', count: { $sum: 1 }, size: { $sum: '$size' }, latestUpload: { $max: '$createdAt' } },
        },
      ],
      this._tenantOpts(ctx),
    )) as Array<{ _id: string; count: number; size: number; latestUpload: Date }>;

    const tree = buildFolderTree(
      folders.map((f) => ({
        folder: f._id,
        count: f.count,
        totalSize: f.size,
        latestUpload: f.latestUpload,
      })),
    );
    return tree;
  }

  async getFolderStats(folder: string, ctx?: MediaContext): Promise<FolderStats> {
    const folderRegex = `^${folder.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`;

    // Plugin-routed pipeline — tenant + soft-delete predicates auto-injected.
    const [stats] = (await this.aggregatePipeline(
      [
        { $match: { folder: { $regex: folderRegex } } },
        {
          $group: {
            _id: null,
            totalFiles: { $sum: 1 },
            totalSize: { $sum: '$size' },
            avgSize: { $avg: '$size' },
            mimeTypes: { $addToSet: '$mimeType' },
            oldestFile: { $min: '$createdAt' },
            newestFile: { $max: '$createdAt' },
          },
        },
      ],
      this._tenantOpts(ctx),
    )) as Array<FolderStats>;

    return stats || { totalFiles: 0, totalSize: 0, avgSize: 0, mimeTypes: [], oldestFile: null, newestFile: null };
  }

  getBreadcrumb(folder: string): BreadcrumbItem[] {
    const parts = folder.split('/').filter(Boolean);
    return parts.map((name, index) => ({
      name,
      path: parts.slice(0, index + 1).join('/'),
    }));
  }

  async deleteFolder(folder: string, ctx?: MediaContext): Promise<BulkResult> {
    // Plugin-routed read — multiTenantPlugin scopes by configured tenant
    // field; softDeletePlugin filters out already-deleted rows.
    const found = await this.getAll(
      { filters: { folder: { $regex: `^${folder.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}` } } },
      { lean: true, select: '_id', ...this._tenantOpts(ctx) } as Record<string, unknown>,
    );
    const files = (Array.isArray(found) ? found : (found as { data: unknown[] }).data) as Array<{ _id: unknown }>;

    const ids = files.map((f) => String(f._id));
    const result = await this.hardDeleteMany(ids, ctx);

    await this.events.publish(
      createMediaEvent(
        MEDIA_EVENTS.FOLDER_DELETED,
        {
          folder,
          deletedCount: result.success.length,
        },
        ctx,
      ),
    );

    return result;
  }

  async renameFolder(oldPath: string, newPath: string, ctx?: MediaContext): Promise<RewriteResult> {
    const normalizedOld = normalizeFolderPath(oldPath);
    const normalizedNew = normalizeFolderPath(newPath);
    const rewriteKeys = this.mediaConfig.folders?.rewriteKeys !== false;
    const folderRegex = `^${normalizedOld.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`;

    // Plugin-routed read — multiTenant + softDelete predicates auto-applied.
    const found = await this.getAll({ filters: { folder: { $regex: folderRegex } } }, {
      lean: true,
      ...this._tenantOpts(ctx),
    } as Record<string, unknown>);
    const files = (Array.isArray(found) ? found : (found as { data: unknown[] }).data) as unknown as RewritableFile[];

    if (!rewriteKeys) {
      // Metadata-only rename. updateMany only accepts an operator-shaped update,
      // not a pipeline expression — apply the prefix swap per-doc via the IDs we
      // already loaded above (they were tenant-scoped on the read).
      const updates = files
        .filter((f) => f.folder.startsWith(normalizedOld))
        .map((f) => ({
          id: f._id.toString(),
          data: { folder: normalizedNew + f.folder.slice(normalizedOld.length) },
        }));
      const { modifiedCount } = await this.bulkUpdateMedia(updates, this._tenantOpts(ctx));
      await this.events.publish(
        createMediaEvent(
          MEDIA_EVENTS.FOLDER_RENAMED,
          {
            oldPath: normalizedOld,
            newPath: normalizedNew,
            modifiedCount,
          },
          ctx,
        ),
      );
      return { modifiedCount, failed: [] };
    }

    // Full key rewrite
    const result = await executeKeyRewrite(
      this._opDeps,
      files,
      (file) => {
        const newFolder = file.folder.replace(normalizedOld, normalizedNew);
        return { newKey: rewriteKeyPrefix(file.key, normalizedOld, normalizedNew), newFolder };
      },
      (variantKey) => rewriteKeyPrefix(variantKey, normalizedOld, normalizedNew),
      'progress:rename',
      this._opCtx(ctx),
    );

    await this.events.publish(
      createMediaEvent(
        MEDIA_EVENTS.FOLDER_RENAMED,
        {
          oldPath: normalizedOld,
          newPath: normalizedNew,
          modifiedCount: result.modifiedCount,
        },
        ctx,
      ),
    );

    return result;
  }

  async getSubfolders(parentPath: string, ctx?: MediaContext): Promise<FolderNode[]> {
    const normalized = normalizeFolderPath(parentPath);
    const escapedPath = normalized.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const depth = normalized.split('/').filter(Boolean).length;

    // Plugin-routed pipeline — tenant + soft-delete predicates auto-injected.
    const results = (await this.aggregatePipeline(
      [
        { $match: { folder: { $regex: `^${escapedPath}/` } } },
        {
          $addFields: {
            folderParts: { $split: ['$folder', '/'] },
          },
        },
        {
          $addFields: {
            subfolder: {
              $reduce: {
                input: { $slice: ['$folderParts', 0, depth + 1] },
                initialValue: '',
                in: { $cond: [{ $eq: ['$$value', ''] }, '$$this', { $concat: ['$$value', '/', '$$this'] }] },
              },
            },
          },
        },
        {
          $group: {
            _id: '$subfolder',
            count: { $sum: 1 },
            size: { $sum: '$size' },
            latestUpload: { $max: '$createdAt' },
          },
        },
        { $sort: { _id: 1 } },
      ],
      this._tenantOpts(ctx),
    )) as Array<{ _id: string; count: number; size: number; latestUpload: Date }>;

    return results.map((r) => ({
      id: r._id,
      name: r._id.split('/').pop() || r._id,
      path: r._id,
      stats: { count: r.count, size: r.size },
      children: [],
      latestUpload: r.latestUpload,
    }));
  }

  // ============================================================
  // DOMAIN VERBS — Bridges (source resolution, CDN URLs)
  // ============================================================

  /**
   * Resolve a single media doc's polymorphic source via SourceBridge.
   * Returns `null` when no source set, no bridge configured, or bridge returns null.
   */
  async resolveSource(media: IMediaDocument, ctx?: MediaContext): Promise<unknown | null> {
    const m = media as unknown as { sourceId?: string; sourceModel?: string };
    if (!m.sourceId || !m.sourceModel || !this.bridges.source?.resolve) return null;
    return this.bridges.source.resolve(m.sourceId, m.sourceModel, {
      organizationId: ctx?.organizationId ? String(ctx.organizationId) : undefined,
      userId: ctx?.userId ? String(ctx.userId) : undefined,
    });
  }

  /**
   * Batch-resolve polymorphic sources for a list of media docs.
   * Returns a Map<sourceId, sourceDoc> — use to enrich list responses without N+1.
   */
  async resolveSourcesMany(medias: IMediaDocument[], ctx?: MediaContext): Promise<Map<string, unknown>> {
    const resolver = this.bridges.source?.resolveMany;
    if (!resolver) return new Map();
    const refs: SourceRef[] = [];
    for (const m of medias) {
      const mm = m as unknown as { sourceId?: string; sourceModel?: string };
      if (mm.sourceId && mm.sourceModel) {
        refs.push({ sourceId: mm.sourceId, sourceModel: mm.sourceModel });
      }
    }
    if (refs.length === 0) return new Map();
    return resolver(refs, {
      organizationId: ctx?.organizationId ? String(ctx.organizationId) : undefined,
      userId: ctx?.userId ? String(ctx.userId) : undefined,
    });
  }

  /**
   * Get the CDN-transformed URL for a media key. Falls back to driver.getPublicUrl
   * when no CdnBridge is configured.
   */
  async getAssetUrl(media: IMediaDocument, options?: { signed?: boolean; expiresIn?: number }): Promise<string> {
    const defaultUrl =
      media.url || this.registry.resolve(media.provider ?? this.registry.defaultName).getPublicUrl(media.key);
    if (!this.bridges.cdn) return defaultUrl;
    return this.bridges.cdn.transform(media.key, defaultUrl, options);
  }

  /**
   * Get CDN-transformed URLs for all variants of a media doc.
   * Returns an array of `{ name, url }` — variants pass through their own URL
   * when no CdnBridge is configured.
   */
  async getVariantUrls(
    media: IMediaDocument,
    options?: { signed?: boolean; expiresIn?: number },
  ): Promise<Array<{ name: string; url: string }>> {
    const variants = media.variants ?? [];
    if (!this.bridges.cdn) return variants.map((v) => ({ name: v.name, url: v.url }));
    const results: Array<{ name: string; url: string }> = [];
    for (const v of variants) {
      const url = await this.bridges.cdn.transform(v.key, v.url, options);
      results.push({ name: v.name, url });
    }
    return results;
  }

  // ============================================================
  // DOMAIN VERBS — Private media (signing, revocation, LLM context)
  // ============================================================

  /** Resolve an id-or-document argument to a document (plugin-routed read for ids). */
  private async _resolveDoc(idOrDoc: string | IMediaDocument, ctx?: MediaContext): Promise<IMediaDocument> {
    if (typeof idOrDoc !== 'string') return idOrDoc;
    const media = await this.getById(idOrDoc, { ...ctx, throwOnNotFound: false });
    if (!media) throw new Error(`Media ${idOrDoc} not found`);
    return media;
  }

  /** Resolve a Sharp module — shared processor instance first, bare import as fallback. */
  private async _getSharp(): Promise<SharpModule | null> {
    try {
      if (this.processor && 'getSharpInstance' in this.processor) {
        return await (this.processor as ImageAdapter & SharpInstanceSource).getSharpInstance();
      }
      return (await import('sharp')).default;
    } catch {
      return null;
    }
  }

  /**
   * Mint a signed serve URL for an asset: `${servePath}/${id}[/variant]?e=...&kid=...&v=...&sig=...`.
   *
   * Requires engine `signing` config (`{ keys|secret, servePath, ... }`) —
   * throws a typed 500 `HttpError` (`code: 'media.signing.not_configured'`)
   * otherwise. The signature covers id, variant, expiry, kid, tokenVersion,
   * and every claim; `revokeAccess()` invalidates all outstanding URLs.
   *
   * When a CdnBridge is configured the minted URL is passed through
   * `bridges.cdn.transform(key, url, { signed: true, ... })` — the bridge
   * wins, so hosts can offload to CloudFront/edge signing instead.
   *
   * LLM note: URLs handed to LLM providers are re-fetched anonymously on
   * every chat-history replay — mint them with an `expiresIn` that covers the
   * conversation's lifetime, and do NOT re-sign the same asset per message
   * (a changing URL breaks Anthropic prompt caching). For indefinite access
   * prefer `getContextPayload()` (base64) or provider file ids.
   */
  async getSignedAssetUrl(
    idOrDoc: string | IMediaDocument,
    options: { variant?: string; expiresIn?: number; claims?: Record<string, string> } = {},
    ctx?: MediaContext,
  ): Promise<string> {
    const signingConfig = this.mediaConfig.signing;
    if (!this.signer || !signingConfig?.servePath) {
      const err = createError(
        500,
        '[media-kit] getSignedAssetUrl requires the engine `signing` config ({ keys | secret, servePath })',
      );
      err.code = 'media.signing.not_configured';
      throw err;
    }

    const media = await this._resolveDoc(idOrDoc, ctx);
    if (options.variant && !(media.variants ?? []).some((v) => v.name === options.variant)) {
      throw new Error(`[media-kit] Variant '${options.variant}' not found on media ${String(media._id)}`);
    }

    const id = String(media._id);
    const { query } = this.signer.sign({
      id,
      variant: options.variant,
      expiresIn: options.expiresIn,
      claims: options.claims,
      tokenVersion: media.tokenVersion ?? 0,
    });

    const servePath = signingConfig.servePath.replace(/\/+$/, '');
    const url = `${servePath}/${id}${options.variant ? `/${encodeURIComponent(options.variant)}` : ''}?${query}`;

    // Bridge wins — lets hosts route signed serving through CloudFront etc.
    if (this.bridges.cdn) {
      return this.bridges.cdn.transform(media.key, url, {
        signed: true,
        ...(options.expiresIn !== undefined && { expiresIn: options.expiresIn }),
        ...(ctx?.organizationId !== undefined && { organizationId: String(ctx.organizationId) }),
      });
    }
    return url;
  }

  /**
   * Revoke every outstanding signed URL for an asset by bumping its
   * `tokenVersion` (`$inc`). Signed URLs embed the version they were minted
   * with; verification compares it to the doc's current value, so old URLs
   * fail with `version_mismatch` immediately. Routed through the plugin
   * pipeline (`findOneAndUpdate`) so tenant scoping and cache invalidation
   * fire like any other update.
   */
  async revokeAccess(idOrDoc: string | IMediaDocument, ctx?: MediaContext): Promise<IMediaDocument> {
    const id = typeof idOrDoc === 'string' ? idOrDoc : String(idOrDoc._id);
    const result = await this.findOneAndUpdate({ _id: id }, { $inc: { tokenVersion: 1 } }, {
      returnDocument: 'after',
      ...(ctx?.organizationId !== undefined && { organizationId: ctx.organizationId }),
      ...(ctx?.session !== undefined && { session: ctx.session }),
    } as Record<string, unknown>);
    if (!result) throw new Error(`Media ${id} not found`);

    this._log('info', 'Media access revoked (tokenVersion bumped)', { id, tokenVersion: result.tokenVersion });
    return result;
  }

  /**
   * Load an asset's bytes for LLM context (works regardless of visibility —
   * this is a server-side read, the caller IS the trust boundary).
   *
   * - Streams from the driver with a hard cap (`maxBytes`, default 25MB) —
   *   exceeding it throws a 413 `HttpError` (`code: 'media.context.too_large'`).
   * - Images larger than `maxDimension` (default 1568px — Anthropic's token
   *   sweet spot; hard limits are 10MB / 8000px per image) are downscaled
   *   (fit inside, no enlargement) when sharp is available.
   * - Output is byte-stable for unchanged inputs — replaying the same base64
   *   in chat history is prompt-cache-friendly, unlike re-signed URLs.
   * - Bedrock/Vertex only accept base64 images — this is the portable path.
   *
   * @returns `{ data, contentType, bytes }` where `data` is a base64 string
   * (default), a `data:` URL, or a raw Buffer depending on `options.as`.
   */
  async getContextPayload(
    idOrDoc: string | IMediaDocument,
    options: { as?: 'base64' | 'dataUrl' | 'buffer'; maxDimension?: number; maxBytes?: number } = {},
    ctx?: MediaContext,
  ): Promise<{ data: string | Buffer; contentType: string; bytes: number }> {
    const as = options.as ?? 'base64';
    const maxBytes = options.maxBytes ?? 25 * 1024 * 1024;
    const maxDimension = options.maxDimension ?? 1568;

    const media = await this._resolveDoc(idOrDoc, ctx);

    // External records have no readable bytes in any registered driver.
    // Deliberately NOT fetched server-side: fetching arbitrary stored URLs
    // here would be an SSRF surface. Hosts fetch `media.url` themselves.
    // (Future option: route through url-import's pinned, SSRF-guarded fetch
    // as an explicit opt-in.)
    if (isExternalMedia(media)) {
      const err = createError(
        400,
        `[media-kit] Media ${String(media._id)} is an external reference — no bytes to load. ` +
          `Fetch media.url yourself (or re-host it via importFromUrl()).`,
      );
      err.code = 'media.context.external';
      throw err;
    }

    const driver = this.registry.resolve(media.provider ?? this.registry.defaultName);

    const stream = await driver.read(media.key);
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of stream as AsyncIterable<Buffer | string>) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buf.length;
      if (total > maxBytes) {
        (stream as NodeJS.ReadableStream & { destroy?: (err?: Error) => void }).destroy?.();
        const err = createError(
          413,
          `[media-kit] Media ${String(media._id)} exceeds getContextPayload maxBytes (${maxBytes} bytes)`,
        );
        err.code = 'media.context.too_large';
        throw err;
      }
      chunks.push(buf);
    }
    let buffer: Buffer = Buffer.concat(chunks) as Buffer;
    const contentType = media.mimeType;

    if (maxDimension > 0 && isImage(media.mimeType)) {
      const sharp = await this._getSharp();
      if (sharp) {
        try {
          const meta = await sharp(buffer).metadata();
          const longEdge = Math.max(meta.width ?? 0, meta.height ?? 0);
          if (longEdge > maxDimension) {
            buffer = (await sharp(buffer)
              .resize(maxDimension, maxDimension, { fit: 'inside', withoutEnlargement: true })
              .toBuffer()) as Buffer;
          }
        } catch {
          // Un-decodable "image" — fall through with the original bytes.
        }
      }
    }

    const bytes = buffer.length;
    if (as === 'buffer') return { data: buffer, contentType, bytes };
    const b64 = buffer.toString('base64');
    if (as === 'dataUrl') return { data: `data:${contentType};base64,${b64}`, contentType, bytes };
    return { data: b64, contentType, bytes };
  }

  /**
   * Apply a pipeline of transform ops to an existing asset buffer.
   *
   * Ops are resolved from `bridges.transform.ops` and executed in order.
   * The asset's current buffer is read from storage, piped through each op,
   * and the result returned (NOT persisted). Callers decide what to do —
   * stream to response, cache in CDN, save as a new variant, etc.
   *
   * This is the primitive for building ImageKit-style URL transforms
   * (`GET /transform/:id?op=bg-remove,upscale&scale=4`).
   *
   * @throws if the media is not found, no TransformBridge configured, or any op is unknown
   */
  async applyTransforms(
    mediaId: string,
    options: { ops: string[]; params?: Record<string, string> },
    ctx?: MediaContext,
  ): Promise<TransformOpOutput> {
    const media = await this.getById(mediaId, { ...ctx });
    if (!media) throw new Error(`Media ${mediaId} not found`);

    // External records own no bytes to transform.
    if (isExternalMedia(media)) {
      const err = createError(
        400,
        `[media-kit] applyTransforms() is not supported for external media ${mediaId} — ` +
          `it references a third-party URL and owns no bytes.`,
      );
      err.code = 'media.external.no_bytes';
      throw err;
    }

    const opsRegistry = this.bridges.transform?.ops;
    if (!opsRegistry || Object.keys(opsRegistry).length === 0) {
      throw new Error('[media-kit] No TransformBridge configured — register ops via bridges.transform.ops');
    }

    for (const name of options.ops) {
      if (!opsRegistry[name]) {
        throw new Error(
          `[media-kit] Unknown transform op: '${name}'. Registered: ${Object.keys(opsRegistry).join(', ') || '(none)'}`,
        );
      }
    }

    // Read source buffer from storage (route to the provider that stored this file)
    const stream = await this.registry.resolve(media.provider ?? this.registry.defaultName).read(media.key);
    const chunks: Buffer[] = [];
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    let buffer: Buffer = Buffer.concat(chunks) as Buffer;
    let mimeType = media.mimeType;
    let width: number | undefined = media.width;
    let height: number | undefined = media.height;

    const opCtx = {
      params: options.params ?? {},
      media,
      organizationId: ctx?.organizationId ? String(ctx.organizationId) : undefined,
      userId: ctx?.userId ? String(ctx.userId) : undefined,
    };

    for (const name of options.ops) {
      const op = opsRegistry[name]!;
      const result = await op({ buffer, mimeType }, opCtx);
      buffer = result.buffer;
      mimeType = result.mimeType;
      width = result.width ?? width;
      height = result.height ?? height;
    }

    return { buffer, mimeType, width, height };
  }

  // ============================================================
  // DOMAIN VERBS — Analytics & Lookups
  // ============================================================

  async getByHash(hash: string, ctx?: MediaContext): Promise<IMediaDocument | null> {
    // Plugin-routed read — multiTenantPlugin scopes on the configured
    // tenant field (not always 'organizationId'); softDeletePlugin
    // applies the deleted-at filter.
    return (await this.getByQuery({ hash }, {
      ...this._tenantOpts(ctx),
      throwOnNotFound: false,
    } as Record<string, unknown>)) as IMediaDocument | null;
  }

  /**
   * Pre-upload dedup handshake — "do you already have this file?".
   *
   * The WhatsApp "instant forward" recipe: the client hashes the file FIRST
   * (SHA-256 via `crypto.subtle.digest`), asks the server, and on a hit
   * skips the upload entirely, reusing the returned media's id (the same
   * `returnExisting` semantics `upload()` applies after receiving bytes —
   * this verb just moves the check before the bytes travel).
   *
   * Tenant-scoped through the SAME plugin-routed read as `getByHash()` —
   * NEVER cross-tenant. A globally-scoped answer would be an existence
   * oracle: anyone could probe "has someone, anywhere, uploaded this file?"
   * by hash. The same content uploaded by another tenant therefore reports
   * `exists: false` by design. Hosts MUST require auth on the endpoint that
   * proxies this verb. Full recipe: docs/guides/upload-profiles.mdx.
   *
   * Note: presigned confirms hash with a placeholder by default
   * (`hashStrategy: 'skip'`) — for the handshake to hit, confirm with a
   * real content hash (`hashStrategy: 'sha256'`) or store the client's
   * SHA-256 via server `upload()` with dedup enabled.
   */
  async existsByHash(
    hash: string,
    ctx?: MediaContext,
  ): Promise<{ exists: boolean; media?: IMediaDocument | undefined }> {
    const media = await this.getByHash(hash, ctx);
    if (!media) return { exists: false };
    return { exists: true, media };
  }

  async getStorageByFolder(ctx?: MediaContext): Promise<Array<{ folder: string; totalSize: number; count: number }>> {
    return (await this.aggregatePipeline(
      [
        { $group: { _id: '$folder', totalSize: { $sum: '$size' }, count: { $sum: 1 } } },
        { $project: { folder: '$_id', totalSize: 1, count: 1, _id: 0 } },
        { $sort: { totalSize: -1 } },
      ],
      this._tenantOpts(ctx),
    )) as Array<{ folder: string; totalSize: number; count: number }>;
  }

  async getTotalStorageUsed(ctx?: MediaContext): Promise<number> {
    const [result] = (await this.aggregatePipeline(
      [{ $group: { _id: null, total: { $sum: '$size' } } }],
      this._tenantOpts(ctx),
    )) as Array<{ total: number }>;
    return result?.total ?? 0;
  }

  // ============================================================
  // DOMAIN VERBS — Utilities
  // ============================================================

  validateFile(buffer: Buffer, filename: string, mimeType: string): void {
    validateFileHelper({ config: this.mediaConfig }, buffer, filename, mimeType);
  }

  getContentType(folder: string): string {
    return getContentTypeHelper({ config: this.mediaConfig }, folder);
  }

  // ============================================================
  // INTERNAL — Upload pipeline
  // ============================================================

  /**
   * Internal upload implementation. Status lifecycle: pending → processing → ready | error.
   */
  private async _performUpload(input: UploadInput & { hash: string }, ctx?: MediaContext): Promise<IMediaDocument> {
    const { buffer, filename, mimeType, folder, hash } = input;
    let { alt } = input;

    // Generate alt text
    if (!alt && isImage(mimeType)) {
      const generateAltConfig = this.mediaConfig.processing?.generateAlt;
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

    const targetFolder = normalizeFolderPath(folder || this.mediaConfig.folders?.defaultFolder || 'general');
    const finalTitle = input.title || generateTitle(filename);
    let key = generateKey(filename, targetFolder);

    // Visibility: explicit per-upload > byFolder rule > config default > 'public'.
    const visibility = resolveVisibility(this.mediaConfig.visibility, targetFolder, input.visibility);
    // Per-object ACL hint — honored by S3; other drivers ignore it (GCS
    // privacy is bucket-level IAM; Local/Cloudinary/etc. have no object ACL).
    const writeOptions = visibility === 'private' ? { acl: 'private' as const } : undefined;

    // Resolve which driver handles this upload — store the registry key, not
    // the driver's own `name`, so that lookup always works regardless of whether
    // the driver reuses a generic name (e.g. two MemoryStorageDrivers both have
    // `name = 'memory'` but live under different registry keys).
    const providerKey = input.provider ?? this.registry.defaultName;
    const driver = this.registry.resolve(providerKey);

    // Step 1: Create DB record with status: 'pending'
    let media = await this.create(
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
      const processing = await assertAndClaim(MEDIA_MACHINE, this, mediaId, {
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
      const processed = await processImage(this._opDepsWith(driver), {
        buffer,
        filename,
        mimeType,
        skipProcessing: input.skipProcessing,
        contentType: input.contentType,
        focalPoint: input.focalPoint,
        targetFolder,
        context: this._opCtx(ctx),
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
      const ready = await assertAndClaim(MEDIA_MACHINE, this, mediaId, {
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
        await assertAndClaim(MEDIA_MACHINE, this, mediaId, {
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
        this._log('warn', 'Failed to delete orphaned storage key after upload failure', {
          id: mediaId,
          key: orphanKey,
          error: deleteErr.message,
        });
      });

      throw error;
    }
  }

  // ============================================================
  // INTERNAL — v2 compat bridge methods (used by operation helpers)
  // ============================================================

  /** @internal Used by operation helpers that expect v2 repo API */
  async createMedia(
    data: Record<string, unknown>,
    context?: OperationContext | Record<string, unknown>,
  ): Promise<IMediaDocument> {
    return this.create(data, context as Parameters<MediaRepository['create']>[1]);
  }

  /** @internal */
  async getMediaById(id: string, context?: OperationContext | Record<string, unknown>): Promise<IMediaDocument | null> {
    return this.getById(id, { ...(context || {}), throwOnNotFound: false });
  }

  /** @internal */
  async updateMedia(
    id: string,
    data: Record<string, unknown>,
    context?: OperationContext | Record<string, unknown>,
  ): Promise<IMediaDocument> {
    const updated = await this.update(id, data, context as Parameters<MediaRepository['update']>[2]);
    if (!updated) throw new Error(`[media-kit] Media not found: ${id}`);
    return updated;
  }

  /** @internal */
  async deleteMedia(id: string, context?: OperationContext | Record<string, unknown>): Promise<boolean> {
    try {
      await this.delete(id, { ...(context || {}), mode: 'hard' });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * @internal Unscoped key-existence probe used by confirmUpload's ownership
   * guard. Deliberately bypasses the plugin pipeline: the check must see
   * EVERY tenant's rows (including soft-deleted ones) — a tenant-scoped read
   * would let tenant A "confirm" (and later hard-delete) an object already
   * registered to tenant B under the same storage key.
   */
  async isKeyRegistered(key: string): Promise<boolean> {
    const found = await this.Model.exists({ key });
    return found !== null;
  }

  /**
   * @internal
   * Apply per-document updates and return BOTH which ids landed in the DB
   * AND which failed (with reason). Callers MUST use `succeededIds` to gate
   * any storage cleanup — silently swallowing failures while another phase
   * deletes the old object would corrupt storage.
   */
  async bulkUpdateMedia(
    updates: Array<{ id: string; data: Record<string, unknown> }>,
    context?: OperationContext | Record<string, unknown>,
  ): Promise<{
    modifiedCount: number;
    succeededIds: Set<string>;
    failed: Array<{ id: string; reason: string }>;
  }> {
    const succeededIds = new Set<string>();
    const failed: Array<{ id: string; reason: string }> = [];
    for (const { id, data } of updates) {
      try {
        const result = await this.update(id, data, context as Parameters<MediaRepository['update']>[2]);
        if (result === null) {
          failed.push({ id, reason: 'Update returned null (not found or scoped out)' });
          continue;
        }
        succeededIds.add(id);
      } catch (err) {
        failed.push({ id, reason: (err as Error).message });
      }
    }
    return { modifiedCount: succeededIds.size, succeededIds, failed };
  }
}
