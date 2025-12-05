/**
 * @classytic/media-kit - Type Definitions
 * 
 * Clean, self-documenting types for media management.
 */

import type { Document, Schema, Model, Types } from 'mongoose';

// ============================================
// STORAGE PROVIDER TYPES
// ============================================

/**
 * Result from storage upload operation
 */
export interface UploadResult {
  /** Public URL to access the file */
  url: string;
  /** Storage key/path (for deletion) */
  key: string;
  /** Final file size in bytes */
  size: number;
  /** MIME type of stored file */
  mimeType: string;
  /** Image dimensions (if applicable) */
  dimensions?: { width: number; height: number };
}

/**
 * Options for upload operation
 */
export interface UploadOptions {
  /** Target folder path (e.g., 'products/featured') */
  folder?: string;
  /** Content type hint for processing (e.g., 'product', 'avatar') */
  contentType?: string;
  /** Skip image processing */
  skipProcessing?: boolean;
  /** Custom metadata */
  metadata?: Record<string, string>;
  /** Organization ID for multi-tenancy */
  organizationId?: string;
}

/**
 * Storage provider interface - implement this for custom providers
 */
export interface StorageProvider {
  /** Provider name (e.g., 's3', 'gcs', 'local') */
  readonly name: string;
  
  /** Upload a file and return the result */
  upload(buffer: Buffer, filename: string, options?: UploadOptions): Promise<UploadResult>;
  
  /** Delete a file by key */
  delete(key: string): Promise<boolean>;
  
  /** Check if a file exists */
  exists(key: string): Promise<boolean>;
  
  /** Get a signed URL for private files (optional) */
  getSignedUrl?(key: string, expiresIn?: number): Promise<string>;
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
}

/**
 * Generated size variant result
 */
export interface GeneratedVariant {
  /** Variant name */
  name: string;
  /** Public URL */
  url: string;
  /** Storage key */
  key: string;
  /** File size in bytes */
  size: number;
  /** Dimensions */
  width: number;
  height: number;
}

/**
 * Image processing configuration
 */
export interface ProcessingConfig {
  /** Enable image processing (default: true) */
  enabled?: boolean;
  /** Maximum width for images */
  maxWidth?: number;
  /** Output quality (1-100) */
  quality?: number;
  /** Output format */
  format?: 'webp' | 'jpeg' | 'png' | 'avif' | 'original';
  /** Aspect ratio presets by content type */
  aspectRatios?: Record<string, AspectRatioPreset>;
  /** Size variants to generate (e.g., thumbnail, medium, large) */
  sizes?: SizeVariant[];
  /** Enable automatic alt text generation */
  generateAlt?: boolean | AltGenerationConfig;
}

/**
 * Alt text generation configuration
 */
export interface AltGenerationConfig {
  /** Enable auto-generation */
  enabled: boolean;
  /** Strategy: 'filename' (from filename) or 'ai' (AI-based, requires API key) */
  strategy?: 'filename' | 'ai';
  /** Fallback text if generation fails */
  fallback?: string;
  /** Custom generator function */
  generator?: (filename: string, buffer?: Buffer) => Promise<string> | string;
}

/**
 * Image processor interface
 */
export interface ImageProcessor {
  /** Process image buffer with given options */
  process(buffer: Buffer, options: ProcessingOptions): Promise<ProcessedImage>;
  /** Check if buffer is a processable image */
  isProcessable(buffer: Buffer, mimeType: string): boolean;
}

