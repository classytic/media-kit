/**
 * @classytic/media-kit v2.1.0
 *
 * Production-grade media management for Mongoose powered by @classytic/mongokit.
 * Features pluggable storage drivers, status lifecycle, focal points, soft deletes,
 * asset transforms, smart pagination, and full TypeScript support.
 *
 * @example
 * ```ts
 * import { createMedia, createMediaSchema } from '@classytic/media-kit';
 * import { S3Provider } from '@classytic/media-kit/providers/s3';
 * import mongoose from 'mongoose';
 *
 * const media = createMedia({
 *   driver: new S3Provider({ bucket: 'my-bucket', region: 'us-east-1' }),
 *   folders: { defaultFolder: 'general' },
 *   processing: { format: 'original', quality: { jpeg: 82, webp: 82, avif: 50, png: 100 } },
 * });
 *
 * const Media = mongoose.model('Media', media.schema);
 * media.init(Media);
 *
 * const uploaded = await media.upload({
 *   buffer, filename: 'photo.jpg', mimeType: 'image/jpeg',
 *   folder: 'products/featured',
 * });
 * ```
 *
 * @packageDocumentation
 */

// Main factory
export { createMedia } from './media';

// Configuration
export { DEFAULT_CONFIG, mergeConfig } from './config';

// Schema
export { createMediaSchema, MediaSchema } from './schema/media.schema';
export type { MediaSchemaOptions } from './schema/media.schema';

// Repository (extends mongokit Repository)
export { createMediaRepository, MediaRepository } from './repository/media.repository';
export type { MediaRepositoryOptions, FolderAggregateResult } from './repository/media.repository';

// Events (awaitable)
export { MediaEventEmitter } from './events';

// Processing
export { ImageProcessor, createImageProcessor } from './processing/image';
export { calculateFocalPointCrop, isValidFocalPoint, DEFAULT_FOCAL_POINT } from './processing/focal-point';
export { generateThumbHash } from './processing/thumbhash';
export { DEVICE_WIDTHS, COMPACT_WIDTHS, IMAGE_WIDTHS, generateResponsiveVariants, resolvePresetWidths, PROCESSING_PRESETS, resolveProcessingPreset } from './processing/presets';

// Utilities
export * from './utils/folders';
export * from './utils/mime';
export * from './utils/hash';
export * from './utils/alt-text';

// Types — Storage Driver
export type {
  StorageDriver,
  WriteResult,
  FileStat,
  PresignedUploadResult,
} from './types';

// Types — Processing
export type {
  AspectRatioPreset,
  ProcessingConfig,
  ProcessingPresetName,
  OriginalHandling,
  ProcessingOptions,
  ProcessedImage,
  ImageAdapter,
  ImageProcessor as IImageProcessor,
  QualityMap,
  SizeVariant,
  GeneratedVariant,
  AltGenerationConfig,
  FocalPoint,
  SharpOptions,
  VideoAdapter,
  RawAdapter,
  MediaCacheConfig,
} from './types';

// Re-export QueryParser from mongokit for convenience
export { QueryParser } from '@classytic/mongokit';
export type { ParsedQuery, QueryParserOptions } from '@classytic/mongokit';

// Types — Documents
export type {
  IMedia,
  IMediaDocument,
  MediaModel,
  MediaStatus,
  ExifMetadata,
} from './types';

// Types — Configuration
export type {
  MediaKitConfig,
  FileTypesConfig,
  FolderConfig,
  MultiTenancyConfig,
  DeduplicationConfig,
  SoftDeleteConfig,
  ConcurrencyConfig,
  MediaKitLogger,
} from './types';

// Types — Operations
export type {
  OperationContext,
  UploadInput,
  ConfirmUploadInput,
  ImportOptions,
  BulkResult,
  RewriteResult,
  InitiateMultipartInput,
  CompleteMultipartInput,
  MultipartUploadSession,
  ResumableUploadSession,
  SignedPartResult,
  CompletedPart,
  HashStrategy,
  BatchPresignInput,
  BatchPresignResult,
} from './types';

// Types — Folder
export type {
  FolderNode,
  FolderTree,
  BreadcrumbItem,
  FolderStats,
} from './types';

// Types — Events
export type {
  MediaEventName,
  EventContext,
  EventResult,
  EventError,
  ProgressEvent,
  EventListener,
  Unsubscribe,
} from './types';

// Types — Transforms
export type {
  TransformParams,
  TransformRequest,
  TransformResponse,
  TransformCache,
} from './types';

// Types — Main
export type { MediaKit } from './types';

// Re-export mongokit types for convenience
export type {
  PaginationConfig,
  OffsetPaginationResult,
  KeysetPaginationResult,
  AggregatePaginationResult,
  PaginationResult,
  SortSpec,
  SortDirection,
  PopulateSpec,
  SelectSpec,
  Plugin,
  PluginFunction,
  PluginType,
  CacheAdapter,
  CacheOptions,
  CacheOperationOptions,
  RepositoryContext,
  RepositoryEvent,
  EventPayload,
  OperationOptions,
  CreateOptions,
  UpdateOptions,
  DeleteResult,
  HttpError,
} from './types';
