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
 *   purgeDeleted, getSignedUploadUrl, confirmUpload, multipart suite,
 *   folder operations, analytics
 */

import type { Model } from 'mongoose';
import {
  Repository,
  type PluginType,
  type PaginationConfig,
} from '@classytic/mongokit';
import type {
  IMediaDocument,
  StorageDriver,
  UploadInput,
  ConfirmUploadInput,
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
} from '../types.js';
import type { EventTransport } from '../events/transport.js';
import type { ResolvedMediaConfig, MediaContext } from '../engine/engine-types.js';
import type { MediaBridges } from '../bridges/types.js';
import type { SourceRef } from '../bridges/source.bridge.js';
import type { TransformOpOutput } from '../bridges/transform.bridge.js';
import type { OperationDeps } from '../operations/types.js';
import { MEDIA_EVENTS } from '../events/event-constants.js';
import { createMediaEvent } from '../events/helpers.js';
import { ImageProcessor } from '../processing/image.js';
import { Semaphore } from '../utils/semaphore.js';
import { computeFileHash } from '../utils/hash.js';
import { isImage } from '../utils/mime.js';
import { normalizeFolderPath, buildFolderTree } from '../utils/folders.js';
import { generateAltText, generateAltTextWithOptions } from '../utils/alt-text.js';
import { processImage } from '../operations/process-image.js';
import {
  generateKey,
  generateTitle,
  validateFile as validateFileHelper,
  rewriteKey,
  rewriteKeyPrefix,
  executeKeyRewrite,
  getContentType as getContentTypeHelper,
  type RewritableFile,
} from '../operations/helpers.js';

// ── Repository Dependencies ──────────────────────────────────

export interface MediaRepositoryDeps {
  events: EventTransport;
  config: ResolvedMediaConfig;
  driver: StorageDriver;
  processor?: ImageProcessor | ImageAdapter | null;
  processorReady?: Promise<void> | null;
  logger?: MediaKitLogger;
  bridges?: MediaBridges;
}

// ── Repository Class ─────────────────────────────────────────

export class MediaRepository extends Repository<IMediaDocument> {
  private readonly events: EventTransport;
  private readonly driver: StorageDriver;
  private readonly processor: ImageProcessor | ImageAdapter | null;
  private readonly processorReady: Promise<void> | null;
  private readonly mediaConfig: ResolvedMediaConfig;
  private readonly uploadSemaphore: Semaphore;
  private readonly mediaLogger?: MediaKitLogger;
  public readonly bridges: MediaBridges;

  constructor(
    model: Model<IMediaDocument>,
    plugins: PluginType[],
    deps: MediaRepositoryDeps,
    pagination?: PaginationConfig,
  ) {
    super(model, plugins, pagination);
    this.events = deps.events;
    this.driver = deps.driver;
    this.processor = deps.processor ?? null;
    this.processorReady = deps.processorReady ?? null;
    this.mediaConfig = deps.config;
    this.uploadSemaphore = new Semaphore(deps.config.concurrency?.maxConcurrent ?? 5);
    this.mediaLogger = deps.logger;
    this.bridges = deps.bridges ?? {};
  }

  // ── Internal: bridge to legacy operation helpers ──────────

  /** Build OperationDeps for delegating to existing operation helpers. */
  private get _opDeps(): OperationDeps {
    // Minimal shim: events emitter that maps new transport → old event emitter shape
    const self = this;
    return {
      config: this.mediaConfig as any,
      driver: this.driver,
      repository: this as any,
      get processor() { return self.processor; },
      processorReady: this.processorReady,
      events: {
        emit: async () => {},
        on: () => () => {},
        removeAllListeners: () => {},
        listenerCount: () => 0,
      } as any,
      uploadSemaphore: this.uploadSemaphore,
      logger: this.mediaLogger,
    };
  }

