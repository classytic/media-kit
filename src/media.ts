/**
 * Media Kit Factory
 * 
 * Creates a configured media management instance powered by mongokit.
 * 
 * @example
 * ```ts
 * import { createMedia } from '@classytic/media-kit';
 * import { S3Provider } from '@classytic/media-kit/providers/s3';
 * import { cachePlugin, createMemoryCache } from '@classytic/mongokit';
 * import mongoose from 'mongoose';
 * 
 * // 1. Create media kit instance with mongokit plugins
 * const media = createMedia({
 *   provider: new S3Provider({ bucket: 'my-bucket', region: 'us-east-1' }),
 *   folders: {
 *     baseFolders: ['products', 'users', 'posts'],
 *     defaultFolder: 'general',
 *   },
 *   processing: {
 *     enabled: true,
 *     format: 'webp',
 *     quality: 80,
 *     aspectRatios: {
 *       product: { aspectRatio: 3/4, fit: 'cover' },
 *       avatar: { aspectRatio: 1, fit: 'cover' },
 *     },
 *   },
 *   // Mongokit plugins
 *   plugins: [
 *     cachePlugin({ adapter: createMemoryCache() })
 *   ],
 * });
 * 
 * // 2. Create mongoose model from schema
 * const Media = mongoose.model('Media', media.schema);
 * 
 * // 3. Initialize with model
 * media.init(Media);
 * 
 * // 4. Use it - full mongokit features available
 * const uploaded = await media.upload({
 *   buffer: fileBuffer,
 *   filename: 'product.jpg',
 *   mimeType: 'image/jpeg',
 *   folder: 'products/featured',
 * });
 * 
 * // Smart pagination (auto-detects offset vs keyset)
 * const page1 = await media.getAll({ page: 1, limit: 20 });
 * const stream = await media.getAll({ sort: { createdAt: -1 }, limit: 50 });
 * const next = await media.getAll({ after: stream.next, sort: { createdAt: -1 } });
 * 
 * // Direct repository access for advanced queries
 * const stats = await media.repository.getStorageByFolder();
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
  OperationContext,
  FolderTree,
  FolderStats,
  BreadcrumbItem,
  BulkResult,
  ProcessingOptions,
  AspectRatioPreset,
  MediaEventName,
  EventListener,
  EventContext,
  EventResult,
  EventError,
  GeneratedVariant,
  MediaModel,
} from './types';
import { createMediaSchema } from './schema/media.schema';
import { MediaRepository } from './repository/media.repository';
import { ImageProcessor } from './processing/image';
import { isAllowedMimeType, isImage, updateFilenameExtension } from './utils/mime';
import { extractBaseFolder, isValidFolder, normalizeFolderPath } from './utils/folders';
import { generateAltText } from './utils/alt-text';
import { Semaphore } from './utils/semaphore';
import { mergeConfig } from './config';

/**
 * Media Kit Implementation
 */
class MediaKitImpl implements MediaKit {
  readonly config: MediaKitConfig;
  readonly provider: MediaKitConfig['provider'];
  readonly schema: Schema<IMediaDocument>;

  private _repository: MediaRepository | null = null;
  private processor: ImageProcessor | null = null;
  private _model: MediaModel | null = null;
  private logger: MediaKitConfig['logger'];
  private eventListeners: Map<MediaEventName, EventListener[]> = new Map();
  private uploadSemaphore: Semaphore;

  constructor(config: MediaKitConfig) {
    this.config = mergeConfig(config);

    this.provider = config.provider;
    this.logger = config.logger;

    // Initialize concurrency control
    const maxConcurrent = this.config.concurrency?.maxConcurrent ?? 5;
    this.uploadSemaphore = new Semaphore(maxConcurrent);

    // Create schema
    this.schema = createMediaSchema({
      baseFolders: this.config.folders?.baseFolders,
      multiTenancy: this.config.multiTenancy,
    });

    // Initialize processor with Sharp options
    if (this.config.processing?.enabled) {
      try {
        const sharpOptions = this.config.processing?.sharpOptions;
        this.processor = new ImageProcessor({
          concurrency: sharpOptions?.concurrency ?? 2,
          cache: sharpOptions?.cache ?? false,
        });
      } catch {
        if (!this.config.suppressWarnings) {
          this.log('warn', 'Image processing disabled: sharp not available. Install with: npm install sharp');
        }
      }
    }
  }

