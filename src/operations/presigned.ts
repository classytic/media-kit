/**
 * Presigned upload operations — generate signed URL, confirm upload,
 * multipart orchestration (S3/GCS), and batch presigned URLs.
 */

import type { OperationDeps } from './types';
import type {
  ConfirmUploadInput,
  OperationContext,
  IMediaDocument,
  PresignedUploadResult,
  EventError,
  HashStrategy,
  InitiateMultipartInput,
  MultipartUploadSession,
  CompleteMultipartInput,
  SignedPartResult,
  BatchPresignInput,
  BatchPresignResult,
} from '../types';
import { computeFileHash } from '../utils/hash';
import { isAllowedMimeType, isImage } from '../utils/mime';
import { normalizeFolderPath } from '../utils/folders';
import { assertAndClaim } from '@classytic/primitives/state-machine';
import { MEDIA_MACHINE } from '../models/media-state-machine.js';
import { log, requireTenant, generateKey, generateTitle } from './helpers';
import { processImage } from './process-image';

/**
 * Generate a presigned upload URL for direct browser → cloud uploads.
 * After the client PUTs the file, call confirmUpload() to register it in the DB.
 */
export async function getSignedUploadUrl(
  deps: OperationDeps,
  filename: string,
  contentType: string,
  options: { folder?: string; expiresIn?: number } = {},
): Promise<PresignedUploadResult> {
  if (!deps.driver.getSignedUploadUrl) {
    throw new Error(`Driver '${deps.driver.name}' does not support presigned uploads`);
  }

  const folder = normalizeFolderPath(options.folder || deps.config.folders?.defaultFolder || 'uploads');
  const key = generateKey(filename, folder);

  const eventData = { filename, contentType, folder, key };

  await deps.events.emit('before:presignedUpload', {
    data: eventData,
    timestamp: new Date(),
  });

  try {
    const result = await deps.driver.getSignedUploadUrl(key, contentType, options.expiresIn);

    await deps.events.emit('after:presignedUpload', {
      context: { data: eventData, timestamp: new Date() },
      result,
      timestamp: new Date(),
    });

    return result;
  } catch (error) {
    const errorEvent: EventError<typeof eventData> = {
      context: { data: eventData, timestamp: new Date() },
      error: error as Error,
      timestamp: new Date(),
    };
    await deps.events.emit('error:presignedUpload', errorEvent);
    throw error;
  }
}

/**
 * Confirm a presigned upload. Verifies the file exists in storage
 * and creates the database record with status 'ready'.
 */