  private _log(level: 'info' | 'warn' | 'error', message: string, meta?: Record<string, unknown>): void {
    this.mediaLogger?.[level]?.(message, meta);
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

    // Scan (if bridge provided) — reject / quarantine per verdict
    if (this.bridges.scan) {
      let scan;
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
      // 'quarantine' is handled after upload — we allow write but mark status: 'error'
      (input as any)._scanQuarantine = scan.verdict === 'quarantine' ? scan : null;
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
    const quarantine = (input as any)._scanQuarantine as { reason?: string; metadata?: Record<string, unknown> } | null;
    if (quarantine) {
      media = await this.update(String(media._id), {
        status: 'error',
        errorMessage: `Quarantined: ${quarantine.reason ?? 'manual review required'}`,
        metadata: { ...media.metadata, scanMetadata: quarantine.metadata ?? {} },
      } as any, { session: ctx?.session, organizationId: ctx?.organizationId } as any);
    }

    this._log('info', 'Media uploaded', { id: media._id, folder: media.folder, size: media.size });

    await this.events.publish(createMediaEvent(MEDIA_EVENTS.ASSET_UPLOADED, {
      assetId: String(media._id),
      filename: media.filename,
      mimeType: media.mimeType,
      size: media.size,
      folder: media.folder,
      key: media.key,
      url: media.url,
      hash: media.hash,
    }, ctx, { resource: 'media', resourceId: String(media._id) }));

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
    const existing = await this.getById(id, ctx as any);
    if (!existing) throw new Error(`Media ${id} not found`);

    const previousKey = existing.key;
    const previousVariants = [...(existing.variants || [])];

    // Process new file through the upload pipeline
    const { buffer, filename, mimeType } = input;
    validateFileHelper({ config: this.mediaConfig }, buffer, filename, mimeType);

    const hashAlgorithm = this.mediaConfig.deduplication?.algorithm || 'sha256';
    const hash = computeFileHash(buffer, hashAlgorithm);
    const targetFolder = normalizeFolderPath(input.folder || existing.folder || 'general');

    // Process image
    const processed = await processImage(this._opDeps, {
      buffer, filename, mimeType,
      skipProcessing: input.skipProcessing,
      contentType: input.contentType,
      focalPoint: input.focalPoint,
      targetFolder,
      context: ctx as any,
      quality: input.quality,
      format: input.format,
      maxWidth: input.maxWidth,
      maxHeight: input.maxHeight,
    });

    const newKey = generateKey(processed.finalFilename, targetFolder);

    // Write new file
    const writeResult = await this.driver.write(newKey, processed.finalBuffer, processed.finalMimeType);

    // Update DB record
    const updated = await this.update(id, {
      filename: processed.finalFilename,
      originalFilename: filename,
      mimeType: processed.finalMimeType,
      size: writeResult.size,
      url: writeResult.url,
      key: writeResult.key,
      hash,
      width: processed.width,
      height: processed.height,
      aspectRatio: processed.aspectRatio,
      variants: processed.variants,
      status: 'ready',
      thumbhash: processed.thumbhash,
      dominantColor: processed.dominantColor,
      exif: processed.exif,
      ...(input.alt !== undefined && { alt: input.alt }),
      ...(input.title !== undefined && { title: input.title }),
    } as any, { session: ctx?.session } as any);

    // Cleanup old files (best-effort)
    try { await this.driver.delete(previousKey); } catch { /* ignore */ }
    for (const v of previousVariants) {
      try { await this.driver.delete(v.key); } catch { /* ignore */ }
    }

    await this.events.publish(createMediaEvent(MEDIA_EVENTS.ASSET_REPLACED, {
      assetId: String(updated._id),
      filename: updated.filename,
      mimeType: updated.mimeType,
      size: updated.size,
      previousKey,
      newKey: writeResult.key,
    }, ctx, { resource: 'media', resourceId: String(updated._id) }));

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
    let media;
    try {
      media = await this.getById(id, { ...(ctx as any), includeDeleted: true, throwOnNotFound: false } as any);
    } catch {
      return false;
    }
    if (!media) return false;

    const variantKeys = (media.variants || []).map((v) => v.key);

    // Delete from storage (best-effort)
    try { await this.driver.delete(media.key); } catch (err) {
      this._log('warn', 'Failed to delete main file from storage', { id, key: media.key, error: (err as Error).message });
    }
    for (const variant of media.variants || []) {
      try { await this.driver.delete(variant.key); } catch { /* ignore */ }
    }

    // Hard delete from DB (bypass softDeletePlugin) — idempotent on race:
    // parallel calls will both see the doc before either wins the delete,
    // so we treat a "not found" error as success (someone else deleted it).
    try {
      await this.delete(id, { ...(ctx as any), mode: 'hard' } as any);
    } catch (err) {
      if (!/not found/i.test((err as Error).message)) throw err;
    }

    this._log('info', 'Media hard-deleted', { id });

    await this.events.publish(createMediaEvent(MEDIA_EVENTS.ASSET_DELETED, {
      assetId: id,
      key: media.key,
      variantKeys,
    }, ctx, { resource: 'media', resourceId: id }));

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

    await this.events.publish(createMediaEvent(MEDIA_EVENTS.BATCH_DELETED, {
      deletedIds: result.success,
      failedIds: result.failed.map((f) => f.id),
    }, ctx));

    return result;
  }

  /**
   * Purge soft-deleted files older than a given date.
   * Hard-deletes from both storage and database.
   */
  async purgeDeleted(olderThan?: Date, ctx?: MediaContext): Promise<number> {
    const cutoff = olderThan || new Date(Date.now() - (this.mediaConfig.softDelete?.ttlDays ?? 30) * 86400000);
    const docs = await this.Model.find({ deletedAt: { $ne: null, $lt: cutoff } }).lean();

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
      await this.events.publish(createMediaEvent(MEDIA_EVENTS.ASSET_PURGED, {
        count: purged,
        olderThan: cutoff,
      }, ctx));
    }

    return purged;
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
      // Metadata-only move
      const result = await this.Model.updateMany(
        { _id: { $in: ids } },
        { $set: { folder: normalizedTarget } },
      );
      const modifiedCount = result.modifiedCount ?? 0;
      await this.events.publish(createMediaEvent(MEDIA_EVENTS.ASSET_MOVED, {
        assetIds: ids, fromFolder: '', toFolder: normalizedTarget, modifiedCount,
      }, ctx));
      return { modifiedCount, failed: [] };
    }

