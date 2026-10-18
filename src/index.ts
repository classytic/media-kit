/**
 * @classytic/media-kit
 *
 * Production-grade media management for Mongoose powered by @classytic/mongokit.
 * Engine-factory pattern — package owns its models, exposes repository as the API surface,
 * emits events via arc-compatible EventTransport.
 *
 * @example
 * ```ts
 * import { defineMedia } from '@classytic/media-kit';
 * import { S3Provider } from '@classytic/media-kit/providers/s3';
 * import mongoose from 'mongoose';
 *
 * const engine = await defineMedia({
 *   tenant: { enabled: true, fieldType: 'objectId', required: true },
 *   softDelete: { enabled: true, ttlDays: 30 },
 *   processing: { enabled: true, format: 'webp', quality: 80 },
 * }).bind(mongoose.connection, {
 *   driver: new S3Provider({ bucket: 'my-bucket', region: 'us-east-1' }),
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
 * // .bind(connection, { ..., eventTransport: redisTransport })
 * ```
 *
 * @packageDocumentation
 */

// ── Engine construction (defineMedia → bind) ─────────────────
export { defineMedia } from './engine/define-media.js';
export type { MediaBlueprint } from './engine/define-media.js';
export type {
  MediaShape,
  MediaRuntime,
  MediaEngine,
  ResolvedMediaConfig,
  MediaContext,
} from './engine/engine-types.js';

// ── Repository (API surface) ─────────────────────────────────
export { MediaRepository, STALE_PENDING_MAX_AGE_MS } from './repositories/media.repository.js';
export type { MediaRepositoryDeps } from './repositories/media.repository.js';
export { createMediaRepositories } from './repositories/create-repositories.js';
export type { MediaRepositories, CreateRepositoriesDeps } from './repositories/create-repositories.js';
export type { UploadManyResult } from './repositories/verbs/upload.verbs.js';

// ── Models ───────────────────────────────────────────────────
export { defineMediaModels } from './models/create-models.js';
export type { MediaModels, DefineMediaModelsConfig } from './models/create-models.js';
export { buildMediaSchema } from './models/media.schema.js';
export type { MediaSchemaConfig } from './models/media.schema.js';
export { resolveMediaTenant, injectTenantField } from './models/inject-tenant.js';
export type { MediaTenantInput } from './models/inject-tenant.js';

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
export type { DomainEvent, EventHandler, EventTransport } from '@classytic/primitives/events';
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
  AssetExternalRegisteredPayload,
  AssetPurgedPayload,
  AssetTaggedPayload,
  AssetUntaggedPayload,
  FocalPointSetPayload,
  FolderRenamedPayload,
  FolderDeletedPayload,
  UploadConfirmedPayload,
  MultipartCompletedPayload,
  BatchDeletedPayload,
  AssetsExpiredPayload,
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
export { withMediaCascade } from './utils/cascade.js';
export type { MediaCascadeOptions } from './utils/cascade.js';

// ── Driver Registry (multi-provider) ────────────────────────
export { DriverRegistry } from './providers/driver-registry.js';

// ── URL Signing (also available standalone via ./signing) ───
export { createUrlSigner } from './signing/index.js';
export type {
  UrlSigner,
  UrlSignerOptions,
  SignUrlInput,
  SignUrlResult,
  VerifyUrlInput,
  VerifyUrlResult,
  VerifyFailureReason,
} from './signing/index.js';
export { resolveVisibility } from './utils/visibility.js';

// ── External (reference-only) media ─────────────────────────
export { EXTERNAL_PROVIDER, EXTERNAL_KEY_PREFIX, isExternalMedia, buildExternalKey } from './utils/external.js';

// ── Types — Storage Driver ───────────────────────────────────
export type {
  StorageDriver,
  StorageWriteOptions,
  WriteResult,
  FileStat,
  PresignedUploadResult,
  SignedReadOptions,
} from './types/storage.js';

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
} from './types/processing.js';

// ── Types — Documents ───────────────────────────────────────
export type {
  IMedia,
  IMediaDocument,
  MediaModel,
  MediaStatus,
  MediaVisibility,
  ExifMetadata,
} from './types/media.js';

// ── Types — Configuration sub-interfaces ────────────────────
export type {
  FileTypesConfig,
  FolderConfig,
  DeduplicationConfig,
  SoftDeleteConfig,
  ConcurrencyConfig,
  MediaKitLogger,
  VisibilityConfig,
  MediaSigningConfig,
  ServeAuthorize,
  ExternalMediaConfig,
  RegisterExternalInput,
  ImportOptions,
} from './types/config.js';

// ── Types — Operations ──────────────────────────────────────
export type {
  UploadInput,
  ConfirmUploadInput,
} from './types/uploads.js';
export type {
  InitiateMultipartInput,
  CompleteMultipartInput,
  MultipartUploadSession,
  ResumableUploadSession,
  SignedPartResult,
  CompletedPart,
  HashStrategy,
  BatchPresignInput,
  BatchPresignResult,
} from './types/storage.js';

// ── Types — Folder ──────────────────────────────────────────
export type {
  FolderNode,
  FolderTree,
  BreadcrumbItem,
  FolderStats,
  BulkResult,
  RewriteResult,
} from './types/folders.js';

// ── Types — Transforms ──────────────────────────────────────
export type {
  TransformParams,
  TransformRequest,
  TransformResponse,
  TransformCache,
} from './types/transforms.js';

// ── Re-export mongokit types for convenience ────────────────
export { QueryParser } from '@classytic/mongokit';
// Repo-core-owned types — sourced from repo-core directly. Mongokit 3.12
// dropped its re-exports of these to keep one canonical home; the union
// type formerly known as `PaginationResult` is now `AnyPaginationResult`.
export type { HttpError } from '@classytic/repo-core/errors';
// media-kit's wire error codes (typed `HttpError` refusals carry one on `code`).
export { MEDIA_ERROR_CODES } from './errors.js';
export type { MediaErrorCode } from './errors.js';
export type {
  AggregatePaginationResult,
  AnyPaginationResult as PaginationResult,
  KeysetPaginationResult,
  OffsetPaginationResult,
} from '@classytic/repo-core/pagination';
// Mongokit-owned types.
export type {
  CacheAdapter,
  CacheOperationOptions,
  CacheOptions,
  CreateOptions,
  DeleteResult,
  EventPayload,
  OperationOptions,
  PaginationConfig,
  ParsedQuery,
  Plugin,
  PluginFunction,
  PluginType,
  PopulateSpec,
  QueryParserOptions,
  RepositoryContext,
  RepositoryEvent,
  SelectSpec,
  SortDirection,
  SortSpec,
  UpdateOptions,
} from '@classytic/mongokit';

/**
 * Client-produced derivatives — presigning them and admitting them safely.
 * Exported so a host route can offer the sizes its transform policy asked for.
 */
export {
  assertDerivativeKey,
  derivativeKey,
  sanitizeDerivativeName,
  signDerivativeUploads,
  toStoredVariants,
} from './operations/derivatives.js';
export type {
  ClientVariantInput,
  DerivativeUploadRequest,
  DerivativeUploadTarget,
} from './operations/derivatives.js';