  /**
   * Get repository (throws if not initialized)
   */
  get repository(): MediaRepository {
    if (!this._repository) {
      throw new Error('MediaKit not initialized. Call media.init(Model) first.');
    }
    return this._repository;
  }

  /**
   * Initialize with mongoose model
   */
  init(model: MediaModel): this {
    this._model = model;
    
    // Create mongokit-powered repository
    this._repository = new MediaRepository(model, {
      multiTenancy: this.config.multiTenancy,
      plugins: this.config.plugins,
      pagination: this.config.pagination,
    });
    
    return this;
  }

  /**
   * Event system: Register event listener
   */
  on<T = unknown>(event: MediaEventName, listener: EventListener<T>): void {
    const listeners = this.eventListeners.get(event) || [];
    listeners.push(listener as EventListener);
    this.eventListeners.set(event, listeners);
  }

  /**
   * Event system: Emit event
   */
  emit<T = unknown>(event: MediaEventName, payload: T): void {
    const listeners = this.eventListeners.get(event) || [];
    for (const listener of listeners) {
      try {
        void Promise.resolve(listener(payload));
      } catch (err) {
        this.log('error', `Event listener error: ${event}`, {
          error: (err as Error).message
        });
      }
    }
  }

  /**
   * Log helper
   */
  private log(level: 'info' | 'warn' | 'error', message: string, meta?: Record<string, unknown>) {
    if (this.logger) {
      this.logger[level](message, meta);
    }
  }

  /**
   * Require tenant context when multi-tenancy is enabled
   */
  private requireTenant(context?: OperationContext): OperationContext['organizationId'] | undefined {
    if (!this.config.multiTenancy?.enabled) {
      return undefined;
    }

    const organizationId = context?.organizationId;
    const field = this.config.multiTenancy.field || 'organizationId';

    if (!organizationId && this.config.multiTenancy.required) {
      throw new Error(`Multi-tenancy enabled: '${field}' is required in context`);
    }

    return organizationId;
  }

  /**
   * Get content type from folder path
   */
  getContentType(folder: string): string {
    const contentTypeMap = this.config.folders?.contentTypeMap || {};
    const folderLower = folder.toLowerCase();

    for (const [contentType, patterns] of Object.entries(contentTypeMap)) {
      if (patterns.some((p: string) => folderLower.includes(p.toLowerCase()))) {
        return contentType;
      }
    }

    return 'default';
  }

  /**
   * Get aspect ratio preset for content type
   */
  private getAspectRatio(contentType: string): AspectRatioPreset | undefined {
    return this.config.processing?.aspectRatios?.[contentType] 
      || this.config.processing?.aspectRatios?.default;
  }

  /**
   * Validate file
   */
  validateFile(buffer: Buffer, filename: string, mimeType: string): void {
    // Check for empty file
    if (!buffer || buffer.length === 0) {
      throw new Error(`Cannot upload empty file '${filename}'. Buffer is empty or missing.`);
    }

    const { allowed = [], maxSize } = this.config.fileTypes || {};

    // Check MIME type
    if (allowed.length > 0 && !isAllowedMimeType(mimeType, allowed)) {
      throw new Error(`File type '${mimeType}' is not allowed. Allowed: ${allowed.join(', ')}`);
    }

    // Check size
    if (maxSize && buffer.length > maxSize) {
      const maxMB = Math.round(maxSize / 1024 / 1024);
      throw new Error(`File size exceeds limit of ${maxMB}MB`);
    }
  }

