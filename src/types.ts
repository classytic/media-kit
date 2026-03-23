/**
 * @classytic/media-kit v2.1.0 - Type Definitions
 *
 * Production-grade media management types.
 * Inspired by Directus, Payload CMS, and Strapi patterns.
 * Re-exports relevant mongokit types for convenience.
 */

import type { Document, Schema, Model, Types } from 'mongoose';
import type { MediaRepository } from './repository/media.repository';

// Re-export mongokit types for consumers
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

  // Repository
  RepositoryContext,
  RepositoryEvent,
  EventPayload,

  // Plugins
  Plugin,
  PluginFunction,
  PluginType,

  // Cache
  CacheAdapter,
  CacheOptions,
  CacheOperationOptions,

  // Operations
  OperationOptions,
  CreateOptions,
  UpdateOptions,
  DeleteResult,

  // Error
  HttpError,

  // Query
  QueryParser,
  QueryParserOptions,
  ParsedQuery,
} from '@classytic/mongokit';

// ============================================
// STORAGE DRIVER TYPES (Directus-inspired)
// ============================================

/**
 * Result from storage write operation
 */
export interface WriteResult {
  /** Storage key/path */
  key: string;
  /** Public URL to access the file */
  url: string;
  /** Final file size in bytes */
  size: number;
}

/**
 * File stat from storage driver
 */
export interface FileStat {
  /** File size in bytes */
  size: number;
  /** MIME type */
  contentType: string;
  /** Last modified timestamp */
  lastModified?: Date;
  /** Entity tag (for cache validation) */
  etag?: string;
  /** Custom metadata key-value pairs */
  metadata?: Record<string, string>;
}

/**
 * Result from a presigned upload URL generation
 */
export interface PresignedUploadResult {
  /** The presigned URL to PUT the file to */
  uploadUrl: string;
  /** Storage key assigned to the file */
  key: string;
  /** Public URL where the file will be accessible after upload */
  publicUrl: string;
  /** Time in seconds until the presigned URL expires */
  expiresIn: number;
  /** Optional headers the client must include with the PUT request */
  headers?: Record<string, string>;
}

/**
 * Storage driver interface (Directus-inspired)
 *
 * Implement this for custom storage backends. Core methods are required;
 * optional methods enable advanced features (presigned uploads, streaming, etc.)
 */
export interface StorageDriver {
  /** Driver name (e.g., 's3', 'gcs', 'local') */
  readonly name: string;

  // --- Core (required) ---

  /** Write data to storage. Accepts Buffer or ReadableStream. */
  write(key: string, data: Buffer | NodeJS.ReadableStream, contentType: string): Promise<WriteResult>;

  /** Read a file as a stream. Supports optional byte-range for partial reads. */
  read(key: string, range?: { start: number; end: number }): Promise<NodeJS.ReadableStream>;

  /** Delete a file by key */
  delete(key: string): Promise<boolean>;

  /** Check if a file exists */
  exists(key: string): Promise<boolean>;

  /** Get file metadata without downloading */
  stat(key: string): Promise<FileStat>;

  // --- Navigation (optional) ---

  /** List files under a prefix (async generator for memory efficiency) */
  list?(prefix: string): AsyncIterable<string>;

  /** Copy a file to a new location within the same bucket */
  copy?(source: string, destination: string): Promise<WriteResult>;

  /** Move a file to a new location (copy + delete) */
  move?(source: string, destination: string): Promise<WriteResult>;

  // --- URLs ---

  /** Build the public URL for a given storage key */
  getPublicUrl(key: string): string;

  /** Get a temporary signed URL for reading a private file */
  getSignedUrl?(key: string, expiresIn?: number): Promise<string>;

  /** Get a presigned URL for direct client-side uploads */
  getSignedUploadUrl?(key: string, contentType: string, expiresIn?: number): Promise<PresignedUploadResult>;

  // --- Multipart Upload (S3-style) ---

  /** Initiate a multipart upload session */
  createMultipartUpload?(key: string, contentType: string): Promise<{ uploadId: string }>;

  /** Generate a presigned URL for uploading a single part */
  signUploadPart?(key: string, uploadId: string, partNumber: number, expiresIn?: number): Promise<SignedPartResult>;

  /** Complete a multipart upload by assembling parts */
  completeMultipartUpload?(key: string, uploadId: string, parts: CompletedPart[]): Promise<{ etag: string; size: number }>;

  /** Abort a multipart upload and clean up uploaded parts */
  abortMultipartUpload?(key: string, uploadId: string): Promise<void>;

  // --- Resumable Upload (GCS-style) ---

  /** Create a resumable upload session (single URI, client pushes chunks via Content-Range) */
  createResumableUpload?(key: string, contentType: string, options?: { size?: number }): Promise<ResumableUploadSession>;

  /** Abort a resumable upload by deleting the session */
  abortResumableUpload?(sessionUri: string): Promise<void>;

  /** Query resumable upload progress (bytes received so far) */
  getResumableUploadStatus?(sessionUri: string): Promise<{ uploadedBytes: number }>;
}

