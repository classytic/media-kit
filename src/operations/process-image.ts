/**
 * Image processing pipeline shared by upload and replace operations.
 * Processes an image buffer, generates size variants, and uploads variants to storage.
 */

import type { OperationDeps } from './types';
import type {
  FocalPoint,
  GeneratedVariant,
  OperationContext,
  OriginalHandling,
  ProcessingConfig,
  ProcessingOptions,
  QualityMap,
} from '../types';
import { isImage, isRawImage, isVideo, updateFilenameExtension } from '../utils/mime';
import { getContentType, getAspectRatio, generateKey, log } from './helpers';
import { generateThumbHash } from '../processing/thumbhash';

export interface ProcessImageParams {
  buffer: Buffer;
  filename: string;
  mimeType: string;
  skipProcessing?: boolean;
  contentType?: string;
  focalPoint?: FocalPoint;
  targetFolder: string;
  context?: OperationContext;
  // Per-upload overrides
  quality?: number | QualityMap;
  format?: 'webp' | 'jpeg' | 'png' | 'avif' | 'original';
  maxWidth?: number;
  maxHeight?: number;
}

export interface ProcessImageResult {
  finalBuffer: Buffer;
  finalMimeType: string;
  finalFilename: string;
  width?: number;
  height?: number;
  aspectRatio?: number;
  variants: GeneratedVariant[];
  thumbhash?: string;
  dominantColor?: string;
  videoMetadata?: {
    codec?: string;
    fps?: number;
    bitrate?: number;
    audioCodec?: string;
  };
  duration?: number;
  exif?: Record<string, any>;
}

/**
 * Resolve format string, treating 'original' as undefined (preserve source format).
 */
function resolveFormat(format?: string): 'webp' | 'jpeg' | 'png' | 'avif' | undefined {
  if (!format || format === 'original') return undefined;
  return format as 'webp' | 'jpeg' | 'png' | 'avif';
}

/**
 * Resolve how to handle the original image.
 * `originalHandling` takes precedence over deprecated `keepOriginal`.
 */
function resolveOriginalHandling(config?: ProcessingConfig): OriginalHandling {
  if (config?.originalHandling) return config.originalHandling;
  if (config?.keepOriginal === true) return 'keep-variant';
  // undefined or false keepOriginal → discard (backward compat)
  return 'discard';
}

/**
 * Process an image buffer and generate size variants.
 * Returns the (possibly transformed) buffer, dimensions, and uploaded variants.
 * On processing failure, returns the original buffer unchanged.
 */
