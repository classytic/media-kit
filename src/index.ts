/**
 * @classytic/media-kit v3.0.0
 *
 * Production-grade media management for Mongoose powered by @classytic/mongokit.
 * Engine-factory pattern — package owns its models, exposes repository as the API surface,
 * emits events via arc-compatible EventTransport.
 *
 * @example
 * ```ts
 * import { createMedia } from '@classytic/media-kit';
 * import { S3Provider } from '@classytic/media-kit/providers/s3';
 * import mongoose from 'mongoose';
 *
 * const engine = await createMedia({
 *   connection: mongoose.connection,
 *   driver: new S3Provider({ bucket: 'my-bucket', region: 'us-east-1' }),
 *   tenantFieldType: 'objectId',
 *   multiTenancy: { enabled: true, required: true },
 *   softDelete: { enabled: true, ttlDays: 30 },
 *   processing: { enabled: true, format: 'webp', quality: 80 },
 * });
 *
 * // Repositories ARE the API surface
 * const media = await engine.repositories.media.upload({
 *   buffer, filename: 'photo.jpg', mimeType: 'image/jpeg', folder: 'products',
 * }, { organizationId: 'org_123', userId: 'user_456' });
 *
 * // Subscribe to events (glob patterns supported)
 * await engine.events.subscribe('media:asset.*', async (event) => {
 *   console.log(event.type, event.payload);
 * });
 *
 * // Arc integration: drop in any @classytic/arc EventTransport
 * // const engine = await createMedia({ ..., eventTransport: redisTransport });
 * ```
 *
 * @packageDocumentation
 */

// ── Engine factory ───────────────────────────────────────────
export { createMedia, default } from './engine/create-media.js';
export type {
  MediaConfig,
  MediaEngine,
  ResolvedMediaConfig,
  MediaContext,
} from './engine/engine-types.js';

// ── Repository (API surface) ─────────────────────────────────
export { MediaRepository } from './repositories/media.repository.js';
export type { MediaRepositoryDeps } from './repositories/media.repository.js';
export { createMediaRepositories } from './repositories/create-repositories.js';
export type { MediaRepositories, CreateRepositoriesDeps } from './repositories/create-repositories.js';

// ── Models ───────────────────────────────────────────────────
export { createMediaModels } from './models/create-models.js';
export type { MediaModels } from './models/create-models.js';
export { buildMediaSchema } from './models/media.schema.js';
export type { MediaSchemaConfig } from './models/media.schema.js';
export { tenantFieldDef, DEFAULT_TENANT_CONFIG } from './models/tenant-field.js';
export type { TenantFieldConfig } from './models/tenant-field.js';

// ── Bridges (host-implemented adapters) ──────────────────────
export type {
  MediaBridges,
  SourceBridge,
  SourceRef,
  SourceResolver,
  ScanBridge,
  ScanResult,
  ScanVerdict,
  CdnBridge,
  CdnContext,
  TransformBridge,
  TransformOp,
  TransformOpInput,
  TransformOpOutput,
  TransformOpContext,
} from './bridges/index.js';

// ── Events (arc-compatible) ──────────────────────────────────
export type { DomainEvent, EventHandler, EventTransport } from './events/transport.js';
export { InProcessMediaBus } from './events/in-process-bus.js';
export { MEDIA_EVENTS } from './events/event-constants.js';
export type { MediaEventName } from './events/event-constants.js';
export { createMediaEvent } from './events/helpers.js';
export type {
  AssetUploadedPayload,
  AssetReplacedPayload,
  AssetDeletedPayload,
  AssetSoftDeletedPayload,
  AssetRestoredPayload,
  AssetMovedPayload,
  AssetImportedPayload,
  AssetPurgedPayload,
  AssetTaggedPayload,
  AssetUntaggedPayload,
  FocalPointSetPayload,
  FolderRenamedPayload,
  FolderDeletedPayload,
  UploadConfirmedPayload,
  MultipartCompletedPayload,
  BatchDeletedPayload,
  MediaEventMap,
  TypedMediaEventMap,
} from './events/event-payloads.js';

// ── Processing ───────────────────────────────────────────────
export { ImageProcessor, createImageProcessor } from './processing/image.js';
export { calculateFocalPointCrop, isValidFocalPoint, DEFAULT_FOCAL_POINT } from './processing/focal-point.js';
export { generateThumbHash } from './processing/thumbhash.js';
export {
  DEVICE_WIDTHS,
  COMPACT_WIDTHS,
  IMAGE_WIDTHS,
  generateResponsiveVariants,
  resolvePresetWidths,
  PROCESSING_PRESETS,
  resolveProcessingPreset,
} from './processing/presets.js';

// ── Utilities ────────────────────────────────────────────────
export * from './utils/folders.js';
export * from './utils/mime.js';
export * from './utils/hash.js';
export * from './utils/alt-text.js';

// ── Types — Storage Driver ───────────────────────────────────
export type {
  StorageDriver,
  WriteResult,
  FileStat,
  PresignedUploadResult,
} from './types.js';

// ── Types — Processing ───────────────────────────────────────
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
} from './types.js';

// ── Types — Documents ───────────────────────────────────────
export type {
  IMedia,
  IMediaDocument,
  MediaModel,
  MediaStatus,
  ExifMetadata,
} from './types.js';

// ── Types — Configuration sub-interfaces ────────────────────
export type {
  FileTypesConfig,
  FolderConfig,
  MultiTenancyConfig,
  DeduplicationConfig,
  SoftDeleteConfig,
  ConcurrencyConfig,
  MediaKitLogger,
} from './types.js';

// ── Types — Operations ──────────────────────────────────────
export type {
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
} from './types.js';

// ── Types — Folder ──────────────────────────────────────────
export type {
  FolderNode,
  FolderTree,
  BreadcrumbItem,
  FolderStats,
} from './types.js';

// ── Types — Transforms ──────────────────────────────────────
export type {
  TransformParams,
  TransformRequest,
  TransformResponse,
  TransformCache,
} from './types.js';

// ── Re-export mongokit types for convenience ────────────────
export { QueryParser } from '@classytic/mongokit';
export type { ParsedQuery, QueryParserOptions } from '@classytic/mongokit';
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
} from '@classytic/mongokit';
