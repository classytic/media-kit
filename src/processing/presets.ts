/**
 * Built-in responsive image presets and processing presets.
 * Follows Next.js image optimization conventions.
 */
import type { SizeVariant, ProcessingConfig, ProcessingPresetName } from '../types';

/** Next.js standard device widths */
export const DEVICE_WIDTHS = [640, 750, 828, 1080, 1200, 1920, 2048, 3840] as const;

/** Practical subset (fewer variants, covers 90% of devices) */
export const COMPACT_WIDTHS = [640, 1080, 1920, 3840] as const;

/** Component-level image widths (thumbnails, avatars, cards) */
export const IMAGE_WIDTHS = [64, 96, 128, 256, 384] as const;

/**
 * Generate smart responsive variants for an image.
 * Only generates variants smaller than the original (never upscales).
 * Skips widths that are too close together relative to the original.
 */
export function generateResponsiveVariants(
  originalWidth: number,
  widths: readonly number[] = DEVICE_WIDTHS,
  options?: { format?: string; quality?: number },
): SizeVariant[] {
  return widths
    .filter(w => w < originalWidth)   // Never upscale
    .filter(w => w <= originalWidth * 0.9) // Skip if <10% reduction
    .map(w => ({
      name: `w${w}`,
      width: w,
      format: options?.format as any,
      quality: options?.quality,
      condition: (orig: { width: number }) => orig.width > w,
    }));
}

/**
 * Resolve a responsive preset name to width array.
 */
export function resolvePresetWidths(
  preset: 'nextjs' | 'compact' | 'none' | number[],
): readonly number[] | null {
  if (preset === 'none') return null;
  if (preset === 'nextjs') return DEVICE_WIDTHS;
  if (preset === 'compact') return COMPACT_WIDTHS;
  if (Array.isArray(preset)) return preset;
  return null;
}

// ============================================
// PROCESSING PRESETS
// ============================================

/**
 * Built-in processing presets for common use cases.
 * Each preset is a partial ProcessingConfig — user overrides win.
 *
 * @example
 * ```ts
 * const media = createMedia({
 *   driver: gcsDriver,
 *   processing: { preset: 'social-media' },
 * });
 * ```
 */
export const PROCESSING_PRESETS: Record<ProcessingPresetName, Partial<ProcessingConfig>> = {
  /**
   * Optimized for social media platforms (Facebook, Instagram, etc.)
   * - Max 1080px (Instagram standard)
   * - JPEG output with mozjpeg (best compatibility)
   * - Generates thumb (150px), small (320px), medium (640px) variants
   * - Always processes (no smart skip) for consistent output
   */
  'social-media': {
    maxWidth: 1080,
    maxHeight: 1080,
    format: 'jpeg',
    quality: { jpeg: 80, webp: 75, avif: 60, png: 90 },
    stripMetadata: true,
    autoOrient: true,
    smartSkip: false,
    sizes: [
      { name: 'thumb', width: 150, height: 150 },
      { name: 'small', width: 320 },
      { name: 'medium', width: 640 },
    ],
  },

  /**
   * Web-optimized with modern format (WebP).
   * - Max 2048px
   * - WebP output (best size/quality for modern browsers)
   * - ThumbHash + dominant color for placeholders
   * - Smart skip to avoid re-compressing optimized images
   */
  'web-optimized': {
    maxWidth: 2048,
    maxHeight: 2048,
    format: 'webp',
    quality: { jpeg: 82, webp: 80, avif: 55, png: 90 },
    stripMetadata: true,
    autoOrient: true,
    smartSkip: true,
    thumbhash: true,
    dominantColor: true,
  },

  /**
   * High-quality preservation.
   * - Max 4096px (full resolution)
   * - Preserves original format
   * - Keeps metadata (EXIF, ICC)
   * - Higher quality settings across all formats
   */
  'high-quality': {
    maxWidth: 4096,
    maxHeight: 4096,
    format: 'original',
    quality: { jpeg: 92, webp: 90, avif: 75, png: 100 },
    stripMetadata: false,
    autoOrient: true,
    smartSkip: true,
  },

  /**
   * Thumbnail generation.
   * - Max 300px
   * - WebP for smallest file size
   * - No original variant stored
   * - Always processes for consistency
   */
  'thumbnail': {
    maxWidth: 300,
    maxHeight: 300,
    format: 'webp',
    quality: { jpeg: 70, webp: 65, avif: 50, png: 80 },
    stripMetadata: true,
    autoOrient: true,
    smartSkip: false,
    keepOriginal: false,
  },
};

/**
 * Resolve a processing preset by name.
 * Returns undefined if preset name is not recognized.
 */
export function resolveProcessingPreset(
  name: ProcessingPresetName | undefined,
): Partial<ProcessingConfig> | undefined {
  if (!name) return undefined;
  return PROCESSING_PRESETS[name];
}