    // Full key rewrite
    const files = await this.Model.find({ _id: { $in: ids } }).lean() as unknown as RewritableFile[];
    const result = await executeKeyRewrite(
      this._opDeps,
      files,
      (file) => ({ newKey: rewriteKey(file.key, normalizedTarget), newFolder: normalizedTarget }),
      (variantKey) => rewriteKey(variantKey, normalizedTarget),
      'progress:move' as any,
      ctx as any,
    );

    await this.events.publish(createMediaEvent(MEDIA_EVENTS.ASSET_MOVED, {
      assetIds: ids, fromFolder: '', toFolder: normalizedTarget, modifiedCount: result.modifiedCount,
    }, ctx));

    return result;
  }

  /**
   * Import a file from a URL.
   */
  async importFromUrl(url: string, options?: ImportOptions, ctx?: MediaContext): Promise<IMediaDocument> {
    // Delegate to existing import logic (has SSRF protection)
    const { importFromUrl: importFn } = await import('../operations/url-import.js');
    const result = await importFn(this._opDeps, url, options, ctx as any);

    await this.events.publish(createMediaEvent(MEDIA_EVENTS.ASSET_IMPORTED, {
      assetId: String(result._id),
      sourceUrl: url,
      filename: result.filename,
      mimeType: result.mimeType,
      size: result.size,
    }, ctx, { resource: 'media', resourceId: String(result._id) }));

    return result;
  }

  // ============================================================
  // DOMAIN VERBS — Tags & Focal Point
  // ============================================================

  async addTags(id: string, tags: string[], ctx?: MediaContext): Promise<IMediaDocument> {
    const result = await this.Model.findOneAndUpdate(
      { _id: id },
      { $addToSet: { tags: { $each: tags } } },
      { new: true },
    );
    if (!result) throw new Error(`Media ${id} not found`);

    await this.events.publish(createMediaEvent(MEDIA_EVENTS.ASSET_TAGGED, {
      assetId: id, tags,
    }, ctx, { resource: 'media', resourceId: id }));

    return result;
  }

  async removeTags(id: string, tags: string[], ctx?: MediaContext): Promise<IMediaDocument> {
    const result = await this.Model.findOneAndUpdate(
      { _id: id },
      { $pull: { tags: { $in: tags } } },
      { new: true },
    );
    if (!result) throw new Error(`Media ${id} not found`);

    await this.events.publish(createMediaEvent(MEDIA_EVENTS.ASSET_UNTAGGED, {
      assetId: id, tags,
    }, ctx, { resource: 'media', resourceId: id }));

    return result;
  }

  async setFocalPoint(id: string, focalPoint: FocalPoint, ctx?: MediaContext): Promise<IMediaDocument> {
    if (focalPoint.x < 0 || focalPoint.x > 1 || focalPoint.y < 0 || focalPoint.y > 1) {
      throw new Error('Focal point coordinates must be between 0 and 1');
    }
    const result = await this.Model.findOneAndUpdate(
      { _id: id },
      { $set: { focalPoint } },
      { new: true },
    );
    if (!result) throw new Error(`Media ${id} not found`);

    await this.events.publish(createMediaEvent(MEDIA_EVENTS.FOCAL_POINT_SET, {
      assetId: id, focalPoint,
    }, ctx, { resource: 'media', resourceId: id }));

    return result;
  }

  // ============================================================
  // DOMAIN VERBS — Presigned Uploads
  // ============================================================

  async getSignedUploadUrl(
    filename: string,
    contentType: string,
    options: { folder?: string; expiresIn?: number } = {},
  ): Promise<PresignedUploadResult> {
    const { getSignedUploadUrl: fn } = await import('../operations/presigned.js');
    return fn(this._opDeps, filename, contentType, options);
  }

  async confirmUpload(input: ConfirmUploadInput, ctx?: MediaContext): Promise<IMediaDocument> {
    const { confirmUpload: fn } = await import('../operations/presigned.js');
    const result = await fn(this._opDeps, input, ctx as any);

    await this.events.publish(createMediaEvent(MEDIA_EVENTS.UPLOAD_CONFIRMED, {
      assetId: String(result._id), key: result.key, filename: result.filename,
      mimeType: result.mimeType, size: result.size,
    }, ctx, { resource: 'media', resourceId: String(result._id) }));

    return result;
  }

  async initiateMultipartUpload(input: InitiateMultipartInput): Promise<MultipartUploadSession> {
    const { initiateMultipartUpload: fn } = await import('../operations/presigned.js');
    return fn(this._opDeps, input);
  }

  async signUploadPart(key: string, uploadId: string, partNumber: number, expiresIn?: number): Promise<SignedPartResult> {
    const { signUploadPart: fn } = await import('../operations/presigned.js');
    return fn(this._opDeps, key, uploadId, partNumber, expiresIn);
  }

  async signUploadParts(key: string, uploadId: string, partNumbers: number[], expiresIn?: number): Promise<SignedPartResult[]> {
    const { signUploadParts: fn } = await import('../operations/presigned.js');
    return fn(this._opDeps, key, uploadId, partNumbers, expiresIn);
  }

  async completeMultipartUpload(input: CompleteMultipartInput, ctx?: MediaContext): Promise<IMediaDocument> {
    const { completeMultipartUpload: fn } = await import('../operations/presigned.js');
    const result = await fn(this._opDeps, input, ctx as any);

    await this.events.publish(createMediaEvent(MEDIA_EVENTS.MULTIPART_COMPLETED, {
      assetId: String(result._id), key: result.key, filename: result.filename, size: result.size,
    }, ctx, { resource: 'media', resourceId: String(result._id) }));

    return result;
  }

  async abortMultipartUpload(key: string, uploadId: string): Promise<void> {
    const { abortMultipartUpload: fn } = await import('../operations/presigned.js');
    return fn(this._opDeps, key, uploadId);
  }

  async generateBatchPutUrls(input: BatchPresignInput): Promise<BatchPresignResult> {
    const { generateBatchPutUrls: fn } = await import('../operations/presigned.js');
    return fn(this._opDeps, input);
  }

  // ============================================================
  // DOMAIN VERBS — Folder Operations
  // ============================================================

  async getFolderTree(ctx?: MediaContext): Promise<FolderTree> {
    const folders = await this.Model.aggregate([
      ...(ctx?.organizationId ? [{ $match: { organizationId: ctx.organizationId } }] : []),
      { $match: { deletedAt: null } },
      { $group: { _id: '$folder', count: { $sum: 1 }, size: { $sum: '$size' }, latestUpload: { $max: '$createdAt' } } },
    ]);

    const tree = buildFolderTree(
      folders.map((f: any) => ({
        folder: f._id,
        count: f.count,
        totalSize: f.size,
        latestUpload: f.latestUpload,
      })),
    );
    return tree;
  }

  async getFolderStats(folder: string, ctx?: MediaContext): Promise<FolderStats> {
    const match: Record<string, unknown> = {
      folder: { $regex: `^${folder.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}` },
      deletedAt: null,
    };
    if (ctx?.organizationId) match.organizationId = ctx.organizationId;

    const [stats] = await this.Model.aggregate([
      { $match: match },
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
    ]);

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
    const files = await this.Model.find({
      folder: { $regex: `^${folder.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}` },
      deletedAt: null,
    }).select('_id').lean();

    const ids = files.map((f: any) => String(f._id));
    const result = await this.hardDeleteMany(ids, ctx);

    await this.events.publish(createMediaEvent(MEDIA_EVENTS.FOLDER_DELETED, {
      folder, deletedCount: result.success.length,
    }, ctx));

    return result;
  }

  async renameFolder(oldPath: string, newPath: string, ctx?: MediaContext): Promise<RewriteResult> {
    const normalizedOld = normalizeFolderPath(oldPath);
    const normalizedNew = normalizeFolderPath(newPath);
    const rewriteKeys = this.mediaConfig.folders?.rewriteKeys !== false;

    // Find all files under old folder path
    const files = await this.Model.find({
      folder: { $regex: `^${normalizedOld.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}` },
      deletedAt: null,
    }).lean() as unknown as RewritableFile[];

    if (!rewriteKeys) {
      // Metadata-only rename
      const result = await this.Model.updateMany(
        { folder: { $regex: `^${normalizedOld.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}` } },
        [{ $set: { folder: { $replaceAll: { input: '$folder', find: normalizedOld, replacement: normalizedNew } } } }],
      );
      const modifiedCount = result.modifiedCount ?? 0;
      await this.events.publish(createMediaEvent(MEDIA_EVENTS.FOLDER_RENAMED, {
        oldPath: normalizedOld, newPath: normalizedNew, modifiedCount,
      }, ctx));
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
      'progress:rename' as any,
      ctx as any,
    );

    await this.events.publish(createMediaEvent(MEDIA_EVENTS.FOLDER_RENAMED, {
      oldPath: normalizedOld, newPath: normalizedNew, modifiedCount: result.modifiedCount,
    }, ctx));

    return result;
  }

  async getSubfolders(parentPath: string, ctx?: MediaContext): Promise<FolderNode[]> {
    const normalized = normalizeFolderPath(parentPath);
    const escapedPath = normalized.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const depth = normalized.split('/').filter(Boolean).length;

    const match: Record<string, unknown> = {
      folder: { $regex: `^${escapedPath}/` },
      deletedAt: null,
    };
    if (ctx?.organizationId) match.organizationId = ctx.organizationId;

    const results = await this.Model.aggregate([
      { $match: match },
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
    ]);

    return results.map((r: any) => ({
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
  async resolveSourcesMany(
    medias: IMediaDocument[],
    ctx?: MediaContext,
  ): Promise<Map<string, unknown>> {
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
  async getAssetUrl(
    media: IMediaDocument,
    options?: { signed?: boolean; expiresIn?: number },
  ): Promise<string> {
    const defaultUrl = media.url || this.driver.getPublicUrl(media.key);
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
    const media = await this.getById(mediaId, ctx as any);
    if (!media) throw new Error(`Media ${mediaId} not found`);

    const opsRegistry = this.bridges.transform?.ops;
    if (!opsRegistry || Object.keys(opsRegistry).length === 0) {
      throw new Error('[media-kit] No TransformBridge configured — register ops via bridges.transform.ops');
    }

    for (const name of options.ops) {
      if (!opsRegistry[name]) {
        throw new Error(`[media-kit] Unknown transform op: '${name}'. Registered: ${Object.keys(opsRegistry).join(', ') || '(none)'}`);
      }
    }

    // Read source buffer from storage
    const stream = await this.driver.read(media.key);
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
    const query: Record<string, unknown> = { hash, deletedAt: null };
    if (ctx?.organizationId) query.organizationId = ctx.organizationId;
    return this.Model.findOne(query).lean() as Promise<IMediaDocument | null>;
  }

  async getStorageByFolder(ctx?: MediaContext): Promise<Array<{ folder: string; totalSize: number; count: number }>> {
    const match: Record<string, unknown> = { deletedAt: null };
    if (ctx?.organizationId) match.organizationId = ctx.organizationId;

    return this.Model.aggregate([
      { $match: match },
      { $group: { _id: '$folder', totalSize: { $sum: '$size' }, count: { $sum: 1 } } },
      { $project: { folder: '$_id', totalSize: 1, count: 1, _id: 0 } },
      { $sort: { totalSize: -1 } },
    ]);
  }

  async getTotalStorageUsed(ctx?: MediaContext): Promise<number> {
    const match: Record<string, unknown> = { deletedAt: null };
    if (ctx?.organizationId) match.organizationId = ctx.organizationId;

    const [result] = await this.Model.aggregate([
      { $match: match },
      { $group: { _id: null, total: { $sum: '$size' } } },
    ]);
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
  private async _performUpload(
    input: UploadInput & { hash: string },
    ctx?: MediaContext,
  ): Promise<IMediaDocument> {
    const { buffer, filename, mimeType, folder, hash } = input;
    let { alt } = input;

    // Generate alt text
    if (!alt && isImage(mimeType)) {
      const generateAltConfig = this.mediaConfig.processing?.generateAlt;
      if (generateAltConfig) {
        const enabled = typeof generateAltConfig === 'boolean' ? generateAltConfig : generateAltConfig.enabled;
        if (enabled) {
          if (typeof generateAltConfig === 'object' && generateAltConfig.generator) {
            try { alt = (await generateAltConfig.generator(filename, buffer)) || generateAltConfig.fallback || 'Image'; }
            catch { alt = generateAltConfig.fallback || generateAltText(filename); }
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

    // Step 1: Create DB record with status: 'pending'
    let media = await this.create({
      filename,
      originalFilename: filename,
      title: finalTitle,
      mimeType,
      size: buffer.length,
      url: this.driver.getPublicUrl(key),
      key,
      hash,
      status: 'pending',
      folder: targetFolder,
      alt,
      description: input.description,
      tags: input.tags || [],
      focalPoint: input.focalPoint,
      variants: [],
      metadata: {},
      ...(input.sourceId && { sourceId: input.sourceId }),
      ...(input.sourceModel && { sourceModel: input.sourceModel }),
    } as any, { session: ctx?.session, organizationId: ctx?.organizationId } as any);

    const mediaId = String(media._id);
    const variants: GeneratedVariant[] = [];

    const updateOpts = { session: ctx?.session, organizationId: ctx?.organizationId } as any;

    try {
      // Step 2: processing
      media = await this.update(mediaId, { status: 'processing' } as any, updateOpts);

      const processed = await processImage(this._opDeps, {
        buffer, filename, mimeType,
        skipProcessing: input.skipProcessing,
        contentType: input.contentType,
        focalPoint: input.focalPoint,
        targetFolder,
        context: ctx as any,
        quality: input.quality,
        format: input.format,
        maxWidth: input.maxWidth,
        maxHeight: input.maxHeight,
      });
      variants.push(...processed.variants);

      if (processed.finalMimeType !== mimeType) {
        key = generateKey(processed.finalFilename, targetFolder);
      }

      // Step 3: Write to storage
      const writeResult = await this.driver.write(key, processed.finalBuffer, processed.finalMimeType);

      // Step 4: ready
      media = await this.update(mediaId, {
        filename: processed.finalFilename,
        mimeType: processed.finalMimeType,
        size: writeResult.size,
        url: writeResult.url,
        key: writeResult.key,
        width: processed.width,
        height: processed.height,
        aspectRatio: processed.aspectRatio,
        variants: variants.length > 0 ? variants : [],
        status: 'ready',
        thumbhash: processed.thumbhash,
        dominantColor: processed.dominantColor,
        videoMetadata: processed.videoMetadata,
        exif: processed.exif,
        ...(processed.duration !== undefined && { duration: processed.duration }),
      } as any, updateOpts);

      return media;
    } catch (error) {
      // Step 5: error
      try {
        await this.update(mediaId, { status: 'error', errorMessage: (error as Error).message } as any, updateOpts);
      } catch { /* ignore */ }

      // Cleanup orphaned variants
      for (const v of variants) {
        try { await this.driver.delete(v.key); } catch { /* ignore */ }
      }

      throw error;
    }
  }

  // ============================================================
  // INTERNAL — v2 compat bridge methods (used by operation helpers)
  // ============================================================

  /** @internal Used by operation helpers that expect v2 repo API */
  async createMedia(data: Record<string, unknown>, context?: any): Promise<IMediaDocument> {
    return this.create(data as any, context);
  }

  /** @internal */
  async getMediaById(id: string, context?: any): Promise<IMediaDocument | null> {
    return this.getById(id, { ...(context || {}), throwOnNotFound: false } as any);
  }

  /** @internal */
  async updateMedia(id: string, data: Record<string, unknown>, context?: any): Promise<IMediaDocument> {
    return this.update(id, data as any, context);
  }

  /** @internal */
  async deleteMedia(id: string, context?: any): Promise<boolean> {
    try {
      await this.delete(id, { ...(context || {}), mode: 'hard' } as any);
      return true;
    } catch {
      return false;
    }
  }

  /** @internal */
  async bulkUpdateMedia(
    updates: Array<{ id: string; data: Record<string, unknown> }>,
    context?: any,
  ): Promise<{ modifiedCount: number }> {
    let modified = 0;
    for (const { id, data } of updates) {
      try {
        await this.update(id, data as any, context);
        modified++;
      } catch { /* ignore individual failures */ }
    }
    return { modifiedCount: modified };
  }
}
