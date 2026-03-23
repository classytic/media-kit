/**
 * Replace operation — replace file content while preserving the same document ID.
 */

import type { OperationDeps } from './types';
import type {
  UploadInput,
  OperationContext,
  IMediaDocument,
  GeneratedVariant,
  EventContext,
  EventResult,
  EventError,
} from '../types';
import { computeFileHash } from '../utils/hash';
import { processImage } from './process-image';
import { log, requireTenant, generateKey, generateTitle, validateFile } from './helpers';

/**
 * Replace file content while preserving the same document ID.
 *
 * 1. Find existing record
 * 2. Process new image (variants, dimensions)
 * 3. Write new file to storage FIRST (before deleting old)
 * 4. Update DB record (same ID preserved)
 * 5. Delete old file + variants from storage
 */
export async function replace(
  deps: OperationDeps,
  id: string,
  input: UploadInput,
  context?: OperationContext,
): Promise<IMediaDocument> {
  const { buffer, filename, mimeType } = input;
  requireTenant(deps, context);

  const eventCtx: EventContext<{ id: string; input: UploadInput }> = {
    data: { id, input },
    context,
    timestamp: new Date(),
  };
  await deps.events.emit('before:replace', eventCtx);

  // Track new files outside try so we can clean up orphans on failure
  const newVariants: GeneratedVariant[] = [];
  let newMainKey: string | undefined;

  try {
    // Step 1: Find existing record
    const existing = await deps.repository.getMediaById(id, context);
    if (!existing) {
      throw new Error(`Media not found: ${id}`);
    }

    // Validate new file
    validateFile(deps, buffer, filename, mimeType);

    // Compute hash for new file
    const hashAlgorithm = deps.config.deduplication?.algorithm || 'sha256';
    const hash = computeFileHash(buffer, hashAlgorithm);

    // Step 2: Process image + generate variants
    const targetFolder = existing.folder;

    const processed = await processImage(deps, {
      buffer,
      filename,
      mimeType,
      skipProcessing: input.skipProcessing,
      contentType: input.contentType,
      focalPoint: input.focalPoint || existing.focalPoint,
      targetFolder,
      context,
    });
    const { finalBuffer, finalMimeType, finalFilename, width, height, aspectRatio } = processed;
    newVariants.push(...processed.variants);

    // Step 3: Write new file to storage FIRST (before deleting old)
    const newKey = generateKey(finalFilename, targetFolder);
    const writeResult = await deps.driver.write(newKey, finalBuffer, finalMimeType);
    newMainKey = newKey; // Track for cleanup if DB update fails

    // Generate title for replacement if not explicitly provided
    const finalTitle = input.title || generateTitle(filename);

    // Step 4: Update DB record (same ID preserved)
    const media = await deps.repository.updateMedia(
      id,
      {
        filename: finalFilename,
        originalFilename: filename,
        title: finalTitle,
        mimeType: finalMimeType,
        size: writeResult.size,
        url: writeResult.url,
        key: writeResult.key,
        hash,
        width,
        height,
        aspectRatio,
        variants: newVariants,
        status: 'ready',
        errorMessage: undefined,
        alt: input.alt ?? existing.alt,
        description: input.description ?? existing.description,
        focalPoint: input.focalPoint ?? existing.focalPoint,
      },
      context,
    );

    // Step 5: Delete old file + old variants from storage (safe: new file already written)
    try {
      await deps.driver.delete(existing.key);
    } catch (err) {
      log(deps, 'warn', 'Failed to delete old main file from storage during replace', {
        id,
        key: existing.key,
        error: (err as Error).message,
      });
    }

    if (existing.variants && existing.variants.length > 0) {
      for (const variant of existing.variants) {
        try {
          await deps.driver.delete(variant.key);
        } catch (err) {
          log(deps, 'warn', 'Failed to delete old variant from storage during replace', {
            id,
            variant: variant.name,
            key: variant.key,
            error: (err as Error).message,
          });
        }
      }
    }

    log(deps, 'info', 'Media replaced', { id, newKey });

    const resultEvent: EventResult<{ id: string; input: UploadInput }, IMediaDocument> = {
      context: eventCtx,
      result: media,
      timestamp: new Date(),
    };
    await deps.events.emit('after:replace', resultEvent);

    return media;
  } catch (error) {
    // Best-effort cleanup of orphaned files written before the failure
    const orphanKeys: string[] = [];

    if (newMainKey) {
      orphanKeys.push(newMainKey);
      try {
        await deps.driver.delete(newMainKey);
      } catch {
        // Ignore cleanup failures
      }
    }

    if (newVariants.length > 0) {
      for (const variant of newVariants) {
        orphanKeys.push(variant.key);
        try {
          await deps.driver.delete(variant.key);
        } catch {
          // Ignore cleanup failures
        }
      }
    }

    if (orphanKeys.length > 0) {
      log(deps, 'warn', 'Cleaned up orphaned files after replace failure', {
        id,
        keys: orphanKeys,
      });
    }

    const errorEvent: EventError<{ id: string; input: UploadInput }> = {
      context: eventCtx,
      error: error as Error,
      timestamp: new Date(),
    };
    await deps.events.emit('error:replace', errorEvent);
    throw error;
  }
}