export async function processImage(
  deps: OperationDeps,
  params: ProcessImageParams,
): Promise<ProcessImageResult> {
  let { buffer, filename, mimeType } = params;
  const { skipProcessing, contentType, focalPoint, targetFolder, context } = params;

  let finalBuffer = buffer;
  let finalMimeType = mimeType;
  let finalFilename = filename;
  let width: number | undefined;
  let height: number | undefined;
  let aspectRatio: number | undefined;
  const variants: GeneratedVariant[] = [];

  // Await processor readiness before checking availability (prevents race with constructor)
  if (deps.processorReady) {
    await deps.processorReady;
  }

  // RAW adapter: convert camera RAW formats to Sharp-processable format before processing
  const rawAdapter = deps.config.processing?.rawAdapter;
  if (isRawImage(mimeType) && rawAdapter && rawAdapter.supportedTypes.includes(mimeType.toLowerCase())) {
    try {
      log(deps, 'info', 'Converting RAW image via rawAdapter', { filename, mimeType });
      const converted = await rawAdapter.convert(buffer, mimeType);
      buffer = converted.buffer;
      mimeType = converted.mimeType;
      finalBuffer = buffer;
      finalMimeType = mimeType;
      finalFilename = updateFilenameExtension(filename, mimeType);
    } catch (err) {
      log(deps, 'warn', 'RAW conversion failed, uploading as-is', {
        filename,
        error: (err as Error).message,
      });
    }
  }

  const shouldProcess =
    !skipProcessing &&
    deps.config.processing?.enabled &&
    deps.processor &&
    isImage(mimeType);

  if (shouldProcess && deps.processor) {
    const effectiveContentType = contentType || getContentType(deps, targetFolder);
    const aspectRatioPreset = getAspectRatio(deps, effectiveContentType);

    // Thread per-upload overrides into processing options
    const processOpts: ProcessingOptions = {
      maxWidth: params.maxWidth ?? deps.config.processing?.maxWidth,
      maxHeight: params.maxHeight ?? deps.config.processing?.maxHeight,
      quality: params.quality ?? deps.config.processing?.quality,
      format: resolveFormat(params.format ?? deps.config.processing?.format),
      aspectRatio: aspectRatioPreset,
      focalPoint,
      stripMetadata: deps.config.processing?.stripMetadata,
      autoOrient: deps.config.processing?.autoOrient,
    };

    try {
      // Get dimensions early (needed for smart skip check)
      try {
        if (deps.processor.getDimensions) {
          const dims = await deps.processor.getDimensions(buffer);
          width = dims.width;
          height = dims.height;
        }
      } catch {
        // Ignore dimension extraction failure
      }

      // Smart skip detection BEFORE processing
      let skipMainProcess = false;
      if (deps.config.processing?.smartSkip && deps.processor?.isOptimized) {
        const isOptimized = await deps.processor.isOptimized(buffer, mimeType);
        const targetFormat = processOpts.format;
        const FORMAT_MIME_MAP: Record<string, string> = { webp: 'image/webp', jpeg: 'image/jpeg', png: 'image/png', avif: 'image/avif' };
        const sameFormat = !targetFormat || mimeType === FORMAT_MIME_MAP[targetFormat];
        const needsResize = (processOpts.maxWidth && width !== undefined && width > processOpts.maxWidth) ||
                            (processOpts.maxHeight && height !== undefined && height > processOpts.maxHeight);

        if (isOptimized && sameFormat && !needsResize) {
          log(deps, 'info', 'Smart skip: image already optimized', { filename });
          skipMainProcess = true;
        }
      }

      // Original handling: store untouched original as '__original' variant BEFORE processing
      const originalHandling = resolveOriginalHandling(deps.config.processing);
      if (originalHandling === 'keep-variant' && !skipMainProcess) {
        const origFilename = updateFilenameExtension(
          `${filename.replace(/\.[^.]+$/, '')}__original`,
          mimeType,
        );
        const origKey = generateKey(origFilename, targetFolder);
        const origWrite = await deps.driver.write(origKey, buffer, mimeType);
        variants.push({
          name: '__original',
          key: origWrite.key,
          url: origWrite.url,
          filename: origFilename,
          mimeType,
          size: origWrite.size,
          width,
          height,
        });
      }

      if (!skipMainProcess) {
        await deps.events.emit('before:validate', {
          data: { filename, mimeType, buffer },
          context,
          timestamp: new Date(),
        });

        const processed = await deps.processor.process(buffer, processOpts);
        finalBuffer = processed.buffer;
        finalMimeType = processed.mimeType;
        width = processed.width;
        height = processed.height;
        aspectRatio = width && height ? width / height : undefined;

        if (finalMimeType !== mimeType) {
          finalFilename = updateFilenameExtension(filename, finalMimeType);
        }

        await deps.events.emit('after:process', {
          context: { data: { filename, mimeType }, context, timestamp: new Date() },
          result: { width, height, mimeType: finalMimeType },
          timestamp: new Date(),
        });

        // Generate and upload size variants sequentially (memory-efficient)
        const sizeVariants = deps.config.processing?.sizes;
        if (sizeVariants && sizeVariants.length > 0) {
          for (const variant of sizeVariants) {
            if (!deps.processor!.generateVariants) continue;
            const [variantResult] = await deps.processor!.generateVariants(buffer, [variant], processOpts);

            if (!variantResult) continue;

            const baseFilename = finalFilename.replace(/\.[^.]+$/, '');
            const variantFilename = updateFilenameExtension(
              `${baseFilename}-${variant.name}`,
              variantResult.mimeType,
            );

            const variantKey = generateKey(variantFilename, targetFolder);
            const variantWriteResult = await deps.driver.write(
              variantKey,
              variantResult.buffer,
              variantResult.mimeType,
            );

            variants.push({
              name: variant.name,
              url: variantWriteResult.url,
              key: variantWriteResult.key,
              filename: variantFilename,
              mimeType: variantResult.mimeType,
              size: variantWriteResult.size,
              width: variantResult.width,
              height: variantResult.height,
            });
          }

          log(deps, 'info', 'Generated size variants', {
            filename,
            variants: variants.map((v) => v.name),
          });
        }
      } else {
        // Skipped main processing — still compute aspect ratio from dimensions
        aspectRatio = width && height ? width / height : undefined;
      }
    } catch (err) {
      log(deps, 'warn', 'Image processing failed, uploading original', {
        filename,
        error: (err as Error).message,
      });
    }
  }

  // If dimensions not set from processing, try to get them
  if (width === undefined && isImage(mimeType) && deps.processor) {
    try {
      if (deps.processor.getDimensions) {
        const dims = await deps.processor.getDimensions(buffer);
        width = dims.width;
        height = dims.height;
        aspectRatio = width && height ? width / height : undefined;
      }
    } catch {
      // Ignore dimension extraction failure
    }
  }

  // ThumbHash generation
  let thumbhash: string | undefined;
  if (deps.config.processing?.thumbhash !== false && isImage(mimeType)) {
    try {
      const sharp = deps.processor && 'getSharpInstance' in deps.processor
        ? await (deps.processor as any).getSharpInstance()
        : null;
      if (sharp) {
        thumbhash = await generateThumbHash(sharp, buffer) ?? undefined;
      }
    } catch {
      // Non-blocking
    }
  }

  // Dominant color extraction
  let dominantColor: string | undefined;
  if (deps.config.processing?.dominantColor !== false && deps.processor?.extractDominantColor && isImage(mimeType)) {
    try {
      dominantColor = await deps.processor.extractDominantColor(buffer) ?? undefined;
    } catch {
      // Non-blocking
    }
  }

  // EXIF extraction
  let exif: Record<string, any> | undefined;
  if (deps.processor?.extractMetadata && isImage(mimeType)) {
    try {
      exif = await deps.processor.extractMetadata(buffer);
    } catch {
      // Non-blocking
    }
  }

  // Video adapter handling (only for video mimeTypes)
  let videoMetadata: ProcessImageResult['videoMetadata'];
  let videoDuration: number | undefined;
  const videoAdapter = deps.config.processing?.videoAdapter;
  if (isVideo(mimeType) && videoAdapter) {
    const os = await import('os');
    const fs = await import('fs/promises');
    const path = await import('path');
    const tempPath = path.join(os.tmpdir(), `mk-${Date.now()}-${filename}`);
    try {
      await fs.writeFile(tempPath, buffer);
      const [thumbResult, metaResult] = await Promise.allSettled([
        videoAdapter.extractThumbnail(tempPath),
        videoAdapter.extractMetadata(tempPath),
      ]);
      if (thumbResult.status === 'fulfilled' && thumbResult.value) {
        const thumbFilename = `${filename.replace(/\.[^.]+$/, '')}__thumbnail.jpg`;
        const thumbKey = generateKey(thumbFilename, targetFolder);
        const writeResult = await deps.driver.write(thumbKey, thumbResult.value.buffer, thumbResult.value.mimeType);
        variants.push({
          name: '__thumbnail',
          key: writeResult.key,
          url: writeResult.url,
          filename: thumbFilename,
          mimeType: thumbResult.value.mimeType,
          size: writeResult.size,
          width: thumbResult.value.width,
          height: thumbResult.value.height,
        });
        width = thumbResult.value.width;
        height = thumbResult.value.height;
      }
      if (metaResult.status === 'fulfilled' && metaResult.value) {
        videoMetadata = {
          codec: metaResult.value.codec,
          fps: metaResult.value.fps,
          bitrate: metaResult.value.bitrate,
          audioCodec: metaResult.value.audioCodec,
        };
        videoDuration = metaResult.value.duration * 1000; // convert to ms
        width = width ?? metaResult.value.width;
        height = height ?? metaResult.value.height;
      }
    } catch (err) {
      log(deps, 'warn', 'Video processing failed', { filename, error: (err as Error).message });
    } finally {
      try { const fs2 = await import('fs/promises'); await fs2.unlink(tempPath); } catch { /* ignore */ }
    }
  }

  return { finalBuffer, finalMimeType, finalFilename, width, height, aspectRatio, variants, thumbhash, dominantColor, videoMetadata, duration: videoDuration, exif };
}
