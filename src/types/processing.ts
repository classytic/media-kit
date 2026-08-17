/** Media processing contracts and adapter ports. */

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
  /**
   * Decompression-bomb guard: maximum number of pixels (width × height) Sharp
   * will decode from an input image before rejecting it. Passed straight into
   * Sharp's `limitInputPixels` constructor option, so a maliciously small file
   * that declares enormous dimensions is rejected before it can inflate to
   * gigabytes of decoded RAM. Number = pixel cap, `true` = Sharp's built-in
   * default cap, `false` = no limit (NOT recommended). Default: 268402689
   * (~268 MP, Sharp's own default).
   */
  limitInputPixels?: number | boolean;
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
  extractThumbnail(
    filePath: string,
    options?: {
      timestamp?: number;
    },
  ): Promise<{
    buffer: Buffer;
    mimeType: string;
    width: number;
    height: number;
  } | null>;
  /**
   * Extract video metadata (duration, codec, resolution).
   *
   * `duration` is in SECONDS (what ffprobe's `format.duration` reports) —
   * media-kit converts to milliseconds before storing on `media.duration`.
   * Returning milliseconds here inflates the stored value 1000×.
   */
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
  convert(
    buffer: Buffer,
    mimeType: string,
  ): Promise<{
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
  extractMetadata?(buffer: Buffer): Promise<Record<string, unknown>>;
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