  /**
   * Upload single file with concurrency control
   */
  async upload(input: UploadInput, context?: OperationContext): Promise<IMediaDocument> {
    const repo = this.repository;
    const { buffer, filename, mimeType, folder, title, contentType, skipProcessing } = input;
    let { alt } = input;
    const organizationId = this.requireTenant(context);

    // Emit before:upload event
    const eventCtx: EventContext<UploadInput> = {
      data: input,
      context,
      timestamp: new Date()
    };
    this.emit('before:upload', eventCtx);

    try {
      // Validate (before acquiring semaphore slot)
      this.validateFile(buffer, filename, mimeType);

      // Use semaphore to control concurrency and prevent memory crashes
      const media = await this.uploadSemaphore.run(async () => {
        return this.performUpload({
          buffer,
          filename,
          mimeType,
          folder,
          alt,
          title,
          contentType,
          skipProcessing,
          organizationId,
          context,
          repo,
        });
      });

      this.log('info', 'Media uploaded', {
        id: (media as any)._id,
        folder: media.folder,
        size: media.size
      });

      // Emit after:upload event
      const resultEvent: EventResult<UploadInput, IMediaDocument> = {
        context: eventCtx,
        result: media,
        timestamp: new Date()
      };
      this.emit('after:upload', resultEvent);

      return media;
    } catch (error) {
      // Emit error:upload event
      const errorEvent: EventError<UploadInput> = {
        context: eventCtx,
        error: error as Error,
        timestamp: new Date()
      };
      this.emit('error:upload', errorEvent);
      throw error;
    }
  }