// ============================================
// MULTIPART / RESUMABLE UPLOAD TYPES
// ============================================

/** Hash strategy for confirmUpload() */
export type HashStrategy = 'etag' | 'sha256' | 'skip';

/** Result from signing a single upload part */
export interface SignedPartResult {
  /** Presigned URL for this part */
  uploadUrl: string;
  /** Part number (1-based) */
  partNumber: number;
  /** Required headers for the PUT request */
  headers?: Record<string, string>;
  /** Seconds until URL expires */
  expiresIn: number;
}

/** A completed part (client sends back after uploading) */
export interface CompletedPart {
  /** Part number (1-based) */
  partNumber: number;
  /** ETag returned by storage after part upload */
  etag: string;
}

/** GCS resumable upload session result */
export interface ResumableUploadSession {
  /** Session URI — client sends chunks to this URL with Content-Range headers */
  uploadUrl: string;
  /** Storage key */
  key: string;
  /** Public URL where file will be accessible after completion */
  publicUrl: string;
  /** Recommended minimum chunk size in bytes (256KB for GCS) */
  minChunkSize: number;
  /** Session expiry (GCS sessions last 7 days) */
  expiresAt: Date;
}

/**
 * Multipart upload session info returned to the client.
 * Discriminated union: 'multipart' (S3-style per-part signing) vs 'resumable' (GCS-style single URI).
 */
export interface MultipartUploadSession {
  /** Session type: 'multipart' (S3) or 'resumable' (GCS) */
  type: 'multipart' | 'resumable';
  /** Storage key for the file */
  key: string;
  /** Public URL where the file will be accessible */
  publicUrl: string;

  // --- S3-specific (type='multipart') ---
  /** S3 upload ID */
  uploadId?: string;
  /** Pre-signed part URLs (only if partCount was provided) */
  parts?: SignedPartResult[];

  // --- GCS-specific (type='resumable') ---
  /** Resumable session URI — client sends chunks with Content-Range */
  uploadUrl?: string;
  /** Minimum chunk size in bytes (256KB for GCS, 5MB for S3) */
  minChunkSize?: number;
  /** Session expiry (GCS: 7 days from creation) */
  expiresAt?: Date;
}

/** Input for initiating a multipart upload */
export interface InitiateMultipartInput {
  filename: string;
  contentType: string;
  folder?: string;
  /** Total number of parts (optional — sign all upfront if provided) */
  partCount?: number;
  /** URL expiry for part URLs in seconds (default: 3600) */
  expiresIn?: number;
}

/** Input for completing a multipart upload */
export interface CompleteMultipartInput {
  /** Storage key */
  key: string;
  /** S3 upload ID */
  uploadId: string;
  /** Completed parts with ETags */
  parts: CompletedPart[];
  /** Original filename */
  filename: string;
  /** MIME type */
  mimeType: string;
  /** File size in bytes */
  size: number;
  /** Target folder */
  folder?: string;
  /** Alt text */
  alt?: string;
  /** Title */
  title?: string;
  /** Run post-upload processing (ThumbHash, variants, etc.) */
  process?: boolean;
}

/** Input for batch presigned URL generation */
export interface BatchPresignInput {
  /** Files to generate URLs for */
  files: Array<{
    filename: string;
    contentType: string;
  }>;
  /** Shared folder for all files */
  folder?: string;
  /** URL expiry in seconds (default: 3600) */
  expiresIn?: number;
}

/** Result from batch presigned URL generation */
export interface BatchPresignResult {
  /** Presigned upload results, one per file (same order as input) */
  uploads: PresignedUploadResult[];
}

// ============================================
// IMAGE PROCESSING TYPES
// ============================================

/**
 * Aspect ratio preset configuration
 */
export interface AspectRatioPreset {
  /** Aspect ratio as width/height (e.g., 0.75 for 3:4) */
  aspectRatio?: number;
  /** Sharp fit mode */
  fit?: 'cover' | 'contain' | 'fill' | 'inside' | 'outside';
  /** Preserve original ratio (overrides aspectRatio) */
  preserveRatio?: boolean;
}

/**
 * Focal point for smart cropping (Payload CMS pattern)
 * Values range from 0.0 to 1.0 (normalized coordinates)
 */
export interface FocalPoint {
  /** X position: 0.0 (left) to 1.0 (right). Default 0.5 (center) */
  x: number;
  /** Y position: 0.0 (top) to 1.0 (bottom). Default 0.5 (center) */
  y: number;
}

/**
 * Size variant configuration (e.g., thumbnail, medium, large)
 */
export interface SizeVariant {
  /** Variant name (e.g., 'thumbnail', 'medium', 'large') */
  name: string;
  /** Maximum width in pixels */
  width?: number;
  /** Maximum height in pixels */
  height?: number;
  /** Aspect ratio preset */
  aspectRatio?: AspectRatioPreset;
  /** Output quality (1-100) */
  quality?: number;
  /** Output format (defaults to processing config format) */
  format?: 'webp' | 'jpeg' | 'png' | 'avif' | 'original';
  /** Condition function — skip variant if returns false (Payload pattern) */
  condition?: (original: { width: number; height: number; mimeType: string }) => boolean;
}

