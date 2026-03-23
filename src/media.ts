/**
 * Media Kit Factory
 *
 * Thin facade that creates a configured media management instance.
 * All operation logic is delegated to modules in ./operations/.
 *
 * @example
 * ```ts
 * import { createMedia } from '@classytic/media-kit';
 * import { S3Provider } from '@classytic/media-kit/providers/s3';
 * import { cachePlugin, createMemoryCache } from '@classytic/mongokit';
 * import mongoose from 'mongoose';
 *
 * const media = createMedia({
 *   driver: new S3Provider({ bucket: 'my-bucket', region: 'us-east-1' }),
 *   folders: { defaultFolder: 'general' },
 *   processing: {
 *     enabled: true,
 *     format: 'webp',
 *     quality: 80,
 *     aspectRatios: {
 *       product: { aspectRatio: 3/4, fit: 'cover' },
 *       avatar: { aspectRatio: 1, fit: 'cover' },
 *     },
 *   },
 *   plugins: [cachePlugin({ adapter: createMemoryCache() })],
 * });
 *
 * const Media = mongoose.model('Media', media.schema);
 * media.init(Media);
 *
 * const uploaded = await media.upload({
 *   buffer: fileBuffer,
 *   filename: 'product.jpg',
 *   mimeType: 'image/jpeg',
 *   folder: 'products/featured',
 * });
 *
 * const page = await media.getAll({ page: 1, limit: 20 });
 * const results = await media.search('shoes', { limit: 10 });
 * ```
 */

import { Schema } from 'mongoose';
import type {
  OffsetPaginationResult,
  KeysetPaginationResult,
  SortSpec,
} from '@classytic/mongokit';
import type {
  MediaKitConfig,
  MediaKit,
  IMediaDocument,
  UploadInput,
  ConfirmUploadInput,
  PresignedUploadResult,
  OperationContext,
  FolderTree,
  FolderStats,
  FolderNode,
  BreadcrumbItem,
  BulkResult,
  RewriteResult,
  MediaEventName,
  EventListener,
  Unsubscribe,
  FocalPoint,
  ImportOptions,
  StorageDriver,
  MediaModel,
  ImageAdapter,
  InitiateMultipartInput,
  MultipartUploadSession,
  CompleteMultipartInput,
  SignedPartResult,
  BatchPresignInput,
  BatchPresignResult,
} from './types';
import type { OperationDeps } from './operations/types';
import { MediaEventEmitter } from './events';
import { createMediaSchema } from './schema/media.schema';
import { MediaRepository } from './repository/media.repository';
import { ImageProcessor } from './processing/image';
import { Semaphore } from './utils/semaphore';
import { mergeConfig } from './config';

// Operation imports (direct — no barrel for tree-shaking)
import { upload, uploadMany } from './operations/upload';
import { replace } from './operations/replace';
import { deleteMedia, deleteMany } from './operations/delete';
import { softDelete, restore, purgeDeleted } from './operations/soft-delete';
import { importFromUrl } from './operations/url-import';
import {
  getSignedUploadUrl,
  confirmUpload,
  initiateMultipartUpload,
  signUploadPart,
  signUploadParts,
  completeMultipartUpload,
  abortMultipartUpload,
  generateBatchPutUrls,
} from './operations/presigned';
import { addTags, removeTags } from './operations/tags';
import { setFocalPoint } from './operations/focal-point';
import { getById, getAll, search } from './operations/queries';
import { move } from './operations/move';
import {
  getFolderTree,
  getFolderStats,
  getBreadcrumb,
  deleteFolder,
  renameFolder,
  getSubfolders,
} from './operations/folders';
import { getContentType as getContentTypeHelper, validateFile as validateFileHelper } from './operations/helpers';

/**
 * Media Kit Implementation
 */
class MediaKitImpl implements MediaKit {
  readonly config: MediaKitConfig;
  readonly driver: StorageDriver;
  readonly schema: Schema<IMediaDocument>;

  private _repository: MediaRepository | null = null;
  private _deps: OperationDeps | null = null;
  private processor: ImageProcessor | ImageAdapter | null = null;
  private processorReady: Promise<void> | null = null;
  private logger: MediaKitConfig['logger'];
  private events: MediaEventEmitter;
  private uploadSemaphore: Semaphore;