export async function confirmUpload(
  deps: OperationDeps,
  input: ConfirmUploadInput,
  context?: OperationContext,
): Promise<IMediaDocument> {
  const organizationId = requireTenant(deps, context);

  const eventCtx = {
    data: input,
    context,
    timestamp: new Date(),
  };
  await deps.events.emit('before:confirmUpload', eventCtx);

  try {
    // Enforce the same file policy as upload() — MIME type + size checks
    const { allowed = [], maxSize } = deps.config.fileTypes || {};

    if (allowed.length > 0 && !isAllowedMimeType(input.mimeType, allowed)) {
      throw new Error(`File type '${input.mimeType}' is not allowed. Allowed: ${allowed.join(', ')}`);
    }

    if (maxSize && input.size > maxSize) {
      const maxMB = Math.round(maxSize / 1024 / 1024);
      throw new Error(`File size exceeds limit of ${maxMB}MB`);
    }

    // Verify the file actually exists in storage
    const exists = await deps.driver.exists(input.key);
    if (!exists) {
      throw new Error(`File not found in storage at key: ${input.key}. Upload may not have completed.`);
    }

    // Fetch real metadata from storage for validation (fail-closed: stat errors reject the upload)
    let actualSize = input.size;
    let storageMimeType: string | undefined;
    const stat = await deps.driver.stat(input.key).catch((err: Error) => {
      throw new Error(
        `Cannot verify uploaded file metadata for key '${input.key}': ${err.message}. ` +
        `Refusing to trust client-provided metadata.`,
      );
    });

    actualSize = stat.size || input.size;
    storageMimeType = stat.contentType;

    // Cross-check: storage MIME vs client-claimed MIME
    if (storageMimeType && storageMimeType !== input.mimeType) {
      if (allowed.length > 0 && !isAllowedMimeType(storageMimeType, allowed)) {
        throw new Error(
          `File type mismatch: client claimed '${input.mimeType}' but storage reports '${storageMimeType}' which is not allowed. Allowed: ${allowed.join(', ')}`,
        );
      }
      log(deps, 'warn', 'MIME type mismatch in confirmUpload', {
        key: input.key,
        clientMime: input.mimeType,
        storageMime: storageMimeType,
      });
    }

    // Re-check actual size from storage against limit
    if (maxSize && actualSize > maxSize) {
      const maxMB = Math.round(maxSize / 1024 / 1024);
      throw new Error(`File size exceeds limit of ${maxMB}MB`);
    }

    // Use storage-reported MIME type as authoritative when available
    const effectiveMimeType = storageMimeType || input.mimeType;

    // Compute hash based on strategy (default: 'skip' — no file download, no storage cost)
    // Hash is only functionally useful when deduplication is enabled.
    const hashStrategy: HashStrategy = input.hashStrategy || 'skip';
    let hash = '';

    if (hashStrategy === 'sha256') {
      // Stream entire file for SHA-256 (expensive — only use when deduplication is enabled)
      try {
        const { computeStreamHash } = await import('../utils/hash');
        const stream = await deps.driver.read(input.key);
        const algorithm = deps.config.deduplication?.algorithm || 'sha256';
        hash = await computeStreamHash(stream, algorithm);
      } catch {
        hash = computeFileHash(Buffer.from(`${input.key}:${actualSize}`));
      }
    } else if (hashStrategy === 'etag') {
      // Use ETag from storage stat — no file download
      hash = input.etag || stat.etag || computeFileHash(Buffer.from(`${input.key}:${actualSize}`));
    } else {
      // 'skip' — deterministic placeholder from key+size (default)
      hash = computeFileHash(Buffer.from(`${input.key}:${actualSize}`));
    }

    // Determine folder from key
    const keyParts = input.key.split('/');
    const folder = input.folder || (keyParts.length > 1 ? keyParts.slice(0, -1).join('/') : 'uploads');

    // Build public URL
    const url = input.url || deps.driver.getPublicUrl(input.key);

    // Generate title
    const title = input.title || generateTitle(input.filename);

    let media = await deps.repository.createMedia(
      {
        filename: input.filename,
        originalFilename: input.filename,
        title,
        mimeType: effectiveMimeType,
        size: actualSize,
        url,
        key: input.key,
        hash,
        status: 'ready',
        folder,
        alt: input.alt,
        variants: [],
        tags: [],
        metadata: {},
        ...(organizationId && { organizationId }),
        ...(input.expiresAt && { expiresAt: input.expiresAt }),
      },
      context,
    );

    // Optional post-confirm processing (ThumbHash, dominant color, variants)
    if (input.process && deps.processor && isImage(effectiveMimeType)) {
      const mediaIdStr = media._id.toString();
      try {
        // ready → processing — declared transition in MEDIA_MACHINE
        // for the post-confirm reprocess flow. assertAndClaim
        // validates the transition is legal AND wins the race in one
        // call. If another reprocess is in flight, claim returns null
        // and we skip silently (file is in storage and accessible;
        // redundant work is the only thing we're avoiding).
        const claimed = await assertAndClaim(MEDIA_MACHINE, deps.repository, mediaIdStr, {
          from: 'ready',
          to: 'processing',
          options: context as Record<string, unknown>,
        });
        if (!claimed) {
          log(deps, 'info', 'Skipping post-confirm processing — record not in ready state', {
            key: input.key,
            id: mediaIdStr,
          });
        } else {
          media = claimed;

          // Read file from storage for processing
          const stream = await deps.driver.read(input.key);
          const chunks: Buffer[] = [];
          for await (const chunk of stream) {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as unknown as Uint8Array));
          }
          const buffer = Buffer.concat(chunks);

          // Run through the same processImage pipeline as regular uploads
          const processed = await processImage(deps, {
            buffer,
            filename: input.filename,
            mimeType: effectiveMimeType,
            skipProcessing: false,
            targetFolder: folder,
            context,
          });

          // processing → ready with payload merge in the same CAS.
          const payload: Record<string, unknown> = {
            width: processed.width,
            height: processed.height,
            aspectRatio: processed.aspectRatio,
            thumbhash: processed.thumbhash,
            dominantColor: processed.dominantColor,
            exif: processed.exif,
          };
          if (processed.variants.length > 0) {
            payload.variants = processed.variants;
          }

          const finalised = await assertAndClaim(MEDIA_MACHINE, deps.repository, mediaIdStr, {
            from: 'processing',
            to: 'ready',
            patch: payload,
            options: context as Record<string, unknown>,
          });
          if (finalised) media = finalised;
        }
      } catch (processError) {
        // Processing failure is non-blocking — file is already uploaded and accessible.
        // Best-effort revert to ready via the same processing → ready
        // transition declared in MEDIA_MACHINE (the state graph doesn't
        // distinguish "successful reprocess" from "rolled-back reprocess";
        // both land the row in `ready`).
        try {
          await assertAndClaim(MEDIA_MACHINE, deps.repository, mediaIdStr, {
            from: 'processing',
            to: 'ready',
            options: context as Record<string, unknown>,
          });
        } catch { /* ignore revert failure */ }
        log(deps, 'warn', 'Post-confirm processing failed (file still available)', {
          key: input.key,
          error: (processError as Error).message,
        });
      }
    }

    await deps.events.emit('after:confirmUpload', {
      context: eventCtx,
      result: media,
      timestamp: new Date(),
    });

    log(deps, 'info', 'Presigned upload confirmed', {
      id: media._id,
      key: input.key,
      folder,
    });

    return media;
  } catch (error) {
    const errorEvent: EventError<ConfirmUploadInput> = {
      context: eventCtx,
      error: error as Error,
      timestamp: new Date(),
    };
    await deps.events.emit('error:confirmUpload', errorEvent);
    throw error;
  }
}