export interface ProcessingOptions {
  maxWidth?: number;
  quality?: number;
  format?: 'webp' | 'jpeg' | 'png' | 'avif';
  aspectRatio?: AspectRatioPreset;
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
 * EXIF metadata extracted from images
 */
export interface ExifMetadata {
  /** Camera make */
  make?: string;
  /** Camera model */
  model?: string;
  /** ISO speed */
  iso?: number;
  /** Aperture (f-number) */
  aperture?: number;
  /** Shutter speed */
  shutterSpeed?: string;
  /** Focal length */
  focalLength?: number;
  /** Date/time original */
  dateTimeOriginal?: Date;
  /** GPS latitude */
  latitude?: number;
  /** GPS longitude */
  longitude?: number;
  /** Orientation */
  orientation?: number;
}

/**
 * Video metadata
 */
export interface VideoMetadata {
  /** Duration in seconds */
  duration?: number;
  /** Codec */
  codec?: string;
  /** Bitrate */
  bitrate?: number;
  /** Frame rate */
  frameRate?: number;
  /** Has audio track */
  hasAudio?: boolean;
}

/**
 * Base media document interface
 */
export interface IMedia {
  /** Original filename */
  filename: string;
  /** User-provided original name */
  originalName: string;
  /** MIME type */
  mimeType: string;
  /** File size in bytes */
  size: number;
  /** Public URL */
  url: string;
  /** Storage key for deletion */
  key: string;
  /** Base folder (first segment) */
  baseFolder: string;
  /** Full folder path */
  folder: string;
  /** Alt text for images (auto-generated if enabled) */
  alt?: string;
  /** Title/caption */
  title?: string;
  /** Description */
  description?: string;
  /** Image dimensions */
  dimensions?: { width: number; height: number };
  /** Generated size variants (thumbnail, medium, large, etc.) */
  variants?: GeneratedVariant[];
  /** EXIF metadata (for images) */
  exif?: ExifMetadata;
  /** Video metadata */
  video?: VideoMetadata;
  /** File hash (for deduplication) */
  hash?: string;
  /** Uploader reference */
  uploadedBy?: Types.ObjectId;
  /** Organization for multi-tenancy */
  organizationId?: Types.ObjectId | string;
  /** Custom metadata */
  metadata?: Record<string, unknown>;
  /** Timestamps */
  createdAt: Date;
  updatedAt: Date;
}

export interface IMediaDocument extends IMedia, Document {}

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
  /** Allowed base folders (first segment of path) */
  baseFolders: string[];
  /** Default folder if not specified */
  defaultFolder?: string;
  /** Content type mappings (folder pattern → content type) */
  contentTypeMap?: Record<string, string[]>;
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
 * Field-based access control (role-based field filtering)
 */
export interface FieldAccessConfig {
  /** Field presets by role/permission level */
  presets?: {
    /** Public fields (no auth required) */
    public?: string[];
    /** Authenticated user fields */
    authenticated?: string[];
    /** Owner fields (user who uploaded) */
    owner?: string[];
    /** Admin fields */
    admin?: string[];
    /** Custom role presets */
    [role: string]: string[] | undefined;
  };
  /** Function to determine user's role/level */
  getUserLevel?: (context: OperationContext) => string | Promise<string>;
}

/**
 * Deduplication configuration
 */
export interface DeduplicationConfig {
  /** Enable file deduplication by hash (default: false) */
  enabled: boolean;
  /** Return existing file instead of uploading duplicate (default: true) */
  returnExisting?: boolean;
  /** Hash algorithm: 'md5' (fast) or 'sha256' (secure) */
  algorithm?: 'md5' | 'sha256';
}

/**
 * Main media-kit configuration
 */
export interface MediaKitConfig {
  /** Storage provider instance */
  provider: StorageProvider;
  /** File type restrictions */
  fileTypes?: FileTypesConfig;
  /** Folder configuration */
  folders?: FolderConfig;
  /** Image processing config */
  processing?: ProcessingConfig;
  /** Multi-tenancy config */
  multiTenancy?: MultiTenancyConfig;
  /** Field-based access control */
  fieldAccess?: FieldAccessConfig;
  /** File deduplication config */
  deduplication?: DeduplicationConfig;
  /** Logger instance (optional) */
  logger?: Logger;
  /** Suppress warnings about missing optional dependencies (default: false) */
  suppressWarnings?: boolean;
}

/**
 * Logger interface (compatible with console, pino, winston, etc.)
 */
export interface Logger {
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
  /** Title */
  title?: string;
  /** Content type hint for processing */
  contentType?: string;
  /** Skip processing */
  skipProcessing?: boolean;
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

// ============================================
// EVENT SYSTEM TYPES
// ============================================

/**
 * Available event names (follows mongokit pattern)
 */
export type MediaEventName =
  | 'before:upload'
  | 'after:upload'
  | 'error:upload'
  | 'before:uploadMany'
  | 'after:uploadMany'
  | 'error:uploadMany'
  | 'before:delete'
  | 'after:delete'
  | 'error:delete'
  | 'before:deleteMany'
  | 'after:deleteMany'
  | 'error:deleteMany'
  | 'before:move'
  | 'after:move'
  | 'error:move'
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
 * Event listener function type
 */
export type EventListener<T = unknown> = (payload: T) => void | Promise<void>;

/**
 * Event emitter interface (compatible with mongokit pattern)
 */
export interface EventEmitter {
  /** Register event listener */
  on<T = unknown>(event: MediaEventName, listener: EventListener<T>): void;
  /** Emit event */
  emit<T = unknown>(event: MediaEventName, payload: T): void;
}

// ============================================
// MEDIA KIT INSTANCE
// ============================================

/**
 * Main MediaKit instance interface
 */
export interface MediaKit extends EventEmitter {
  /** Configuration */
  readonly config: MediaKitConfig;
  /** Storage provider */
  readonly provider: StorageProvider;
  /** Mongoose schema (use this to create your model) */
  readonly schema: Schema<IMediaDocument>;
  /** Underlying repository (if using @classytic/mongokit) */
  readonly repository?: unknown;

  // Initialization
  init(model: MediaModel): void;

  // Core operations
  upload(input: UploadInput, context?: OperationContext): Promise<IMediaDocument>;
  uploadMany(inputs: UploadInput[], context?: OperationContext): Promise<IMediaDocument[]>;
  delete(id: string, context?: OperationContext): Promise<boolean>;
  deleteMany(ids: string[], context?: OperationContext): Promise<BulkResult>;
  move(ids: string[], targetFolder: string, context?: OperationContext): Promise<{ modifiedCount: number }>;

  // Folder operations
  getFolderTree(context?: OperationContext): Promise<FolderTree>;
  getFolderStats(folder: string, context?: OperationContext): Promise<FolderStats>;
  getBreadcrumb(folder: string): BreadcrumbItem[];
  deleteFolder(folder: string, context?: OperationContext): Promise<BulkResult>;

  // Utilities
  validateFile(buffer: Buffer, filename: string, mimeType: string): void;
  getContentType(folder: string): string;
}