  constructor(config: MediaKitConfig) {
    this.config = mergeConfig(config);

    this.driver = this.config.driver;
    this.logger = this.config.logger;

    // Initialize event emitter
    this.events = new MediaEventEmitter(this.logger);

    // Initialize concurrency control
    const maxConcurrent = this.config.concurrency?.maxConcurrent ?? 5;
    this.uploadSemaphore = new Semaphore(maxConcurrent);

    // Create schema
    this.schema = createMediaSchema({
      multiTenancy: this.config.multiTenancy,
    });

    // Initialize processor: custom adapter → built-in Sharp → none
    if (this.config.processing?.imageAdapter) {
      this.processor = this.config.processing.imageAdapter;
      this.processorReady = Promise.resolve();
    } else if (this.config.processing?.enabled) {
      const sharpOptions = this.config.processing?.sharpOptions;
      const sharpProcessor = new ImageProcessor({
        concurrency: sharpOptions?.concurrency ?? 2,
        cache: sharpOptions?.cache ?? false,
      });
      this.processor = sharpProcessor;

      this.processorReady = sharpProcessor.waitUntilReady().then((available) => {
        if (!available) {
          this.processor = null;
          if (!this.config.suppressWarnings) {
            this.logger?.warn?.(
              'Image processing disabled: sharp not available. Install with: npm install sharp',
            );
          }
        }
      }).catch(() => {
        this.processor = null;
        if (!this.config.suppressWarnings) {
          this.logger?.warn?.(
            'Image processing disabled: sharp not available. Install with: npm install sharp',
          );
        }
      });
    } else {
      this.processor = null;
      this.processorReady = Promise.resolve();
    }
  }

  // ============================================
  // INITIALIZATION
  // ============================================

  get repository(): MediaRepository {
    if (!this._repository) {
      throw new Error('MediaKit not initialized. Call media.init(Model) first.');
    }
    return this._repository;
  }

  init(model: MediaModel): this {
    if (this._repository) {
      throw new Error('MediaKit already initialized. Create a new instance instead of calling init() twice.');
    }

    this._repository = new MediaRepository(model, {
      multiTenancy: this.config.multiTenancy,
      plugins: this.config.plugins,
      pagination: this.config.pagination,
      cache: this.config.cache ? {
        adapter: this.config.cache.adapter,
        byIdTtl: this.config.cache.byIdTtl,
        queryTtl: this.config.cache.queryTtl,
        prefix: this.config.cache.prefix,
      } : undefined,
    });

    return this;
  }

  // ============================================
  // SHARED DEPS (cached after first access)
  // ============================================

  private get deps(): OperationDeps {
    if (!this._deps) {
      const self = this;
      this._deps = {
        config: this.config,
        driver: this.driver,
        repository: this.repository, // triggers getter, throws if not init'd
        get processor() { return self.processor; },
        processorReady: this.processorReady,
        events: this.events,
        uploadSemaphore: this.uploadSemaphore,
        logger: this.logger,
      };
    }
    return this._deps;
  }

  // ============================================
  // EVENT SYSTEM
  // ============================================

  on<T = unknown>(event: MediaEventName, listener: EventListener<T>): Unsubscribe {
    return this.events.on(event, listener);
  }

  // ============================================
  // LIFECYCLE
  // ============================================

  dispose(): void {
    this.events.removeAllListeners();
    this._repository = null;
    this._deps = null;
    this.processor = null;
    this.processorReady = null;
  }

  // ============================================
  // PUBLIC HELPERS
  // ============================================

  validateFile(buffer: Buffer, filename: string, mimeType: string): void {
    validateFileHelper({ config: this.config }, buffer, filename, mimeType);
  }

  getContentType(folder: string): string {
    return getContentTypeHelper({ config: this.config }, folder);
  }

  // ============================================
  // CORE OPERATIONS (delegates)
  // ============================================

  async upload(input: UploadInput, context?: OperationContext): Promise<IMediaDocument> {
    return upload(this.deps, input, context);
  }

  async uploadMany(inputs: UploadInput[], context?: OperationContext): Promise<IMediaDocument[]> {
    return uploadMany(this.deps, inputs, context);
  }

  async replace(id: string, input: UploadInput, context?: OperationContext): Promise<IMediaDocument> {
    return replace(this.deps, id, input, context);
  }

  async delete(id: string, context?: OperationContext): Promise<boolean> {
    return deleteMedia(this.deps, id, context);
  }

  async deleteMany(ids: string[], context?: OperationContext): Promise<BulkResult> {
    return deleteMany(this.deps, ids, context);
  }

  // ============================================
  // SOFT DELETES
  // ============================================

  async softDelete(id: string, context?: OperationContext): Promise<IMediaDocument> {
    return softDelete(this.deps, id, context);
  }

  async restore(id: string, context?: OperationContext): Promise<IMediaDocument> {
    return restore(this.deps, id, context);
  }

  async purgeDeleted(olderThan?: Date, context?: OperationContext): Promise<number> {
    return purgeDeleted(this.deps, olderThan, context);
  }

  // ============================================
  // URL IMPORT
  // ============================================

  async importFromUrl(url: string, options?: ImportOptions, context?: OperationContext): Promise<IMediaDocument> {
    return importFromUrl(this.deps, url, options, context);
  }

  // ============================================
  // TAGS
  // ============================================

  async addTags(id: string, tags: string[], context?: OperationContext): Promise<IMediaDocument> {
    return addTags(this.deps, id, tags, context);
  }

  async removeTags(id: string, tags: string[], context?: OperationContext): Promise<IMediaDocument> {
    return removeTags(this.deps, id, tags, context);
  }

