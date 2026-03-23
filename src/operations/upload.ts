/**
 * Upload operations — upload, performUpload, uploadMany.
 * Status-driven flow: pending → processing → ready | error.
 */

import type { OperationDeps } from './types';
import type {
  UploadInput,
  OperationContext,
  IMediaDocument,
  FocalPoint,
  GeneratedVariant,
  EventContext,
  EventResult,
  EventError,
} from '../types';
import type { MediaRepository } from '../repository/media.repository';
import { computeFileHash } from '../utils/hash';
import { isImage } from '../utils/mime';
import { normalizeFolderPath } from '../utils/folders';
import { generateAltText, generateAltTextWithOptions } from '../utils/alt-text';
import { processImage } from './process-image';
import { log, requireTenant, generateKey, generateTitle, validateFile } from './helpers';

/**
 * Upload a single file with status-driven flow.
 * Includes automatic hash computation and optional deduplication.
 */
export async function upload(
  deps: OperationDeps,
  input: UploadInput,
  context?: OperationContext,
): Promise<IMediaDocument> {
  const { buffer, filename, mimeType, folder, skipProcessing } = input;
  const organizationId = requireTenant(deps, context);

  const eventCtx: EventContext<UploadInput> = {
    data: input,
    context,
    timestamp: new Date(),
  };
  await deps.events.emit('before:upload', eventCtx);

  try {
    // Validate before acquiring semaphore slot
    validateFile(deps, buffer, filename, mimeType);

    // Compute hash
    const hashAlgorithm = deps.config.deduplication?.algorithm || 'sha256';
    const hash = computeFileHash(buffer, hashAlgorithm);

    // Deduplication check
    if (deps.config.deduplication?.enabled) {
      const existing = await deps.repository.getByHash(hash, context);
      if (existing && deps.config.deduplication.returnExisting !== false) {
        log(deps, 'info', 'Deduplication hit: returning existing file', {
          hash,
          existingId: existing._id,
        });

        const dedupResultEvent: EventResult<UploadInput, IMediaDocument> = {
          context: eventCtx,
          result: existing,
          timestamp: new Date(),
        };
        await deps.events.emit('after:upload', dedupResultEvent);

        return existing;
      }
    }

    // Use semaphore to control concurrency
    const media = await deps.uploadSemaphore.run(async () => {
      return performUpload(deps, {
        buffer,
        filename,
        mimeType,
        folder,
        alt: input.alt,
        title: input.title,
        description: input.description,
        tags: input.tags,
        focalPoint: input.focalPoint,
        contentType: input.contentType,
        skipProcessing,
        organizationId,
        context,
        hash,
        quality: input.quality,
        format: input.format,
        maxWidth: input.maxWidth,
        maxHeight: input.maxHeight,
      });
    });

    log(deps, 'info', 'Media uploaded', {
      id: media._id,
      folder: media.folder,
      size: media.size,
      status: media.status,
    });

    const resultEvent: EventResult<UploadInput, IMediaDocument> = {
      context: eventCtx,
      result: media,
      timestamp: new Date(),
    };
    await deps.events.emit('after:upload', resultEvent);

    return media;
  } catch (error) {
    const errorEvent: EventError<UploadInput> = {
      context: eventCtx,
      error: error as Error,
      timestamp: new Date(),
    };
    await deps.events.emit('error:upload', errorEvent);
    throw error;
  }
}

/**
 * Internal upload implementation (runs within semaphore).
 * Follows status lifecycle: pending → processing → ready | error.
 */
