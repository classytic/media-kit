/**
 * @classytic/media-kit
 * 
 * Production-grade media management for Mongoose with pluggable storage providers.
 * 
 * @example
 * ```ts
 * import { createMedia, createMediaSchema } from '@classytic/media-kit';
 * import { S3Provider } from '@classytic/media-kit/providers/s3';
 * import mongoose from 'mongoose';
 * 
 * // Create media kit
 * const media = createMedia({
 *   provider: new S3Provider({
 *     bucket: 'my-bucket',
 *     region: 'us-east-1',
 *   }),
 *   folders: {
 *     baseFolders: ['products', 'users', 'posts'],
 *   },
 *   processing: {
 *     format: 'webp',
 *     quality: 80,
 *   },
 * });
 * 
 * // Create model and initialize
 * const Media = mongoose.model('Media', media.schema);
 * media.init(Media);
 * 
 * // Upload file
 * const uploaded = await media.upload({
 *   buffer,
 *   filename: 'photo.jpg',
 *   mimeType: 'image/jpeg',
 *   folder: 'products/featured',
 * });
 * ```
 * 
 * @packageDocumentation
 */

// Main factory
export { createMedia } from './media';

// Schema
export { createMediaSchema, MediaSchema, DEFAULT_BASE_FOLDERS } from './schema/media.schema';
export type { MediaSchemaOptions } from './schema/media.schema';

// Repository
export { createMediaRepository, MediaRepository } from './repository/media.repository';
export type { MediaRepositoryOptions } from './repository/media.repository';

// Processing
export { ImageProcessor, createImageProcessor } from './processing/image';

// Utilities
export * from './utils/folders';
export * from './utils/mime';
export * from './utils/hash';
export * from './utils/alt-text';

// Types
export type {
  // Storage
  StorageProvider,
  UploadResult,
  UploadOptions,
  
  // Processing
  AspectRatioPreset,
  ProcessingConfig,
  ProcessingOptions,
  ProcessedImage,
  ImageProcessor as IImageProcessor,
  
  // Documents
  IMedia,
  IMediaDocument,
  MediaModel,
  
  // Configuration
  MediaKitConfig,
  FileTypesConfig,
  FolderConfig,
  MultiTenancyConfig,
  Logger,
  
  // Operations
  OperationContext,
  UploadInput,
  BulkResult,
  
  // Folder
  FolderNode,
  FolderTree,
  BreadcrumbItem,
  FolderStats,
  
  // Main
  MediaKit,
} from './types';