  // ============================================
  // FOCAL POINT
  // ============================================

  async setFocalPoint(id: string, focalPoint: FocalPoint, context?: OperationContext): Promise<IMediaDocument> {
    return setFocalPoint(this.deps, id, focalPoint, context);
  }

  // ============================================
  // QUERY OPERATIONS
  // ============================================

  async getById(id: string, context?: OperationContext): Promise<IMediaDocument | null> {
    return getById(this.deps, id, context);
  }

  async getAll(
    params: {
      filters?: Record<string, unknown>;
      sort?: SortSpec | string;
      limit?: number;
      page?: number;
      cursor?: string;
      after?: string;
      search?: string;
    } = {},
    context?: OperationContext,
  ): Promise<OffsetPaginationResult<IMediaDocument> | KeysetPaginationResult<IMediaDocument>> {
    return getAll(this.deps, params, context);
  }

  async search(
    query: string,
    params: { limit?: number; page?: number; filters?: Record<string, unknown> } = {},
    context?: OperationContext,
  ): Promise<OffsetPaginationResult<IMediaDocument> | KeysetPaginationResult<IMediaDocument>> {
    return search(this.deps, query, params, context);
  }

  // ============================================
  // MOVE
  // ============================================

  async move(ids: string[], targetFolder: string, context?: OperationContext): Promise<RewriteResult> {
    return move(this.deps, ids, targetFolder, context);
  }

  // ============================================
  // FOLDER OPERATIONS
  // ============================================

  async getFolderTree(context?: OperationContext): Promise<FolderTree> {
    return getFolderTree(this.deps, context);
  }

  async getFolderStats(folder: string, context?: OperationContext): Promise<FolderStats> {
    return getFolderStats(this.deps, folder, context);
  }

  getBreadcrumb(folder: string): BreadcrumbItem[] {
    return getBreadcrumb(this.deps, folder);
  }

  async deleteFolder(folder: string, context?: OperationContext): Promise<BulkResult> {
    return deleteFolder(this.deps, folder, context);
  }

  async renameFolder(oldPath: string, newPath: string, context?: OperationContext): Promise<RewriteResult> {
    return renameFolder(this.deps, oldPath, newPath, context);
  }

  async getSubfolders(parentPath: string, context?: OperationContext): Promise<FolderNode[]> {
    return getSubfolders(this.deps, parentPath, context);
  }

  // ============================================
  // PRESIGNED UPLOAD FLOW
  // ============================================

  async getSignedUploadUrl(
    filename: string,
    contentType: string,
    options: { folder?: string; expiresIn?: number } = {},
  ): Promise<PresignedUploadResult> {
    return getSignedUploadUrl(this.deps, filename, contentType, options);
  }

  async confirmUpload(input: ConfirmUploadInput, context?: OperationContext): Promise<IMediaDocument> {
    return confirmUpload(this.deps, input, context);
  }

  // ============================================
  // MULTIPART UPLOAD FLOW
  // ============================================

  async initiateMultipartUpload(input: InitiateMultipartInput): Promise<MultipartUploadSession> {
    return initiateMultipartUpload(this.deps, input);
  }

  async signUploadPart(key: string, uploadId: string, partNumber: number, expiresIn?: number): Promise<SignedPartResult> {
    return signUploadPart(this.deps, key, uploadId, partNumber, expiresIn);
  }

  async signUploadParts(key: string, uploadId: string, partNumbers: number[], expiresIn?: number): Promise<SignedPartResult[]> {
    return signUploadParts(this.deps, key, uploadId, partNumbers, expiresIn);
  }

  async completeMultipartUpload(input: CompleteMultipartInput, context?: OperationContext): Promise<IMediaDocument> {
    return completeMultipartUpload(this.deps, input, context);
  }

  async abortMultipartUpload(key: string, uploadId: string): Promise<void> {
    return abortMultipartUpload(this.deps, key, uploadId);
  }

  // ============================================
  // RESUMABLE UPLOAD HELPERS (GCS)
  // ============================================

  async abortResumableUpload(sessionUri: string): Promise<void> {
    if (!this.driver.abortResumableUpload) {
      throw new Error(`Driver '${this.driver.name}' does not support resumable abort`);
    }
    return this.driver.abortResumableUpload(sessionUri);
  }

  async getResumableUploadStatus(sessionUri: string): Promise<{ uploadedBytes: number }> {
    if (!this.driver.getResumableUploadStatus) {
      throw new Error(`Driver '${this.driver.name}' does not support resumable status query`);
    }
    return this.driver.getResumableUploadStatus(sessionUri);
  }

  // ============================================
  // BATCH PRESIGNED URLS
  // ============================================

  async generateBatchPutUrls(input: BatchPresignInput): Promise<BatchPresignResult> {
    return generateBatchPutUrls(this.deps, input);
  }
}

/**
 * Create media kit instance
 */
export function createMedia(config: MediaKitConfig): MediaKit {
  return new MediaKitImpl(config);
}

export default createMedia;