/**
 * Generated variant result (stored per-variant in document)
 * Each variant stores its own mimeType + filename (Payload pattern)
 */
export interface GeneratedVariant {
  /** Variant name */
  name: string;
  /** Storage key */
  key: string;
  /** Public URL */
  url: string;
  /** Variant filename (can differ from original) */
  filename: string;
  /** MIME type (can differ from original, e.g., WebP thumbnail for JPEG original) */
  mimeType: string;
  /** File size in bytes */
  size: number;
  /** Width in pixels */
  width?: number;
  /** Height in pixels */
  height?: number;
}

/**
 * Sharp memory optimization options
 */
export interface SharpOptions {
  /** Maximum number of images to process concurrently (default: 2) */
  concurrency?: number;
  /** Enable Sharp's internal cache (default: false) */
  cache?: boolean;
  /** Use mozjpeg encoder for JPEG (better compression, default: true) */
  mozjpeg?: boolean;
  /** Enable smart chroma subsampling for WebP (sharper output, default: true) */
  webpSmartSubsample?: boolean;
  /** AVIF encoding effort 0-9 (higher = slower + smaller, default: 6) */
  avifEffort?: number;
  /** AVIF chroma subsampling (default: '4:2:0' for photos) */
  avifChromaSubsampling?: string;
}

/**
 * Per-format quality settings.
 * AVIF uses lower numbers for equivalent visual quality (~2x more efficient).
 */
export interface QualityMap {
  /** JPEG quality (default: 82) */
  jpeg?: number;
  /** WebP quality (default: 82) */
  webp?: number;
  /** AVIF quality (default: 50, equivalent to JPEG ~85) */
  avif?: number;
  /** PNG compression level mapped from 1-100 (default: 100 = lossless) */
  png?: number;
}

/**
 * Video processing adapter interface.
 * Implement using @classytic/vixel or any ffmpeg wrapper.
 * No ffmpeg is bundled in media-kit — users wire this at the app level.
 */
export interface VideoAdapter {
  /** Extract a thumbnail frame. Returns buffer or null. */
  extractThumbnail(filePath: string, options?: {
    timestamp?: number;
  }): Promise<{
    buffer: Buffer;
    mimeType: string;
    width: number;
    height: number;
  } | null>;
  /** Extract video metadata (duration, codec, resolution). */
  extractMetadata(filePath: string): Promise<{
    duration: number;
    width: number;
    height: number;
    codec?: string;
    fps?: number;
    bitrate?: number;
    audioCodec?: string;
  } | null>;
}

/**
 * RAW image converter adapter.
 * Implement using dcraw, libraw, or a cloud API.
 * No RAW processing is bundled — users wire this at the app level.
 *
 * @example
 * ```ts
 * const rawAdapter: RawAdapter = {
 *   supportedTypes: ['image/x-canon-cr2', 'image/x-nikon-nef', 'image/x-adobe-dng'],
 *   async convert(buffer, mimeType) {
 *     const tiffBuffer = await myDcrawLib.convert(buffer);
 *     return { buffer: tiffBuffer, mimeType: 'image/tiff' };
 *   },
 * };
 * ```
 */
export interface RawAdapter {
  /** Convert RAW buffer to a Sharp-processable format (TIFF/JPEG/PNG) */
  convert(buffer: Buffer, mimeType: string): Promise<{
    buffer: Buffer;
    mimeType: string;
  }>;
  /** MIME types this adapter can handle */
  supportedTypes: string[];
}

/**
 * Cache adapter interface for read-through caching.
 * Compatible with Redis, Memcached, or in-memory stores.
 */
export interface MediaCacheConfig {
  adapter: {
    get(key: string): Promise<string | null>;
    set(key: string, value: string, ttl?: number): Promise<void>;
    del(key: string): Promise<void>;
    clear(pattern: string): Promise<void>;
  };
  /** TTL in seconds for getById cache (default: 60) */
  byIdTtl?: number;
  /** TTL in seconds for list/query cache (default: 30) */
  queryTtl?: number;
  /** Cache key prefix (default: 'mk') */
  prefix?: string;
}

/**
 * Named processing preset.
 * Presets provide sensible defaults for common use cases.
 * User overrides are applied on top of the preset.
 */
export type ProcessingPresetName = 'social-media' | 'web-optimized' | 'high-quality' | 'thumbnail';

/**
 * How to handle the original (unprocessed) image.
 * - 'keep-variant': Store original as '__original' variant (default, backward-compat)
 * - 'replace': Only the processed image is stored (source replaced, no original variant)
 * - 'discard': No original stored, only processed + size variants
 */
export type OriginalHandling = 'keep-variant' | 'replace' | 'discard';

/**
 * Image processing configuration
 */
