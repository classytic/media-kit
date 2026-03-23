/**
 * Image Processor
 *
 * Sharp-based image processing with:
 * - Format conversion (WebP, AVIF, etc.)
 * - Aspect ratio enforcement
 * - Focal-point-aware cropping (Payload CMS pattern)
 * - Conditional variant generation (skip if original is smaller)
 * - Quality optimization
 * - Size limits
 *
 * @example
 * ```ts
 * const processor = createImageProcessor();
 * const result = await processor.process(buffer, {
 *   maxWidth: 1200,
 *   format: 'webp',
 *   quality: 80,
 *   focalPoint: { x: 0.3, y: 0.4 },
 * });
 * ```
 */

import type {
  ImageProcessor as IImageProcessor,
  ProcessingOptions,
  ProcessedImage,
  AspectRatioPreset,
  SizeVariant,
  FocalPoint,
  QualityMap,
  SharpOptions,
} from '../types';
import { calculateFocalPointCrop } from './focal-point';

// MIME types that can be processed
const PROCESSABLE_TYPES = [
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/avif',
  'image/tiff',
];

// Format to MIME type mapping
const FORMAT_MIME_MAP: Record<string, string> = {
  webp: 'image/webp',
  jpeg: 'image/jpeg',
  png: 'image/png',
  avif: 'image/avif',
};

const DEFAULT_QUALITY_MAP: Record<string, number> = {
  jpeg: 82, webp: 82, avif: 50, png: 100,
};

function resolveQuality(quality: unknown, format: string): number {
  if (typeof quality === 'number') return quality;
  if (typeof quality === 'object' && quality !== null) {
    return (quality as Record<string, number>)[format] ?? DEFAULT_QUALITY_MAP[format] ?? 82;
  }
  return DEFAULT_QUALITY_MAP[format] ?? 82;
}

/**
 * Image Processor Implementation
 */
export class ImageProcessor implements IImageProcessor {
  private sharp: any;
  private available = false;
  private initPromise: Promise<void>;
  private sharpOptions: SharpOptions;

  constructor(options?: SharpOptions) {
    this.sharpOptions = {
      mozjpeg: true,
      webpSmartSubsample: true,
      avifEffort: 6,
      avifChromaSubsampling: '4:2:0',
      ...options,
    };
    this.initPromise = this.initSharp(options);
  }

  private async initSharp(options?: SharpOptions): Promise<void> {
    try {
      this.sharp = (await import('sharp')).default;

      if (this.sharp) {
        this.sharp.cache(options?.cache ?? false);
        this.sharp.concurrency(options?.concurrency ?? 2);
      }

      this.available = true;
    } catch {
      this.available = false;
    }
  }

  private async getSharp() {
    await this.initPromise;
    if (!this.available) {
      throw new Error(
        'sharp is required for image processing. Install it with: npm install sharp'
      );
    }
    return this.sharp;
  }

  /**
   * Check if processing is available (sharp installed)
   */
  isAvailable(): boolean {
    return this.available;
  }

  /**
   * Wait for lazy sharp initialization to complete.
   */
  async waitUntilReady(): Promise<boolean> {
    await this.initPromise;
    return this.available;
  }

  /**
   * Check if buffer is a processable image
   */
  isProcessable(_buffer: Buffer, mimeType: string): boolean {
    return PROCESSABLE_TYPES.includes(mimeType.toLowerCase());
  }

