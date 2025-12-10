/**
 * Image Processor
 * 
 * Sharp-based image processing with:
 * - Format conversion (WebP, AVIF, etc.)
 * - Aspect ratio enforcement
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
 *   aspectRatio: { aspectRatio: 3/4, fit: 'cover' }
 * });
 * ```
 */

import type {
  ImageProcessor as IImageProcessor,
  ProcessingOptions,
  ProcessedImage,
  AspectRatioPreset,
  SizeVariant
} from '../types';

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

/**
 * Image Processor Implementation
 */
export class ImageProcessor implements IImageProcessor {
  private sharp: any;
  private available = false;

  constructor(options?: { concurrency?: number; cache?: boolean }) {
    this.initSharp(options);
  }

  private async initSharp(options?: { concurrency?: number; cache?: boolean }): Promise<void> {
    try {
      this.sharp = (await import('sharp')).default;

      // Configure Sharp for optimal memory usage
      if (this.sharp) {
        // Disable cache by default to reduce memory usage
        this.sharp.cache(options?.cache ?? false);

        // Limit concurrency to prevent memory spikes
        this.sharp.concurrency(options?.concurrency ?? 2);
      }

      this.available = true;
    } catch {
      this.available = false;
    }
  }

  private async getSharp() {
    if (!this.sharp) {
      await this.initSharp();
    }
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
   * Check if buffer is a processable image
   */
  isProcessable(_buffer: Buffer, mimeType: string): boolean {
    return PROCESSABLE_TYPES.includes(mimeType.toLowerCase());
  }

  /**
   * Process image with given options
   */
  async process(buffer: Buffer, options: ProcessingOptions): Promise<ProcessedImage> {
    const sharp = await this.getSharp();
    
    const {
      maxWidth = 2048,
      quality = 80,
      format = 'webp',
      aspectRatio,
    } = options;

    // Get original metadata
    const metadata = await sharp(buffer).metadata();
    
    if (!metadata.width || !metadata.height) {
      throw new Error('Unable to read image dimensions');
    }

    let instance = sharp(buffer);

    // Apply aspect ratio transformation
    if (aspectRatio && !aspectRatio.preserveRatio && aspectRatio.aspectRatio) {
      const targetWidth = Math.min(metadata.width, maxWidth);
      const targetHeight = Math.round(targetWidth / aspectRatio.aspectRatio);
      
      instance = instance.resize(targetWidth, targetHeight, {
        fit: aspectRatio.fit || 'cover',
        position: 'center',
      });
    } else if (metadata.width > maxWidth) {
      // Just resize to max width, preserve ratio
      instance = instance.resize(maxWidth, null, {
        fit: 'inside',
        withoutEnlargement: true,
      });
    }

    // Convert format
    switch (format) {
      case 'webp':
        instance = instance.webp({ quality });
        break;
      case 'jpeg':
        instance = instance.jpeg({ quality });
        break;
      case 'png':
        instance = instance.png({ quality });
        break;
      case 'avif':
        instance = instance.avif({ quality });
        break;
    }

    // Process and get result
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
   * Generate multiple size variants from a single image
   * @example
   * ```ts
   * const variants = await processor.generateVariants(buffer, [
   *   { name: 'thumbnail', width: 150, height: 150 },
   *   { name: 'medium', width: 800 },
   *   { name: 'large', width: 1920 }
   * ]);
   * ```
   */
  async generateVariants(
    buffer: Buffer,
    variants: SizeVariant[],
    baseOptions: Omit<ProcessingOptions, 'maxWidth'> = {}
  ): Promise<ProcessedImage[]> {
    await this.getSharp(); // Ensure sharp is loaded
    const results: ProcessedImage[] = [];

    for (const variant of variants) {
      // Filter out 'original' format, default to base or webp
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
      results.push(processed);
    }

    return results;
  }

  /**
   * Extract EXIF metadata from image
   */
  async extractMetadata(buffer: Buffer): Promise<Record<string, any>> {
    const sharp = await this.getSharp();
    const metadata = await sharp(buffer).metadata();

    const exif: Record<string, any> = {};

    if (metadata.exif) {
      // Sharp provides raw EXIF buffer, you'd need exif-parser or similar
      // For simplicity, we'll extract what's available from metadata
      if (metadata.orientation) exif.orientation = metadata.orientation;
    }

    if (metadata.density) exif.density = metadata.density;
    if (metadata.hasAlpha !== undefined) exif.hasAlpha = metadata.hasAlpha;
    if (metadata.space) exif.colorSpace = metadata.space;

    return exif;
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