export interface ProcessingConfig {
  /** Enable image processing (default: true) */
  enabled?: boolean;
  /**
   * Keep untouched original as '__original' variant (default: true)
   * @deprecated Use `originalHandling` instead
   */
  keepOriginal?: boolean;
  /** Control what happens to the original unprocessed image (default: 'keep-variant') */
  originalHandling?: OriginalHandling;
  /** Maximum width for images (default: 4096) */
  maxWidth?: number;
  /** Maximum height for images (default: 4096) */
  maxHeight?: number;
  /** Output quality — single number (1-100) or per-format map */
  quality?: number | QualityMap;
  /** Output format (default: 'original' — preserve source format) */
  format?: 'webp' | 'jpeg' | 'png' | 'avif' | 'original';
  /** Strip EXIF/GPS metadata for privacy, keep ICC profile (default: true) */
  stripMetadata?: boolean;
  /** Auto-orient from EXIF orientation tag (default: true) */
  autoOrient?: boolean;
  /** Generate ThumbHash placeholder on upload (default: true) */
  thumbhash?: boolean;
  /** Extract dominant color hex on upload (default: true) */
  dominantColor?: boolean;
  /** Skip re-compression if image is already optimized (default: true) */
  smartSkip?: boolean;
  /** Aspect ratio presets by content type */
  aspectRatios?: Record<string, AspectRatioPreset>;
  /** Size variants to generate */
  sizes?: SizeVariant[];
  /** Built-in responsive preset: 'nextjs' | 'compact' | 'none' | custom widths */
  responsivePreset?: 'nextjs' | 'compact' | 'none' | number[];
  /** Enable automatic alt text generation */
  generateAlt?: boolean | AltGenerationConfig;
  /** Sharp memory optimization options */
  sharpOptions?: SharpOptions;
  /** Custom image processing adapter. Default: built-in Sharp-based processor. */
  imageAdapter?: ImageAdapter;
  /** Video processing adapter (e.g., @classytic/vixel). No ffmpeg bundled. */
  videoAdapter?: VideoAdapter;
  /** RAW image converter (e.g., dcraw, libraw). No RAW processing bundled. */
  rawAdapter?: RawAdapter;
  /** Apply a built-in processing preset. User overrides win over preset defaults. */
  preset?: ProcessingPresetName;
}

/**
 * Alt text generation configuration
 */
export interface AltGenerationConfig {
  /** Enable auto-generation */
  enabled: boolean;
  /** Strategy: 'filename' (from filename) or 'ai' (AI-based) */
  strategy?: 'filename' | 'ai';
  /** Fallback text if generation fails */
  fallback?: string;
  /** Custom generator function */
  generator?: (filename: string, buffer?: Buffer) => Promise<string> | string;
}

/**
 * Image processing adapter interface.
 * Built-in: Sharp-based ImageProcessor (default when sharp is installed).
 * Users can provide a custom implementation (e.g., Jimp, Squoosh, cloud API).
 */
export interface ImageAdapter {
  /** Process image buffer with given options */
  process(buffer: Buffer, options: ProcessingOptions): Promise<ProcessedImage>;
  /** Check if buffer is a processable image */
  isProcessable(buffer: Buffer, mimeType: string): boolean;
  /** Get image dimensions without processing */
  getDimensions?(buffer: Buffer): Promise<{ width: number; height: number }>;
  /** Generate multiple size variants */
  generateVariants?(
    buffer: Buffer,
    variants: SizeVariant[],
    baseOptions?: Omit<ProcessingOptions, 'maxWidth'>,
  ): Promise<Array<ProcessedImage & { variantName: string }>>;
  /** Extract dominant color as hex (e.g., '#3b82f6') */
  extractDominantColor?(buffer: Buffer): Promise<string | null>;
  /** Check if image is already well-optimized (skip re-compression) */
  isOptimized?(buffer: Buffer, mimeType: string): Promise<boolean>;
  /** Extract image metadata (EXIF, ICC, etc.) */
  extractMetadata?(buffer: Buffer): Promise<Record<string, any>>;
}

/**
 * @deprecated Use ImageAdapter instead. Kept as alias for backward compatibility.
 */
export type ImageProcessor = ImageAdapter;

export interface ProcessingOptions {
  maxWidth?: number;
  maxHeight?: number;
  quality?: number | QualityMap;
  format?: 'webp' | 'jpeg' | 'png' | 'avif';
  aspectRatio?: AspectRatioPreset;
  /** Focal point for smart cropping */
  focalPoint?: FocalPoint;
  /** Strip EXIF/GPS metadata, keep ICC profile */
  stripMetadata?: boolean;
  /** Auto-orient from EXIF orientation tag */
  autoOrient?: boolean;
}

export interface ProcessedImage {
  buffer: Buffer;
  mimeType: string;
  width: number;
  height: number;
}

// ============================================
// MEDIA DOCUMENT TYPES
// ============================================

/**
 * File status lifecycle (Directus/Mux pattern)
 */
export type MediaStatus = 'pending' | 'processing' | 'ready' | 'error';

/**
 * EXIF metadata extracted from images
 */
export interface ExifMetadata {
  make?: string;
  model?: string;
  iso?: number;
  aperture?: number;
  shutterSpeed?: string;
  focalLength?: number;
  dateTimeOriginal?: Date;
  latitude?: number;
  longitude?: number;
  orientation?: number;
}