  /**
   * Process image with given options.
   * Supports focal-point-aware cropping when focalPoint is provided.
   */
  async process(buffer: Buffer, options: ProcessingOptions): Promise<ProcessedImage> {
    const sharp = await this.getSharp();

    const {
      maxWidth = 2048,
      maxHeight,
      quality = 80,
      format = 'webp',
      aspectRatio,
      focalPoint,
    } = options;

    const metadata = await sharp(buffer).metadata();

    if (!metadata.width || !metadata.height) {
      throw new Error('Unable to read image dimensions');
    }

    let instance = sharp(buffer);

    // Auto-orient from EXIF (correct rotation, strip orientation tag)
    if (options.autoOrient !== false) {
      instance = instance.rotate(); // No-arg rotate = auto-orient from EXIF
    }

    // Metadata handling
    if (options.stripMetadata !== false) {
      instance = instance.keepIccProfile();
    } else {
      instance = instance.keepMetadata();
    }

    // Apply focal-point-aware crop when aspect ratio is being changed
    if (aspectRatio && !aspectRatio.preserveRatio && aspectRatio.aspectRatio && focalPoint) {
      const targetWidth = Math.min(metadata.width, maxWidth);
      const targetHeight = Math.round(targetWidth / aspectRatio.aspectRatio);

      const crop = calculateFocalPointCrop({
        originalWidth: metadata.width,
        originalHeight: metadata.height,
        targetWidth,
        targetHeight,
        focalX: focalPoint.x,
        focalY: focalPoint.y,
      });

      // Extract-then-resize (Payload CMS pattern)
      instance = instance
        .extract(crop)
        .resize(targetWidth, targetHeight, { fit: 'fill' });
    } else if (aspectRatio && !aspectRatio.preserveRatio && aspectRatio.aspectRatio) {
      // Standard aspect ratio crop (center-based)
      const targetWidth = Math.min(metadata.width, maxWidth);
      const targetHeight = Math.round(targetWidth / aspectRatio.aspectRatio);

      instance = instance.resize(targetWidth, targetHeight, {
        fit: aspectRatio.fit || 'cover',
        position: 'center',
      });
    } else if (metadata.width > maxWidth || (maxHeight && metadata.height > maxHeight)) {
      // Resize to fit within both maxWidth and maxHeight constraints
      instance = instance.resize(
        metadata.width > maxWidth ? maxWidth : null,
        maxHeight && metadata.height > maxHeight ? maxHeight : null,
        {
          fit: 'inside',
          withoutEnlargement: true,
        },
      );
    }

    // Convert format
    const q = resolveQuality(options.quality, format);

    switch (format) {
      case 'webp':
        instance = instance.webp({
          quality: q,
          smartSubsample: this.sharpOptions.webpSmartSubsample ?? true,
        });
        break;
      case 'jpeg':
        instance = instance.jpeg({
          quality: q,
          mozjpeg: this.sharpOptions.mozjpeg ?? true,
        });
        break;
      case 'png': {
        const compressionLevel = Math.round(9 - (q / 100) * 9);
        instance = instance.png({ compressionLevel, palette: q < 100 });
        break;
      }
      case 'avif':
        instance = instance.avif({
          quality: q,
          effort: this.sharpOptions.avifEffort ?? 6,
          chromaSubsampling: this.sharpOptions.avifChromaSubsampling ?? '4:2:0',
        });
        break;
    }

    const outputBuffer = await instance.toBuffer();
    const outputMetadata = await sharp(outputBuffer).metadata();

    return {
      buffer: outputBuffer,
      mimeType: FORMAT_MIME_MAP[format] || 'image/webp',
      width: outputMetadata.width || 0,
      height: outputMetadata.height || 0,
    };
  }

  /**
   * Get image dimensions without processing
   */
  async getDimensions(buffer: Buffer): Promise<{ width: number; height: number }> {
    const sharp = await this.getSharp();
    const metadata = await sharp(buffer).metadata();

    return {
      width: metadata.width || 0,
      height: metadata.height || 0,
    };
  }

