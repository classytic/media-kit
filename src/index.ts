/**
 * @classytic/media-kit
 * 
 * Production-grade media management for Mongoose powered by @classytic/mongokit.
 * Features pluggable storage providers, smart pagination, and full TypeScript support.
 * 
 * @example
 * ```ts
 * import { createMedia, createMediaSchema } from '@classytic/media-kit';
 * import { S3Provider } from '@classytic/media-kit/providers/s3';
 * import { cachePlugin, createMemoryCache } from '@classytic/mongokit';
 * import mongoose from 'mongoose';
 * 
 * // Create media kit with mongokit plugins
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
 *   // Mongokit cache plugin
 *   plugins: [
 *     cachePlugin({ adapter: createMemoryCache() })
 *   ],
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
 * 
 * // Smart pagination (mongokit-powered)
 * const page1 = await media.getAll({ page: 1, limit: 20 });
 * const stream = await media.getAll({ sort: { createdAt: -1 }, limit: 50 });
 * const next = await media.getAll({ after: stream.next, sort: { createdAt: -1 } });
 * 
 * // Direct repository access for advanced queries
 * const stats = await media.repository.getStorageByFolder();
 * ```
 * 
 * @packageDocumentation
 */

// Main factory
export { createMedia } from './media';

// Schema
export { createMediaSchema, MediaSchema, DEFAULT_BASE_FOLDERS } from './schema/media.schema';
export type { MediaSchemaOptions } from './schema/media.schema';

// Repository (extends mongokit Repository)
export { createMediaRepository, MediaRepository } from './repository/media.repository';
export type { MediaRepositoryOptions, FolderAggregateResult } from './repository/media.repository';

// Processing
export { ImageProcessor, createImageProcessor } from './processing/image';

// Utilities
export * from './utils/folders';
export * from './utils/mime';
export * from './utils/hash';
export * from './utils/alt-text';

// Types - Media Kit specific
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
  SizeVariant,
  GeneratedVariant,
  AltGenerationConfig,
  
  // Documents
  IMedia,
  IMediaDocument,
  MediaModel,
  ExifMetadata,
  VideoMetadata,
  
  // Configuration
  MediaKitConfig,
  FileTypesConfig,
  FolderConfig,
  MultiTenancyConfig,
  FieldAccessConfig,
  DeduplicationConfig,
  MediaKitLogger,
  
  // Operations
  OperationContext,
  UploadInput,
  BulkResult,
  
  // Folder
  FolderNode,
  FolderTree,
  BreadcrumbItem,
  FolderStats,
  
  // Events
  MediaEventName,
  EventContext,
  EventResult,
  EventError,
  EventListener,
  EventEmitter,
  
  // Main
  MediaKit,
} from './types';

// Re-export mongokit types for convenience
export type {
  // Pagination
  PaginationConfig,
  OffsetPaginationResult,
  KeysetPaginationResult,
  AggregatePaginationResult,
  PaginationResult,
  SortSpec,
  SortDirection,
  PopulateSpec,
  SelectSpec,
  
  // Plugins
  Plugin,
  PluginFunction,
  PluginType,
  
  // Cache
  CacheAdapter,
  CacheOptions,
  CacheOperationOptions,
  
  // Repository
  RepositoryContext,
  RepositoryEvent,
  EventPayload,
  OperationOptions,
  CreateOptions,
  UpdateOptions,
  DeleteResult,
  
  // Error
  HttpError,
} from './types';