/**
 * Base media document interface
 *
 * Uses Directus triple-name pattern (filename, originalFilename, title),
 * Payload-style independent variants, and a status lifecycle.
 */
export interface IMedia {
  // --- Identity (Directus triple-name pattern) ---

  /** Sanitized storage filename */
  filename: string;
  /** Original filename as uploaded by user */
  originalFilename: string;
  /** Display title (auto-generated from filename or user-set) */
  title: string;

  // --- Storage ---

  /** Storage key/path */
  key: string;
  /** Public URL */
  url: string;
  /** MIME type */
  mimeType: string;
  /** File size in bytes */
  size: number;
  /** SHA-256 content hash (auto-computed on every upload) */
  hash: string;

  // --- Status Lifecycle ---

  /** File status: pending → processing → ready | error */
  status: MediaStatus;
  /** Error message if status === 'error' */
  errorMessage?: string;

  // --- Organization ---

  /** Full folder path */
  folder: string;
  /** Searchable tags (Directus pattern) */
  tags: string[];
  /** Alt text for images */
  alt?: string;
  /** Description */
  description?: string;

  // --- Image Metadata ---

  /** Image width in pixels */
  width?: number;
  /** Image height in pixels */
  height?: number;
  /** Aspect ratio (width / height, auto-computed) */
  aspectRatio?: number;
  /** Focal point for smart cropping (Payload CMS pattern) */
  focalPoint?: FocalPoint;

  // --- Variants (Payload pattern — independent metadata per variant) ---

  variants: GeneratedVariant[];

  // --- Video/Audio ---

  /** Duration in milliseconds (Directus pattern) */
  duration?: number;

  // --- Placeholders ---

  /** ThumbHash placeholder (base64, ~33 chars) for blur-up loading */
  thumbhash?: string;
  /** Dominant color hex (e.g., '#3b82f6') for placeholder backgrounds */
  dominantColor?: string;

  // --- Video Metadata ---

  /** Video metadata — populated when videoAdapter is provided */
  videoMetadata?: {
    codec?: string;
    fps?: number;
    bitrate?: number;
    audioCodec?: string;
  };

  // --- Extensible ---

  /** Custom metadata */
  metadata: Record<string, unknown>;
  /** EXIF data from images */
  exif?: ExifMetadata;

  // --- Soft Delete ---

  /** Null = active, Date = soft-deleted */
  deletedAt?: Date | null;

  // --- Audit ---

  /** User who uploaded the file */
  uploadedBy?: Types.ObjectId;
  /** Organization for multi-tenancy */
  organizationId?: Types.ObjectId | string;

  // --- Timestamps ---

  createdAt: Date;
  updatedAt: Date;
}

export interface IMediaDocument extends IMedia, Document {
  _id: Types.ObjectId;
}

export type MediaModel = Model<IMediaDocument>;

// ============================================
// CONFIGURATION TYPES
// ============================================

/**
 * Allowed file types configuration
 */
export interface FileTypesConfig {
  /** Allowed MIME types */
  allowed: string[];
  /** Max file size in bytes */
  maxSize?: number;
}

/**
 * Folder configuration
 */
export interface FolderConfig {
  /** Default folder if not specified */
  defaultFolder?: string;
  /** Content type mappings (folder pattern → content type) */
  contentTypeMap?: Record<string, string[]>;
  /** Enable unlimited subfolder nesting (default: true) */
  enableSubfolders?: boolean;
  /**
   * Rewrite storage keys when moving/renaming folders (default: true).
   * When true, move() and renameFolder() physically copy files to new
   * storage keys matching the target folder, then delete the originals.
   * When false, only the DB folder field is updated (metadata-only).
   */
  rewriteKeys?: boolean;
}

/**
 * Multi-tenancy configuration
 */
export interface MultiTenancyConfig {
  /** Enable multi-tenancy */
  enabled: boolean;
  /** Field name for organization ID */
  field?: string;
  /** Require organization ID on all operations */
  required?: boolean;
}

/**
 * Deduplication configuration
 */
export interface DeduplicationConfig {
  /** Enable file deduplication by hash (default: false) */
  enabled: boolean;
  /** Return existing file instead of uploading duplicate (default: true) */
  returnExisting?: boolean;
  /** Hash algorithm: 'md5' (fast) or 'sha256' (secure, default) */
  algorithm?: 'md5' | 'sha256';
}

/**
 * Soft delete configuration
 */
export interface SoftDeleteConfig {
  /** Enable soft deletes (default: false) */
  enabled: boolean;
  /** Auto-purge TTL in days (default: 30). Set 0 to disable auto-purge. */
  ttlDays?: number;
}

/**
 * Concurrency control configuration
 */
export interface ConcurrencyConfig {
  /** Maximum number of concurrent upload operations (default: 5) */
  maxConcurrent?: number;
}

/**
 * Import options for importing files from URL
 */
export interface ImportOptions {
  /** Target folder */
  folder?: string;
  /** Override filename (defaults to URL filename) */
  filename?: string;
  /** Alt text */
  alt?: string;
  /** Title */
  title?: string;
  /** Tags */
  tags?: string[];
  /** Maximum file size in bytes (default: from fileTypes config) */
  maxSize?: number;
  /** Request timeout in milliseconds (default: 30000) */
  timeout?: number;
}