// ============================================
// MULTIPART UPLOAD OPERATIONS
// ============================================

/**
 * Initiate a multipart upload session.
 * Auto-detects driver capabilities: S3-style multipart or GCS-style resumable.
 * Returns a discriminated union — client checks `session.type` for the upload strategy.
 */
export async function initiateMultipartUpload(
  deps: OperationDeps,
  input: InitiateMultipartInput,
): Promise<MultipartUploadSession> {
  if (!deps.driver.createMultipartUpload) {
    // Fall back to GCS resumable if available
    if (deps.driver.createResumableUpload) {
      const folder = normalizeFolderPath(input.folder || deps.config.folders?.defaultFolder || 'uploads');
      const key = generateKey(input.filename, folder);
      const result = await deps.driver.createResumableUpload(key, input.contentType);
      return {
        type: 'resumable',
        key: result.key,
        uploadUrl: result.uploadUrl,
        publicUrl: result.publicUrl,
        minChunkSize: result.minChunkSize,
        expiresAt: result.expiresAt,
      };
    }
    throw new Error(`Driver '${deps.driver.name}' does not support multipart or resumable uploads`);
  }

  const folder = normalizeFolderPath(input.folder || deps.config.folders?.defaultFolder || 'uploads');
  const key = generateKey(input.filename, folder);

  await deps.events.emit('before:multipartUpload', { data: input, timestamp: new Date() });

  const { uploadId } = await deps.driver.createMultipartUpload(key, input.contentType);

  // Optionally sign all parts upfront if partCount is provided
  let parts: SignedPartResult[] | undefined;
  if (input.partCount && deps.driver.signUploadPart) {
    parts = await Promise.all(
      Array.from({ length: input.partCount }, (_, i) =>
        deps.driver.signUploadPart!(key, uploadId, i + 1, input.expiresIn),
      ),
    );
  }

  const session: MultipartUploadSession = {
    type: 'multipart',
    key,
    uploadId,
    publicUrl: deps.driver.getPublicUrl(key),
    parts,
  };

  await deps.events.emit('after:multipartUpload', {
    context: { data: input, timestamp: new Date() },
    result: session,
    timestamp: new Date(),
  });

  return session;
}