  /**
   * Internal upload implementation (runs within semaphore)
   */
  private async performUpload(params: {
    buffer: Buffer;
    filename: string;
    mimeType: string;
    folder?: string;
    alt?: string;
    title?: string;
    contentType?: string;
    skipProcessing?: boolean;
    organizationId?: string | import('mongoose').Types.ObjectId;
    context?: OperationContext;
    repo: MediaRepository;
  }): Promise<IMediaDocument> {
    const {
      buffer,
      filename,
      mimeType,
      folder,
      title,
      contentType,
      skipProcessing,
      organizationId,
      context,
      repo,
    } = params;
    let { alt } = params;

    // Generate alt text if not provided and image
    if (!alt && isImage(mimeType)) {
      const generateAltConfig = this.config.processing?.generateAlt;
      if (generateAltConfig) {
        const enabled = typeof generateAltConfig === 'boolean'
          ? generateAltConfig
          : generateAltConfig.enabled;

        if (enabled) {
          alt = generateAltText(filename);
          if (this.logger?.debug) {
            this.logger.debug('Generated alt text', { filename, alt });
          }
        }
      }
    }

    // Normalize folder
    const targetFolder = normalizeFolderPath(folder || this.config.folders?.defaultFolder || 'general');
    const baseFolder = extractBaseFolder(targetFolder);

    // Validate folder
    const baseFolders = this.config.folders?.baseFolders || [];
    if (baseFolders.length > 0 && !isValidFolder(targetFolder, baseFolders)) {
      throw new Error(`Invalid base folder. Allowed: ${baseFolders.join(', ')}`);
    }

    // Process image if applicable
    let finalBuffer = buffer;
    let finalMimeType = mimeType;
    let finalFilename = filename;
    let dimensions: { width: number; height: number } | undefined;
    const variants: GeneratedVariant[] = [];

    const shouldProcess = !skipProcessing
      && this.config.processing?.enabled
      && this.processor
      && isImage(mimeType);

    if (shouldProcess && this.processor) {
      const effectiveContentType = contentType || this.getContentType(targetFolder);
      const aspectRatio = this.getAspectRatio(effectiveContentType);

      const processOpts: ProcessingOptions = {
        maxWidth: this.config.processing?.maxWidth,
        quality: this.config.processing?.quality,
        format: this.config.processing?.format === 'original'
          ? undefined
          : this.config.processing?.format,
        aspectRatio,
      };

      try {
        const processed = await this.processor.process(buffer, processOpts);
        finalBuffer = processed.buffer;
        finalMimeType = processed.mimeType;
        dimensions = { width: processed.width, height: processed.height };

        // Update filename extension if format changed
        if (finalMimeType !== mimeType) {
          finalFilename = updateFilenameExtension(filename, finalMimeType);
        }

        // Generate and upload size variants sequentially (memory-efficient)
        const sizeVariants = this.config.processing?.sizes;
        if (sizeVariants && sizeVariants.length > 0) {
          for (const variant of sizeVariants) {
            // Process one variant at a time to reduce memory usage
            const [variantResult] = await this.processor.generateVariants(
              buffer,
              [variant],
              processOpts
            );

            // Upload immediately after processing (don't hold all buffers in memory)
            const baseFilename = finalFilename.replace(/\.[^.]+$/, '');
            const variantFilename = updateFilenameExtension(
              `${baseFilename}-${variant.name}`,
              variantResult.mimeType
            );

            const uploadResult = await this.provider.upload(
              variantResult.buffer,
              variantFilename,
              {
                folder: targetFolder,
                contentType: effectiveContentType,
                organizationId: organizationId as string,
              }
            );

            variants.push({
              name: variant.name,
              url: uploadResult.url,
              key: uploadResult.key,
              size: uploadResult.size,
              width: variantResult.width,
              height: variantResult.height,
            });
          }

          this.log('info', 'Generated size variants', {
            filename,
            variants: variants.map(v => v.name)
          });
        }
      } catch (err) {
        this.log('warn', 'Image processing failed, uploading original', {
          filename,
          error: (err as Error).message
        });
      }
    }

    // Upload main file to storage
    const result = await this.provider.upload(finalBuffer, finalFilename, {
      folder: targetFolder,
      contentType: contentType || this.getContentType(targetFolder),
      organizationId: organizationId as string,
    });

    // If dimensions not set from processing, try to get them
    if (!dimensions && isImage(mimeType) && this.processor) {
      try {
        dimensions = await this.processor.getDimensions(buffer);
      } catch {
        // Ignore
      }
    }

    // Create database record using mongokit repository
    const media = await repo.createMedia({
      filename: finalFilename.split('/').pop() || finalFilename,
      originalName: filename,
      mimeType: finalMimeType,
      size: result.size,
      url: result.url,
      key: result.key,
      baseFolder,
      folder: targetFolder,
      alt,
      title,
      dimensions,
      variants: variants.length > 0 ? variants : undefined,
    }, context);

    return media;
  }

  /**
   * Upload multiple files
   */
  async uploadMany(inputs: UploadInput[], context?: OperationContext): Promise<IMediaDocument[]> {
    const results = await Promise.all(
      inputs.map(input => this.upload(input, context))
    );
    return results;
  }

  /**
   * Get media by ID
   */
  async getById(id: string, context?: OperationContext): Promise<IMediaDocument | null> {
    return this.repository.getMediaById(id, context);
  }