/**
 * Main media-kit configuration
 */
export interface MediaKitConfig {
  /** Storage driver instance */
  driver: StorageDriver;
  /** File type restrictions */
  fileTypes?: FileTypesConfig;
  /** Folder configuration */
  folders?: FolderConfig;
  /** Image processing config */
  processing?: ProcessingConfig;
  /** Multi-tenancy config */
  multiTenancy?: MultiTenancyConfig;
  /** File deduplication config */
  deduplication?: DeduplicationConfig;
  /** Soft delete config */
  softDelete?: SoftDeleteConfig;
  /** Concurrency control */
  concurrency?: ConcurrencyConfig;
  /** Cache adapter for read-through caching (Redis, Memcached, in-memory) */
  cache?: MediaCacheConfig;
  /** Logger instance (optional) */
  logger?: MediaKitLogger;
  /** Suppress warnings about missing optional dependencies (default: false) */
  suppressWarnings?: boolean;
  /** Mongokit plugins to apply to the repository */
  plugins?: import('@classytic/mongokit').PluginType[];
  /** Pagination configuration for the repository */
  pagination?: import('@classytic/mongokit').PaginationConfig;
}

/**
 * Logger interface (compatible with console, pino, winston, etc.)
 */
export interface MediaKitLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
  debug?(message: string, meta?: Record<string, unknown>): void;
}

// ============================================
// OPERATION TYPES
// ============================================

/**
 * Context for operations (user, organization, etc.)
 */
export interface OperationContext {
  /** Current user ID */
  userId?: Types.ObjectId | string;
  /** Organization ID for multi-tenancy */
  organizationId?: Types.ObjectId | string;
  /** Include soft-deleted files in queries */
  includeTrashed?: boolean;
  /** Additional context data */
  [key: string]: unknown;
}

/**
 * Upload input for single file
 */
export interface UploadInput {
  /** File buffer */
  buffer: Buffer;
  /** Original filename */
  filename: string;
  /** MIME type */
  mimeType: string;
  /** Target folder */
  folder?: string;
  /** Alt text */
  alt?: string;
  /** Title (defaults to humanized filename) */
  title?: string;
  /** Description */
  description?: string;
  /** Tags */
  tags?: string[];
  /** Focal point for smart cropping */
  focalPoint?: FocalPoint;
  /** Content type hint for processing (e.g., 'product', 'avatar') */
  contentType?: string;
  /** Skip processing */
  skipProcessing?: boolean;
  /** Override processing quality for this upload (1-100 or per-format map) */
  quality?: number | QualityMap;
  /** Override output format for this upload */
  format?: 'webp' | 'jpeg' | 'png' | 'avif' | 'original';
  /** Override max width for this upload */
  maxWidth?: number;
  /** Override max height for this upload */
  maxHeight?: number;
}

/**
 * Input for confirming a presigned upload
 */
export interface ConfirmUploadInput {
  /** Storage key from the presigned upload */
  key: string;
  /** Original filename */
  filename: string;
  /** MIME type */
  mimeType: string;
  /** File size in bytes */
  size: number;
  /** Target folder */
  folder?: string;
  /** Alt text */
  alt?: string;
  /** Title */
  title?: string;
  /** Override public URL */
  url?: string;
  /** Hash strategy: 'skip' (placeholder, default), 'etag' (use storage ETag), 'sha256' (stream file — expensive). Only use 'sha256' with deduplication enabled. */
  hashStrategy?: HashStrategy;
  /** ETag from storage (avoids stat() call if client provides it) */
  etag?: string;
  /** Run post-upload processing (ThumbHash, dominant color, variants). Default: false */
  process?: boolean;
}

/**
 * Folder tree node (for FE file explorer)
 */
export interface FolderNode {
  /** Unique identifier (same as path) */
  id: string;
  /** Display name */
  name: string;
  /** Full path */
  path: string;
  /** File stats */
  stats: { count: number; size: number };
  /** Child folders */
  children: FolderNode[];
  /** Latest upload timestamp */
  latestUpload?: Date;
}

/**
 * Folder tree response
 */
export interface FolderTree {
  /** Root folder nodes */
  folders: FolderNode[];
  /** Aggregate stats */
  meta: { totalFiles: number; totalSize: number };
}

/**
 * Breadcrumb item
 */
export interface BreadcrumbItem {
  /** Display name */
  name: string;
  /** Full path to this point */
  path: string;
}

/**
 * Folder stats
 */
export interface FolderStats {
  totalFiles: number;
  totalSize: number;
  avgSize: number;
  mimeTypes: string[];
  oldestFile: Date | null;
  newestFile: Date | null;
}

/**
 * Bulk operation result
 */
export interface BulkResult<T = string> {
  success: T[];
  failed: Array<{ id: T; reason: string }>;
}

/**
 * Result of move/renameFolder operations.
 * Unlike simple `{ modifiedCount }`, exposes per-file failures
 * so callers can retry or reconcile at scale.
 */
