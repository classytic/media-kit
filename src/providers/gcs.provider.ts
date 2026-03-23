/**
 * Google Cloud Storage Provider
 *
 * Full-featured GCS storage driver with retry, presigned uploads, streaming,
 * range reads, listing, and copy/move operations.
 *
 * @example
 * ```ts
 * import { GCSProvider } from '@classytic/media-kit/providers/gcs';
 *
 * const gcs = new GCSProvider({
 *   bucket: 'my-bucket',
 *   projectId: 'my-project',
 *   keyFilename: './service-account.json',
 * });
 * ```
 */

import type { StorageDriver, WriteResult, FileStat, PresignedUploadResult, ResumableUploadSession } from '../types';
import { withRetry, type RetryOptions } from '../utils/retry';
import { Readable, pipeline } from 'stream';
import { promisify } from 'util';

const pipelineAsync = promisify(pipeline);

/**
 * GCS Provider Configuration
 */
export interface GCSProviderConfig {
  /** GCS bucket name */
  bucket: string;
  /** Google Cloud project ID */
  projectId?: string;
  /** Path to service account key file */
  keyFilename?: string;
  /** Service account credentials object */
  credentials?: {
    client_email: string;
    private_key: string;
  };
  /** Custom public URL (CDN) */
  publicUrl?: string;
  /** Make files publicly accessible */
  makePublic?: boolean;
  /** Retry configuration for transient failures */
  retry?: RetryOptions;
}

/**
 * Google Cloud Storage Driver
 */
export class GCSProvider implements StorageDriver {
  readonly name = 'gcs';
  private storage: any;
  private bucketInstance: any;
  private config: GCSProviderConfig;

  constructor(config: GCSProviderConfig) {
    this.config = {
      makePublic: true,
      ...config,
    };
  }

  private async getStorage() {
    if (!this.storage) {
      try {
        const { Storage } = await import('@google-cloud/storage');

        this.storage = new Storage({
          projectId: this.config.projectId,
          keyFilename: this.config.keyFilename,
          credentials: this.config.credentials,
        });

        this.bucketInstance = this.storage.bucket(this.config.bucket);
      } catch {
        throw new Error(
          '@google-cloud/storage is required for GCSProvider. Install it with: npm install @google-cloud/storage'
        );
      }
    }
    return this.bucketInstance;
  }

  /**
   * Get retry options (merged with defaults)
   */
  private getRetryOptions(): RetryOptions {
    return {
      maxRetries: 3,
      baseDelay: 100,
      maxDelay: 5000,
      backoffMultiplier: 2,
      ...this.config.retry,
    };
  }

  /**
   * Build the public URL for a given storage key
   */
  getPublicUrl(key: string): string {
    return this.config.publicUrl
      ? `${this.config.publicUrl}/${key}`
      : `https://storage.googleapis.com/${this.config.bucket}/${key}`;
  }

  /**
   * Extract storage key from URL or key
   */
  private extractKey(keyOrUrl: string): string {
    if (keyOrUrl.startsWith('http')) {
      const gcsMatch = keyOrUrl.match(/storage\.googleapis\.com\/[^/]+\/(.+)$/);
      if (gcsMatch) return decodeURIComponent(gcsMatch[1]!);

      if (this.config.publicUrl && keyOrUrl.startsWith(this.config.publicUrl)) {
        return decodeURIComponent(keyOrUrl.replace(`${this.config.publicUrl}/`, ''));
      }
    }

    return keyOrUrl;
  }

  /**
   * Write data to GCS. Accepts Buffer or ReadableStream.
   */
  async write(key: string, data: Buffer | NodeJS.ReadableStream, contentType: string): Promise<WriteResult> {
    const bucket = await this.getStorage();
    const file = bucket.file(key);

    if (Buffer.isBuffer(data)) {
      await withRetry(
        () => file.save(data, {
          metadata: {
            contentType,
          },
        }),
        this.getRetryOptions()
      );
    } else {
      const writable = file.createWriteStream({
        metadata: {
          contentType,
        },
        resumable: false,
      });

      await withRetry(
        () => pipelineAsync(data as NodeJS.ReadableStream, writable),
        this.getRetryOptions()
      );
    }

    if (this.config.makePublic) {
      await withRetry(() => file.makePublic(), this.getRetryOptions());
    }

    const fileStat = await this.stat(key);

    return {
      key,
      url: this.getPublicUrl(key),
      size: fileStat.size,
    };
  }

  /**
   * Read a file as a stream. Supports optional byte-range for partial reads.
   */
  async read(key: string, range?: { start: number; end: number }): Promise<NodeJS.ReadableStream> {
    const bucket = await this.getStorage();
    const actualKey = this.extractKey(key);
    const file = bucket.file(actualKey);

    if (range) {
      return file.createReadStream({ start: range.start, end: range.end });
    }

    return file.createReadStream();
  }

  /**
   * Delete file from GCS (returns false if not found instead of throwing)
   */
  async delete(key: string): Promise<boolean> {
    const bucket = await this.getStorage();
    const actualKey = this.extractKey(key);
    const file = bucket.file(actualKey);

    try {
      await withRetry(() => file.delete(), this.getRetryOptions());
      return true;
    } catch (err: any) {
      if (err?.code === 404 || err?.errors?.[0]?.reason === 'notFound') {
        return false;
      }
      throw err;
    }
  }

  /**
   * Check if file exists
   */
  async exists(key: string): Promise<boolean> {
    const bucket = await this.getStorage();
    const actualKey = this.extractKey(key);
    const file = bucket.file(actualKey);

    const result = await withRetry<[boolean]>(() => file.exists(), this.getRetryOptions());
    return result[0];
  }