async function performUpload(
  deps: OperationDeps,
  params: {
    buffer: Buffer;
    filename: string;
    mimeType: string;
    folder?: string;
    alt?: string;
    title?: string;
    description?: string;
    tags?: string[];
    focalPoint?: FocalPoint;
    contentType?: string;
    skipProcessing?: boolean;
    organizationId?: string | import('mongoose').Types.ObjectId;
    context?: OperationContext;
    hash: string;
    quality?: number | import('../types').QualityMap;
    format?: 'webp' | 'jpeg' | 'png' | 'avif' | 'original';
    maxWidth?: number;
    maxHeight?: number;
  },
): Promise<IMediaDocument> {
  const {
    buffer,
    filename,
    mimeType,
    folder,
    title,
    description,
    tags,
    focalPoint,
    contentType,
    skipProcessing,
    organizationId,
    context,
    hash,
    quality,
    format,
    maxWidth,
    maxHeight,
  } = params;
  let { alt } = params;

  // Generate alt text if not provided and image
  if (!alt && isImage(mimeType)) {
    const generateAltConfig = deps.config.processing?.generateAlt;
    if (generateAltConfig) {
      const enabled =
        typeof generateAltConfig === 'boolean' ? generateAltConfig : generateAltConfig.enabled;

      if (enabled) {
        if (typeof generateAltConfig === 'object') {
          const { strategy = 'filename', fallback, generator } = generateAltConfig;

          if (generator) {
            try {
              const result = await generator(filename, buffer);
              alt = result || fallback || 'Image';
            } catch {
              alt = fallback || generateAltText(filename);
            }
          } else if (strategy === 'filename') {
            alt = generateAltTextWithOptions(filename, { fallback });
          } else {
            alt = fallback || generateAltText(filename);
          }
        } else {
          alt = generateAltText(filename);
        }

        if (deps.logger?.debug) {
          deps.logger.debug('Generated alt text', { filename, alt });
        }
      }
    }
  }

  // Normalize folder
  const targetFolder = normalizeFolderPath(folder || deps.config.folders?.defaultFolder || 'general');

  // Generate title if not provided
  const finalTitle = title || generateTitle(filename);

  // Generate initial storage key
  let key = generateKey(filename, targetFolder);

  // Step 1: Create DB record with status: 'pending'
  let media = await deps.repository.createMedia(
    {
      filename,
      originalFilename: filename,
      title: finalTitle,
      mimeType,
      size: buffer.length,
      url: deps.driver.getPublicUrl(key),
      key,
      hash,
      status: 'pending',
      folder: targetFolder,
      alt,
      description,
      tags: tags || [],
      focalPoint,
      variants: [],
      metadata: {},
      ...(organizationId && { organizationId }),
    },
    context,
  );

  const mediaId = media._id.toString();

  // Track variants outside try so we can clean up orphans on failure
  const variants: GeneratedVariant[] = [];

  try {
    // Step 2: Set status to 'processing'
    media = await deps.repository.updateMedia(mediaId, { status: 'processing' }, context);

    // Process image + generate variants
    const processed = await processImage(deps, {
      buffer,
      filename,
      mimeType,
      skipProcessing,
      contentType,
      focalPoint,
      targetFolder,
      context,
      quality,
      format,
      maxWidth,
      maxHeight,
    });
    const { finalBuffer, finalMimeType, finalFilename, width, height, aspectRatio } = processed;
    variants.push(...processed.variants);

    // Regenerate key if processing changed the format
    if (finalMimeType !== mimeType) {
      key = generateKey(finalFilename, targetFolder);
    }

    // Step 3: Upload to storage via driver.write()
    const writeResult = await deps.driver.write(key, finalBuffer, finalMimeType);

    // Step 4: Set status to 'ready', update record with final data
    media = await deps.repository.updateMedia(
      mediaId,
      {
        filename: finalFilename,
        mimeType: finalMimeType,
        size: writeResult.size,
        url: writeResult.url,
        key: writeResult.key,
        width,
        height,
        aspectRatio,
        variants: variants.length > 0 ? variants : [],
        status: 'ready',
        thumbhash: processed.thumbhash,
        dominantColor: processed.dominantColor,
        videoMetadata: processed.videoMetadata,
        exif: processed.exif,
        ...(processed.duration !== undefined && { duration: processed.duration }),
      },
      context,
    );

    return media;
  } catch (error) {
    // Step 5: On error, set status to 'error' with errorMessage
    try {
      media = await deps.repository.updateMedia(
        mediaId,
        {
          status: 'error',
          errorMessage: (error as Error).message,
        },
        context,
      );
    } catch (updateErr) {
      log(deps, 'error', 'Failed to set error status on media record', {
        id: mediaId,
        error: (updateErr as Error).message,
      });
    }

    // Best-effort cleanup of orphaned variant files written before the failure
    if (variants.length > 0) {
      for (const variant of variants) {
        try {
          await deps.driver.delete(variant.key);
        } catch {
          // Ignore cleanup failures — variant is already orphaned
        }
      }
      log(deps, 'warn', 'Cleaned up orphaned variant files after upload failure', {
        id: mediaId,
        variants: variants.map((v) => v.key),
      });
    }

    throw error;
  }
}

/**
 * Upload multiple files. Partial failures do not block successful uploads.
 */
export async function uploadMany(
  deps: OperationDeps,
  inputs: UploadInput[],
  context?: OperationContext,
): Promise<IMediaDocument[]> {
  const eventCtx: EventContext<UploadInput[]> = {
    data: inputs,
    context,
    timestamp: new Date(),
  };
  await deps.events.emit('before:uploadMany', eventCtx);

  const settled = await Promise.allSettled(inputs.map((input) => upload(deps, input, context)));

  const successes: IMediaDocument[] = [];
  const errors: Array<{ index: number; error: Error }> = [];

  for (let i = 0; i < settled.length; i++) {
    const result = settled[i];
    if (!result) continue;
    if (result.status === 'fulfilled') {
      successes.push(result.value);
    } else if (result.status === 'rejected') {
      errors.push({ index: i, error: result.reason as Error });
      log(deps, 'warn', 'uploadMany: file failed', {
        index: i,
        filename: inputs[i]?.filename,
        error: (result.reason as Error).message,
      });
    }
  }

  await deps.events.emit('after:uploadMany', {
    context: eventCtx,
    result: { successes, errors },
    timestamp: new Date(),
  });

  return successes;
}