/**
 * Sign a single upload part (for on-demand part signing).
 */
export async function signUploadPart(
  deps: OperationDeps,
  key: string,
  uploadId: string,
  partNumber: number,
  expiresIn?: number,
): Promise<SignedPartResult> {
  if (!deps.driver.signUploadPart) {
    throw new Error(`Driver '${deps.driver.name}' does not support part signing`);
  }
  return deps.driver.signUploadPart(key, uploadId, partNumber, expiresIn);
}

/**
 * Sign multiple upload parts at once.
 */
export async function signUploadParts(
  deps: OperationDeps,
  key: string,
  uploadId: string,
  partNumbers: number[],
  expiresIn?: number,
): Promise<SignedPartResult[]> {
  if (!deps.driver.signUploadPart) {
    throw new Error(`Driver '${deps.driver.name}' does not support part signing`);
  }
  return Promise.all(
    partNumbers.map((pn) => deps.driver.signUploadPart!(key, uploadId, pn, expiresIn)),
  );
}

/**
 * Complete a multipart upload: assemble parts in storage + create DB record.
 * Optionally runs post-upload processing (ThumbHash, variants) for images.
 */
export async function completeMultipartUpload(
  deps: OperationDeps,
  input: CompleteMultipartInput,
  context?: OperationContext,
): Promise<IMediaDocument> {
  if (!deps.driver.completeMultipartUpload) {
    throw new Error(`Driver '${deps.driver.name}' does not support multipart completion`);
  }

  const organizationId = requireTenant(deps, context);

  await deps.events.emit('before:completeMultipart', {
    data: input,
    context,
    timestamp: new Date(),
  });

  try {
    // Enforce the same file policy as upload()/confirmUpload() — MIME type + size checks
    const { allowed = [], maxSize } = deps.config.fileTypes || {};

    if (allowed.length > 0 && !isAllowedMimeType(input.mimeType, allowed)) {
      throw new Error(`File type '${input.mimeType}' is not allowed. Allowed: ${allowed.join(', ')}`);
    }

    if (maxSize && input.size > maxSize) {
      const maxMB = Math.round(maxSize / 1024 / 1024);
      throw new Error(`File size exceeds limit of ${maxMB}MB`);
    }

    // Assemble parts in storage
    const { etag, size } = await deps.driver.completeMultipartUpload(
      input.key,
      input.uploadId,
      input.parts,
    );

    // Use actual size from storage (more reliable than client-reported)
    const actualSize = size || input.size;

    // Re-check actual size from storage against limit (client may have lied)
    if (maxSize && actualSize > maxSize) {
      const maxMB = Math.round(maxSize / 1024 / 1024);
      throw new Error(`File size exceeds limit of ${maxMB}MB`);
    }

    // Hash from ETag (zero cost — already computed by S3 during multipart)
    const hash = etag || computeFileHash(Buffer.from(`${input.key}:${actualSize}`));

    const folder = input.folder || input.key.split('/').slice(0, -1).join('/') || 'uploads';
    const url = deps.driver.getPublicUrl(input.key);
    const title = input.title || generateTitle(input.filename);

    // Create DB record
    let media = await deps.repository.createMedia(
      {
        filename: input.filename,
        originalFilename: input.filename,
        title,
        mimeType: input.mimeType,
        size: actualSize,
        url,
        key: input.key,
        hash,
        status: 'ready',
        folder,
        alt: input.alt,
        variants: [],
        tags: [],
        metadata: {},
        ...(organizationId && { organizationId }),
      },
      context,
    );

    // Optional post-upload processing (same as confirmUpload process flag)
    if (input.process && deps.processor && isImage(input.mimeType)) {
      const mediaIdStr = media._id.toString();
      try {
        // ready → processing — same MEDIA_MACHINE transition used by
        // confirmUpload's reprocess flow.
        const claimed = await assertAndClaim(MEDIA_MACHINE, deps.repository, mediaIdStr, {
          from: 'ready',
          to: 'processing',
          options: context as Record<string, unknown>,
        });
        if (!claimed) {
          log(deps, 'info', 'Skipping post-multipart processing — record not in ready state', {
            key: input.key,
            id: mediaIdStr,
          });
        } else {
          media = claimed;

          const stream = await deps.driver.read(input.key);
          const chunks: Buffer[] = [];
          for await (const chunk of stream) {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as unknown as Uint8Array));
          }
          const buffer = Buffer.concat(chunks);

          const processed = await processImage(deps, {
            buffer,
            filename: input.filename,
            mimeType: input.mimeType,
            skipProcessing: false,
            targetFolder: folder,
            context,
          });

          const payload: Record<string, unknown> = {
            width: processed.width,
            height: processed.height,
            aspectRatio: processed.aspectRatio,
            thumbhash: processed.thumbhash,
            dominantColor: processed.dominantColor,
            exif: processed.exif,
          };
          if (processed.variants.length > 0) {
            payload.variants = processed.variants;
          }

          const finalised = await assertAndClaim(MEDIA_MACHINE, deps.repository, mediaIdStr, {
            from: 'processing',
            to: 'ready',
            patch: payload,
            options: context as Record<string, unknown>,
          });
          if (finalised) media = finalised;
        }
      } catch (processError) {
        // Best-effort revert if we left the record stuck in 'processing'.
        // Same processing → ready transition as the success path.
        try {
          await assertAndClaim(MEDIA_MACHINE, deps.repository, mediaIdStr, {
            from: 'processing',
            to: 'ready',
            options: context as Record<string, unknown>,
          });
        } catch { /* ignore */ }
        log(deps, 'warn', 'Post-multipart processing failed (file still available)', {
          key: input.key,
          error: (processError as Error).message,
        });
      }
    }

    await deps.events.emit('after:completeMultipart', {
      context: { data: input, context, timestamp: new Date() },
      result: media,
      timestamp: new Date(),
    });

    return media;
  } catch (error) {
    await deps.events.emit('error:completeMultipart', {
      context: { data: input, context, timestamp: new Date() },
      error: error as Error,
      timestamp: new Date(),
    });
    throw error;
  }
}

/**
 * Abort a multipart upload and clean up parts in storage.
 */
export async function abortMultipartUpload(
  deps: OperationDeps,
  key: string,
  uploadId: string,
): Promise<void> {
  if (!deps.driver.abortMultipartUpload) {
    throw new Error(`Driver '${deps.driver.name}' does not support multipart abort`);
  }
  await deps.driver.abortMultipartUpload(key, uploadId);
  log(deps, 'info', 'Multipart upload aborted', { key, uploadId });
}

/**
 * Generate presigned PUT URLs for multiple files in parallel.
 * Useful for HLS segment uploads or batch file uploads.
 */
export async function generateBatchPutUrls(
  deps: OperationDeps,
  input: BatchPresignInput,
): Promise<BatchPresignResult> {
  if (!deps.driver.getSignedUploadUrl) {
    throw new Error(`Driver '${deps.driver.name}' does not support presigned uploads`);
  }

  const folder = normalizeFolderPath(input.folder || deps.config.folders?.defaultFolder || 'uploads');

  const uploads = await Promise.all(
    input.files.map((file) => {
      const key = generateKey(file.filename, folder);
      return deps.driver.getSignedUploadUrl!(key, file.contentType, input.expiresIn);
    }),
  );

  return { uploads };
}