  /**
   * Get all media with smart pagination
   * Auto-detects offset (page) vs keyset (cursor) based on params
   */
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
    context?: OperationContext
  ): Promise<OffsetPaginationResult<IMediaDocument> | KeysetPaginationResult<IMediaDocument>> {
    return this.repository.getAllMedia(params, context);
  }

  /**
   * Delete single file
   */
  async delete(id: string, context?: OperationContext): Promise<boolean> {
    const repo = this.repository;

    // Get media to find storage key
    const media = await repo.getMediaById(id, context);
    if (!media) {
      return false;
    }

    // Delete main file from storage
    try {
      await this.provider.delete(media.key);
    } catch (err) {
      this.log('warn', 'Failed to delete main file from storage', {
        id,
        key: media.key,
        error: (err as Error).message
      });
    }

    // Delete all size variants from storage
    if (media.variants && media.variants.length > 0) {
      const variantDeletions = media.variants.map(async (variant) => {
        try {
          await this.provider.delete(variant.key);
        } catch (err) {
          this.log('warn', 'Failed to delete variant from storage', {
            id,
            variant: variant.name,
            key: variant.key,
            error: (err as Error).message
          });
        }
      });

      await Promise.all(variantDeletions);

      this.log('info', 'Deleted variants', {
        id,
        count: media.variants.length
      });
    }

    // Delete from database
    const deleted = await repo.deleteMedia(id, context);

    if (deleted) {
      this.log('info', 'Media deleted', { id });
    }

    return deleted;
  }

  /**
   * Delete multiple files
   */
  async deleteMany(ids: string[], context?: OperationContext): Promise<BulkResult> {
    const result: BulkResult = { success: [], failed: [] };

    for (const id of ids) {
      try {
        const deleted = await this.delete(id, context);
        if (deleted) {
          result.success.push(id);
        } else {
          result.failed.push({ id, reason: 'Not found' });
        }
      } catch (err) {
        result.failed.push({ id, reason: (err as Error).message });
      }
    }

    return result;
  }

  /**
   * Move files to different folder
   */
  async move(
    ids: string[], 
    targetFolder: string, 
    context?: OperationContext
  ): Promise<{ modifiedCount: number }> {
    const repo = this.repository;
    const folder = normalizeFolderPath(targetFolder);
    
    // Validate folder
    const baseFolders = this.config.folders?.baseFolders || [];
    if (baseFolders.length > 0 && !isValidFolder(folder, baseFolders)) {
      throw new Error(`Invalid base folder. Allowed: ${baseFolders.join(', ')}`);
    }

    return repo.moveToFolder(ids, folder, context);
  }

  /**
   * Get folder tree
   */
  async getFolderTree(context?: OperationContext): Promise<FolderTree> {
    return this.repository.getFolderTree(context);
  }

  /**
   * Get folder stats
   */
  async getFolderStats(folder: string, context?: OperationContext): Promise<FolderStats> {
    return this.repository.getFolderStats(folder, context);
  }

  /**
   * Get breadcrumb
   */
  getBreadcrumb(folder: string): BreadcrumbItem[] {
    return this.repository.getBreadcrumb(folder);
  }

  /**
   * Delete folder (all files in folder)
   */
  async deleteFolder(folder: string, context?: OperationContext): Promise<BulkResult> {
    const repo = this.repository;
    const files = await repo.getFilesInFolder(folder, context);

    const result: BulkResult = { success: [], failed: [] };

    // Delete each file (main + variants)
    for (const file of files) {
      try {
        // Delete main file
        await this.provider.delete(file.key);

        // Delete all variants
        if (file.variants && file.variants.length > 0) {
          await Promise.all(
            file.variants.map((variant) =>
              this.provider.delete(variant.key).catch((err) => {
                this.log('warn', 'Failed to delete variant in folder deletion', {
                  folder,
                  fileId: (file as any)._id.toString(),
                  variant: variant.name,
                  error: (err as Error).message
                });
              })
            )
          );
        }

        result.success.push((file as any)._id.toString());
      } catch (err) {
        result.failed.push({
          id: (file as any)._id.toString(),
          reason: (err as Error).message
        });
      }
    }

    // Bulk delete from database
    const successIds = result.success;
    if (successIds.length > 0) {
      await repo.deleteManyMedia(successIds, context);
    }

    this.log('info', 'Folder deleted', {
      folder,
      deleted: result.success.length,
      failed: result.failed.length
    });

    return result;
  }
}

/**
 * Create media kit instance
 */
export function createMedia(config: MediaKitConfig): MediaKit {
  return new MediaKitImpl(config);
}

export default createMedia;