export interface RewriteResult {
  modifiedCount: number;
  failed: Array<{ id: string; reason: string }>;
}

// ============================================
// EVENT SYSTEM TYPES
// ============================================

/**
 * Media-specific event names (all events are awaitable)
 */
export type MediaEventName =
  // Upload
  | 'before:upload'
  | 'after:upload'
  | 'error:upload'
  | 'before:uploadMany'
  | 'after:uploadMany'
  | 'error:uploadMany'
  // Delete
  | 'before:delete'
  | 'after:delete'
  | 'error:delete'
  | 'before:deleteMany'
  | 'after:deleteMany'
  | 'error:deleteMany'
  // Move
  | 'before:move'
  | 'after:move'
  | 'error:move'
  // Replace (same ID, new content)
  | 'before:replace'
  | 'after:replace'
  | 'error:replace'
  // Soft delete
  | 'before:softDelete'
  | 'after:softDelete'
  | 'error:softDelete'
  // Restore
  | 'before:restore'
  | 'after:restore'
  | 'error:restore'
  // Import from URL
  | 'before:import'
  | 'after:import'
  | 'error:import'
  // Presigned uploads
  | 'before:presignedUpload'
  | 'after:presignedUpload'
  | 'error:presignedUpload'
  | 'before:confirmUpload'
  | 'after:confirmUpload'
  | 'error:confirmUpload'
  // Multipart uploads
  | 'before:multipartUpload'
  | 'after:multipartUpload'
  | 'error:multipartUpload'
  | 'before:completeMultipart'
  | 'after:completeMultipart'
  | 'error:completeMultipart'
  // Folder operations
  | 'before:rename'
  | 'after:rename'
  | 'error:rename'
  // Progress (per-file tracking for bulk operations)
  | 'progress:move'
  | 'progress:rename'
  // Processing
  | 'before:validate'
  | 'after:process';

/**
 * Event context for before hooks
 */
export interface EventContext<T = unknown> {
  /** Operation input data */
  data: T;
  /** Operation context (user, org, etc.) */
  context?: OperationContext;
  /** Timestamp */
  timestamp: Date;
}

/**
 * Event result for after hooks
 */
export interface EventResult<T = unknown, R = unknown> {
  /** Original context */
  context: EventContext<T>;
  /** Operation result */
  result: R;
  /** Timestamp */
  timestamp: Date;
}

/**
 * Event error for error hooks
 */
export interface EventError<T = unknown> {
  /** Original context */
  context: EventContext<T>;
  /** Error that occurred */
  error: Error;
  /** Timestamp */
  timestamp: Date;
}

/**
 * Progress event payload for bulk operations (move, rename).
 * Emitted per-file so consumers can build progress UIs.
 */
export interface ProgressEvent {
  /** ID of the file just processed */
  fileId: string;
  /** Number of files completed so far */
  completed: number;
  /** Total number of files in the operation */
  total: number;
  /** Storage key after processing (new key if rewritten, old key if skipped) */
  key: string;
  /** Operation-specific context */
  context?: OperationContext;
  /** Timestamp */
  timestamp: Date;
}

/**
 * Event listener function type (can return Promise for awaitable events)
 */
export type EventListener<T = unknown> = (payload: T) => void | Promise<void>;

/**
 * Unsubscribe function returned by on()
 */
export type Unsubscribe = () => void;

// ============================================
// ASSET TRANSFORM TYPES (Framework-agnostic)
// ============================================

/**
 * Transform query parameters
 */
export interface TransformParams {
  /** Target width */
  w?: number;
  /** Target height */
  h?: number;
  /** Fit mode */
  fit?: 'cover' | 'contain' | 'fill' | 'inside' | 'outside';
  /** Output format ('auto' resolves from Accept header) */
  format?: 'webp' | 'avif' | 'jpeg' | 'png' | 'auto';
  /** Quality (1-100) */
  q?: number;
  /** Force download (Content-Disposition: attachment) */
  download?: boolean;
}

/**
 * Transform request input (framework-agnostic)
 */
export interface TransformRequest {
  /** File ID or storage key */
  fileId: string;
  /** Transform parameters */
  params: TransformParams;
  /** Accept header for content negotiation */
  accept?: string;
  /** Range header for partial content */
  range?: string;
}

/**
 * Transform response output (framework-agnostic)
 */
export interface TransformResponse {
  /** Response stream */
  stream: NodeJS.ReadableStream;
  /** Content type */
  contentType: string;
  /** Content length (if known) */
  contentLength?: number;
  /** HTTP status code (200 or 206 for range) */
  status: number;
  /** Response headers */
  headers: Record<string, string>;
}

/**
 * Transform cache interface (pluggable)
 */
export interface TransformCache {
  /** Get cached transform */
  get(cacheKey: string): Promise<{ stream: NodeJS.ReadableStream; contentType: string } | null>;
  /** Store transform in cache */
  set(cacheKey: string, data: Buffer, contentType: string): Promise<void>;
  /** Invalidate all transforms for a file */
  invalidate(fileId: string): Promise<void>;
}

