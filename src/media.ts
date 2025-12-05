/**
 * Media Kit Factory
 * 
 * Creates a configured media management instance.
 * 
 * @example
 * ```ts
 * import { createMedia } from '@classytic/media-kit';
 * import { S3Provider } from '@classytic/media-kit/providers/s3';
 * import mongoose from 'mongoose';
 * 
 * // 1. Create media kit instance
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
 * });
 * 
 * // 2. Create mongoose model from schema
 * const Media = mongoose.model('Media', media.schema);
 * 
 * // 3. Initialize with model
 * media.init(Media);
 * 
 * // 4. Use it
 * const uploaded = await media.upload({
 *   buffer: fileBuffer,
 *   filename: 'product.jpg',
 *   mimeType: 'image/jpeg',
 *   folder: 'products/featured',
 * });
 * ```
 */

import mongoose, { Model, Schema } from 'mongoose';
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
} from './types';
import { createMediaSchema, DEFAULT_BASE_FOLDERS } from './schema/media.schema';
import { MediaRepository } from './repository/media.repository';
import { ImageProcessor } from './processing/image';
import {
  isAllowedMimeType,
  getMimeType,
  FILE_TYPE_PRESETS,
  isImage
} from './utils/mime';
import { extractBaseFolder, isValidFolder, normalizeFolderPath } from './utils/folders';
import { generateAltText } from './utils/alt-text';
import { computeFileHash } from './utils/hash';
import type {
  MediaEventName,
  EventListener,
  EventContext,
  EventResult,
  EventError,
  GeneratedVariant
} from './types';

/**
 * Default configuration
 */
const DEFAULT_CONFIG: Partial<MediaKitConfig> = {
  fileTypes: {
    allowed: [...FILE_TYPE_PRESETS.all],
    maxSize: 50 * 1024 * 1024, // 50MB
  },
  folders: {
    baseFolders: DEFAULT_BASE_FOLDERS,
    defaultFolder: 'general',
    contentTypeMap: {},
  },
  processing: {
    enabled: true,
    maxWidth: 2048,
    quality: 80,
    format: 'webp',
    aspectRatios: {
      default: { preserveRatio: true },
    },
  },
  multiTenancy: {
    enabled: false,
    field: 'organizationId',
    required: false,
  },
};

/**
 * Media Kit Implementation
 */
class MediaKitImpl implements MediaKit {
  readonly config: MediaKitConfig;
  readonly provider: MediaKitConfig['provider'];
  readonly schema: Schema<IMediaDocument>;
  readonly repository?: unknown;

  private repo: MediaRepository | null = null;
  private processor: ImageProcessor | null = null;
  private model: Model<IMediaDocument> | null = null;
  private logger: MediaKitConfig['logger'];
  private eventListeners: Map<MediaEventName, EventListener[]> = new Map();

  constructor(config: MediaKitConfig) {
    // Merge with defaults
    this.config = {
      ...DEFAULT_CONFIG,
      ...config,
      fileTypes: { ...DEFAULT_CONFIG.fileTypes, ...config.fileTypes },
      folders: { ...DEFAULT_CONFIG.folders, ...config.folders },
      processing: { ...DEFAULT_CONFIG.processing, ...config.processing },
      multiTenancy: { ...DEFAULT_CONFIG.multiTenancy, ...config.multiTenancy },
    } as MediaKitConfig;

    this.provider = config.provider;
    this.logger = config.logger;

    // Create schema
    this.schema = createMediaSchema({
      baseFolders: this.config.folders?.baseFolders,
      multiTenancy: this.config.multiTenancy,
    });

    // Initialize processor
    if (this.config.processing?.enabled) {
      try {
        this.processor = new ImageProcessor();
      } catch {
        if (!this.config.suppressWarnings) {
          this.log('warn', 'Image processing disabled: sharp not available. Install with: npm install sharp');
        }
      }
    }
  }

  /**
   * Initialize with mongoose model
   */
  init(model: Model<IMediaDocument>): this {
    this.model = model;
    this.repo = new MediaRepository(model, {
      multiTenancy: this.config.multiTenancy,
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
   * Get repository (throws if not initialized)
   */
  private getRepo(): MediaRepository {
    if (!this.repo) {
      throw new Error('MediaKit not initialized. Call media.init(Model) first.');
    }
    return this.repo;
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

    if (!organizationId) {
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
   * Upload single file
   */
  async upload(input: UploadInput, context?: OperationContext): Promise<IMediaDocument> {
    const repo = this.getRepo();
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
      // Validate
      this.validateFile(buffer, filename, mimeType);

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

          // Generate size variants if configured
          const sizeVariants = this.config.processing?.sizes;
          if (sizeVariants && sizeVariants.length > 0) {
            const variantResults = await this.processor.generateVariants(
              buffer,
              sizeVariants,
              processOpts
            );

            // Upload each variant
            for (let i = 0; i < sizeVariants.length; i++) {
              const variant = sizeVariants[i];
              const variantResult = variantResults[i];
              const variantFilename = `${filename.replace(/\.[^.]+$/, '')}-${variant.name}${filename.match(/\.[^.]+$/)?.[0] || ''}`;

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
      const result = await this.provider.upload(finalBuffer, filename, {
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

      // Create database record
      const media = await repo.create({
        filename: filename.split('/').pop() || filename,
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

      this.log('info', 'Media uploaded', {
        id: (media as any)._id,
        folder: targetFolder,
        size: result.size
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
   * Upload multiple files
   */
  async uploadMany(inputs: UploadInput[], context?: OperationContext): Promise<IMediaDocument[]> {
    const results = await Promise.all(
      inputs.map(input => this.upload(input, context))
    );
    return results;
  }

  /**
   * Delete single file
   */
  async delete(id: string, context?: OperationContext): Promise<boolean> {
    const repo = this.getRepo();

    // Get media to find storage key
    const media = await repo.getById(id, context);
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
    const deleted = await repo.delete(id, context);

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
    const repo = this.getRepo();
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
    return this.getRepo().getFolderTree(context);
  }

  /**
   * Get folder stats
   */
  async getFolderStats(folder: string, context?: OperationContext): Promise<FolderStats> {
    return this.getRepo().getFolderStats(folder, context);
  }

  /**
   * Get breadcrumb
   */
  getBreadcrumb(folder: string): BreadcrumbItem[] {
    return this.getRepo().getBreadcrumb(folder);
  }

  /**
   * Delete folder (all files in folder)
   */
  async deleteFolder(folder: string, context?: OperationContext): Promise<BulkResult> {
    const repo = this.getRepo();
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
      await repo.deleteMany(successIds, context);
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
export function createMedia(config: MediaKitConfig): MediaKit & { init: (model: Model<IMediaDocument>) => MediaKit } {
  return new MediaKitImpl(config);
}

export default createMedia;