  /**
   * Get file metadata without downloading
   */
  async stat(key: string): Promise<FileStat> {
    const bucket = await this.getStorage();
    const actualKey = this.extractKey(key);
    const file = bucket.file(actualKey);

    const result = await withRetry<[any]>(() => file.getMetadata(), this.getRetryOptions());
    const metadata = result[0];

    return {
      size: parseInt(metadata.size, 10) || 0,
      contentType: metadata.contentType || 'application/octet-stream',
      lastModified: metadata.updated ? new Date(metadata.updated) : undefined,
      etag: metadata.etag,
      metadata: metadata.metadata,
    };
  }

  /**
   * List files under a prefix (async generator for memory efficiency)
   */
  async *list(prefix: string): AsyncIterable<string> {
    const bucket = await this.getStorage();
    const [files] = await withRetry<[any[]]>(
      () => bucket.getFiles({ prefix }),
      this.getRetryOptions()
    );

    for (const file of files) {
      yield file.name as string;
    }
  }

  /**
   * Copy a file to a new location within the same bucket
   */
  async copy(source: string, destination: string): Promise<WriteResult> {
    const bucket = await this.getStorage();
    const actualSource = this.extractKey(source);
    const actualDest = this.extractKey(destination);

    const sourceFile = bucket.file(actualSource);
    const destFile = bucket.file(actualDest);

    await withRetry(() => sourceFile.copy(destFile), this.getRetryOptions());

    if (this.config.makePublic) {
      await withRetry(() => destFile.makePublic(), this.getRetryOptions());
    }

    const fileStat = await this.stat(actualDest);

    return {
      key: actualDest,
      url: this.getPublicUrl(actualDest),
      size: fileStat.size,
    };
  }

  /**
   * Move a file to a new location (copy + delete)
   */
  async move(source: string, destination: string): Promise<WriteResult> {
    const result = await this.copy(source, destination);
    await this.delete(source);
    return result;
  }

  /**
   * Get a temporary signed URL for reading a private file
   */
  async getSignedUrl(key: string, expiresIn = 3600): Promise<string> {
    const bucket = await this.getStorage();
    const actualKey = this.extractKey(key);
    const file = bucket.file(actualKey);

    const [url] = await file.getSignedUrl({
      version: 'v4',
      action: 'read',
      expires: Date.now() + expiresIn * 1000,
    });

    return url;
  }

  /**
   * Get a presigned URL for direct client-side uploads (PUT)
   */
  async getSignedUploadUrl(key: string, contentType: string, expiresIn = 3600): Promise<PresignedUploadResult> {
    const bucket = await this.getStorage();
    const actualKey = this.extractKey(key);
    const file = bucket.file(actualKey);

    const [uploadUrl] = await file.getSignedUrl({
      version: 'v4',
      action: 'write',
      expires: Date.now() + expiresIn * 1000,
      contentType,
    });

    return {
      uploadUrl,
      key: actualKey,
      publicUrl: this.getPublicUrl(actualKey),
      expiresIn,
      headers: { 'Content-Type': contentType },
    };
  }
  // ============================================
  // RESUMABLE UPLOAD (chunked, resume-after-failure)
  // ============================================

  /**
   * Create a resumable upload session.
   * Returns a session URI — client sends chunks to this URI with Content-Range headers.
   *
   * Client chunk protocol:
   *   PUT [sessionUri]
   *   Content-Range: bytes 0-262143/1048576
   *   [chunk data]
   *   → 308 Resume Incomplete (more chunks needed)
   *   → 200/201 (upload complete on final chunk)
   */
  async createResumableUpload(
    key: string,
    contentType: string,
    options?: { size?: number },
  ): Promise<ResumableUploadSession> {
    const bucket = await this.getStorage();
    const actualKey = this.extractKey(key);
    const file = bucket.file(actualKey);

    const [uploadUrl] = await file.createResumableUpload({
      metadata: { contentType },
      ...(options?.size && { contentLength: options.size }),
    });

    return {
      uploadUrl,
      key: actualKey,
      publicUrl: this.getPublicUrl(actualKey),
      minChunkSize: 256 * 1024, // 256KB — GCS minimum
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 days
    };
  }

  /**
   * Abort a resumable upload session.
   * Sends DELETE to the session URI to cancel and clean up.
   */
  async abortResumableUpload(sessionUri: string): Promise<void> {
    try {
      await fetch(sessionUri, { method: 'DELETE' });
    } catch {
      // Session may already be expired/completed — ignore
    }
  }

  /**
   * Query resumable upload status — how many bytes GCS has received.
   * Useful for resume-after-failure: start next chunk at uploadedBytes offset.
   * Returns -1 for uploadedBytes if upload is already complete.
   */
  async getResumableUploadStatus(sessionUri: string): Promise<{ uploadedBytes: number }> {
    try {
      const response = await fetch(sessionUri, {
        method: 'PUT',
        headers: {
          'Content-Length': '0',
          'Content-Range': 'bytes */*',
        },
      });

      if (response.status === 308) {
        // 308 Resume Incomplete — parse Range header
        const range = response.headers.get('range');
        const match = range?.match(/bytes=(\d+)-(\d+)/);
        return { uploadedBytes: match ? parseInt(match[2]!) + 1 : 0 };
      }

      if (response.status === 200 || response.status === 201) {
        // Upload already complete
        return { uploadedBytes: -1 };
      }

      return { uploadedBytes: 0 };
    } catch {
      return { uploadedBytes: 0 };
    }
  }
}

export default GCSProvider;