// ============================================
// MEDIA KIT INSTANCE
// ============================================

/**
 * Main MediaKit instance interface
 */
export interface MediaKit {
  /** Configuration */
  readonly config: MediaKitConfig;
  /** Storage driver */
  readonly driver: StorageDriver;
  /** Mongoose schema */
  readonly schema: Schema<IMediaDocument>;
  /** Mongokit-powered repository (available after init()) */
  readonly repository: MediaRepository;

  // --- Initialization ---

  init(model: MediaModel): this;

  // --- Event System (awaitable) ---

  /** Register event listener. Returns unsubscribe function. */
  on<T = unknown>(event: MediaEventName, listener: EventListener<T>): Unsubscribe;

  // --- Lifecycle ---

  /** Release resources (event listeners, cached state). Safe to call multiple times. */
  dispose(): void;

  // --- Core Operations ---

  upload(input: UploadInput, context?: OperationContext): Promise<IMediaDocument>;
  uploadMany(inputs: UploadInput[], context?: OperationContext): Promise<IMediaDocument[]>;
  delete(id: string, context?: OperationContext): Promise<boolean>;
  deleteMany(ids: string[], context?: OperationContext): Promise<BulkResult>;
  move(ids: string[], targetFolder: string, context?: OperationContext): Promise<RewriteResult>;

  // --- File Replacement (same ID, new content) ---

  replace(id: string, input: UploadInput, context?: OperationContext): Promise<IMediaDocument>;

  // --- Soft Deletes ---

  softDelete(id: string, context?: OperationContext): Promise<IMediaDocument>;
  restore(id: string, context?: OperationContext): Promise<IMediaDocument>;
  purgeDeleted(olderThan?: Date, context?: OperationContext): Promise<number>;

  // --- URL Import ---

  importFromUrl(url: string, options?: ImportOptions, context?: OperationContext): Promise<IMediaDocument>;

  // --- Tags ---

  addTags(id: string, tags: string[], context?: OperationContext): Promise<IMediaDocument>;
  removeTags(id: string, tags: string[], context?: OperationContext): Promise<IMediaDocument>;

  // --- Focal Point ---

  setFocalPoint(id: string, focalPoint: FocalPoint, context?: OperationContext): Promise<IMediaDocument>;

  // --- Query Operations ---

  getById(id: string, context?: OperationContext): Promise<IMediaDocument | null>;
  getAll(
    params?: {
      filters?: Record<string, unknown>;
      sort?: import('@classytic/mongokit').SortSpec | string;
      limit?: number;
      page?: number;
      cursor?: string;
      after?: string;
      search?: string;
    },
    context?: OperationContext
  ): Promise<import('@classytic/mongokit').OffsetPaginationResult<IMediaDocument> | import('@classytic/mongokit').KeysetPaginationResult<IMediaDocument>>;
  search(query: string, params?: { limit?: number; page?: number; filters?: Record<string, unknown> }, context?: OperationContext): Promise<import('@classytic/mongokit').OffsetPaginationResult<IMediaDocument> | import('@classytic/mongokit').KeysetPaginationResult<IMediaDocument>>;

  // --- Presigned Upload Operations ---

  getSignedUploadUrl(
    filename: string,
    contentType: string,
    options?: { folder?: string; expiresIn?: number },
  ): Promise<PresignedUploadResult>;
  confirmUpload(input: ConfirmUploadInput, context?: OperationContext): Promise<IMediaDocument>;

  // --- Multipart Upload (S3) ---

  initiateMultipartUpload(input: InitiateMultipartInput): Promise<MultipartUploadSession>;
  signUploadPart(key: string, uploadId: string, partNumber: number, expiresIn?: number): Promise<SignedPartResult>;
  signUploadParts(key: string, uploadId: string, partNumbers: number[], expiresIn?: number): Promise<SignedPartResult[]>;
  completeMultipartUpload(input: CompleteMultipartInput, context?: OperationContext): Promise<IMediaDocument>;
  abortMultipartUpload(key: string, uploadId: string): Promise<void>;

  // --- Resumable Upload Helpers (GCS) ---

  abortResumableUpload(sessionUri: string): Promise<void>;
  getResumableUploadStatus(sessionUri: string): Promise<{ uploadedBytes: number }>;

  // --- Batch Presigned URLs ---

  generateBatchPutUrls(input: BatchPresignInput): Promise<BatchPresignResult>;

  // --- Folder Operations ---

  getFolderTree(context?: OperationContext): Promise<FolderTree>;
  getFolderStats(folder: string, context?: OperationContext): Promise<FolderStats>;
  getBreadcrumb(folder: string): BreadcrumbItem[];
  deleteFolder(folder: string, context?: OperationContext): Promise<BulkResult>;
  renameFolder(oldPath: string, newPath: string, context?: OperationContext): Promise<RewriteResult>;
  getSubfolders(parentPath: string, context?: OperationContext): Promise<FolderNode[]>;

  // --- Utilities ---

  validateFile(buffer: Buffer, filename: string, mimeType: string): void;
  getContentType(folder: string): string;
}