  /**
   * Generate multiple size variants from a single image.
   *
   * - Conditional generation: skips variant if `condition` returns false
   * - Never upscales: skips variant if original is smaller than target
   * - Focal-point-aware: uses extract-then-resize when focalPoint is provided
   *
   * @returns Array of processed images (only for variants that passed conditions)
   */
  async generateVariants(
    buffer: Buffer,
    variants: SizeVariant[],
    baseOptions: Omit<ProcessingOptions, 'maxWidth'> = {}
  ): Promise<Array<ProcessedImage & { variantName: string }>> {
    const sharp = await this.getSharp();
    const metadata = await sharp(buffer).metadata();
    const origWidth = metadata.width || 0;
    const origHeight = metadata.height || 0;
    const origMimeType = `image/${metadata.format || 'jpeg'}`;

    const results: Array<ProcessedImage & { variantName: string }> = [];

    for (const variant of variants) {
      // Conditional variant generation (Payload pattern)
      if (variant.condition) {
        const shouldGenerate = variant.condition({
          width: origWidth,
          height: origHeight,
          mimeType: origMimeType,
        });
        if (!shouldGenerate) continue;
      }

      // Never upscale: skip if original is smaller than target
      if (variant.width && variant.height) {
        if (origWidth < variant.width && origHeight < variant.height) continue;
      } else if (variant.width && origWidth < variant.width) {
        continue;
      }

      const variantFormat = variant.format && variant.format !== 'original'
        ? variant.format
        : undefined;

      const variantOptions: ProcessingOptions = {
        ...baseOptions,
        maxWidth: variant.width,
        quality: variant.quality ?? baseOptions.quality,
        format: variantFormat ?? baseOptions.format ?? 'webp',
        aspectRatio: variant.aspectRatio ?? baseOptions.aspectRatio,
      };

      // If both width and height specified, enforce exact size
      if (variant.width && variant.height) {
        variantOptions.aspectRatio = {
          aspectRatio: variant.width / variant.height,
          fit: variant.aspectRatio?.fit ?? 'cover',
        };
      }

      const processed = await this.process(buffer, variantOptions);
      results.push({ ...processed, variantName: variant.name });
    }

    return results;
  }

  /**
   * Get the raw Sharp constructor (for sharing with other services).
   * Throws if Sharp is not available.
   */
  async getSharpInstance(): Promise<any> {
    return this.getSharp();
  }

  /**
   * Detect if an image is already well-optimized.
   * Uses bits-per-pixel heuristic: if below format threshold, re-compression
   * will likely increase size or cause generation loss.
   */
  async isOptimized(buffer: Buffer, mimeType: string): Promise<boolean> {
    try {
      const sharp = await this.getSharp();
      const metadata = await sharp(buffer).metadata();
      if (!metadata.width || !metadata.height) return false;

      const pixels = metadata.width * metadata.height;
      const bitsPerPixel = (buffer.length * 8) / pixels;

      const thresholds: Record<string, number> = {
        'image/jpeg': 1.5,
        'image/webp': 1.0,
        'image/avif': 0.8,
        'image/png': 4.0,
      };

      return bitsPerPixel < (thresholds[mimeType] || 2.0);
    } catch {
      return false;
    }
  }

  /**
   * Extract dominant color from image using Sharp's stats().
   * Returns hex string like '#3b82f6'.
   */
  async extractDominantColor(buffer: Buffer): Promise<string | null> {
    try {
      const sharp = await this.getSharp();
      const { dominant } = await sharp(buffer).stats();
      const r = Math.round(dominant.r).toString(16).padStart(2, '0');
      const g = Math.round(dominant.g).toString(16).padStart(2, '0');
      const b = Math.round(dominant.b).toString(16).padStart(2, '0');
      return `#${r}${g}${b}`;
    } catch {
      return null;
    }
  }

  /**
   * Extract EXIF metadata from image
   */
  async extractMetadata(buffer: Buffer): Promise<Record<string, any>> {
    const sharp = await this.getSharp();
    const metadata = await sharp(buffer).metadata();

    return {
      format: metadata.format,
      space: metadata.space,
      channels: metadata.channels,
      hasAlpha: metadata.hasAlpha,
      orientation: metadata.orientation,
      density: metadata.density,
      isProgressive: metadata.isProgressive,
      chromaSubsampling: metadata.chromaSubsampling,
      ...(metadata.exif ? { hasExif: true } : {}),
      ...(metadata.icc ? { hasIcc: true } : {}),
    };
  }
}

/**
 * Create image processor instance
 * Returns null if sharp is not available
 */
export function createImageProcessor(): ImageProcessor | null {
  try {
    return new ImageProcessor();
  } catch {
    return null;
  }
}

export default ImageProcessor;
