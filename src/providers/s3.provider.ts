/**
 * AWS S3 Storage Driver
 *
 * Implements the StorageDriver interface for AWS S3 and S3-compatible
 * services (MinIO, Cloudflare R2, DigitalOcean Spaces, etc.)
 *
 * @example
 * ```ts
 * import { S3Provider } from '@classytic/media-kit/providers/s3';
 *
 * const s3 = new S3Provider({
 *   bucket: 'my-bucket',
 *   region: 'us-east-1',
 *   credentials: {
 *     accessKeyId: process.env.AWS_ACCESS_KEY_ID,
 *     secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
 *   },
 * });
 * ```
 */

import type { StorageDriver, WriteResult, FileStat, PresignedUploadResult, SignedPartResult, CompletedPart } from '../types';
import { withRetry, type RetryOptions } from '../utils/retry';

/**
 * S3 Provider Configuration
 */
export interface S3ProviderConfig {
  /** S3 bucket name */
  bucket: string;
  /** AWS region */
  region: string;
  /** AWS credentials */
  credentials?: {
    accessKeyId: string;
    secretAccessKey: string;
  };
  /** Custom endpoint (for S3-compatible services like MinIO, R2) */
  endpoint?: string;
  /** Custom public URL (CDN) */
  publicUrl?: string;
  /** ACL for uploaded files */
  acl?: 'private' | 'public-read' | 'authenticated-read';
  /** Force path style (for S3-compatible services) */
  forcePathStyle?: boolean;
}

/**
 * AWS S3 Storage Driver
 */
export class S3Provider implements StorageDriver {
  readonly name = 's3';
  private client: any;
  private config: S3ProviderConfig;
  private sdkAvailable = false;
  private initError: Error | null = null;

  constructor(config: S3ProviderConfig) {
    this.config = {
      acl: undefined,
      ...config,
    };
    // Don't initialize immediately - let it fail gracefully on first use
  }

  private async initClient(): Promise<void> {
    if (this.sdkAvailable) return;
    if (this.initError) throw this.initError;

    // Lazy load AWS SDK to keep it optional
    try {
      const { S3Client } = await import('@aws-sdk/client-s3');

      this.client = new S3Client({
        region: this.config.region,
        credentials: this.config.credentials,
        endpoint: this.config.endpoint,
        forcePathStyle: this.config.forcePathStyle,
      });

      this.sdkAvailable = true;
    } catch (error) {
      this.initError = new Error(
        '@aws-sdk/client-s3 is required for S3Provider. Install it with: npm install @aws-sdk/client-s3'
      );
      throw this.initError;
    }
  }

  private async getClient() {
    if (!this.client) {
      await this.initClient();
    }
    return this.client;
  }

  /**
   * Get retry options for S3 operations
   */
  private getRetryOptions(): RetryOptions {
    return {
      maxRetries: 3,
      baseDelay: 100,
      maxDelay: 5000,
      backoffMultiplier: 2,
    };
  }

  /**
   * Write data to S3 with automatic retry on transient failures.
   * Accepts Buffer or ReadableStream. The key is provided by the caller.
   */
  async write(key: string, data: Buffer | NodeJS.ReadableStream, contentType: string): Promise<WriteResult> {
    const { PutObjectCommand } = await import('@aws-sdk/client-s3');
    const client = await this.getClient();

    const command = new PutObjectCommand({
      Bucket: this.config.bucket,
      Key: key,
      Body: data as any,
      ContentType: contentType,
      ...(this.config.acl && { ACL: this.config.acl }),
    });

    await withRetry(
      () => client.send(command),
      this.getRetryOptions()
    );

    const url = this.getPublicUrl(key);

    // Determine size: if Buffer we know it, otherwise stat after write
    let size: number;
    if (Buffer.isBuffer(data)) {
      size = data.length;
    } else {
      const stat = await this.stat(key);
      size = stat.size;
    }

    return {
      key,
      url,
      size,
    };
  }

  /**
   * Read a file as a stream. Supports optional byte-range for partial reads
   * (useful for video streaming / Range header support).
   */
  async read(key: string, range?: { start: number; end: number }): Promise<NodeJS.ReadableStream> {
    const { GetObjectCommand } = await import('@aws-sdk/client-s3');
    const client = await this.getClient();

    const actualKey = this.extractKey(key);

    const commandInput: any = {
      Bucket: this.config.bucket,
      Key: actualKey,
    };

    if (range) {
      commandInput.Range = `bytes=${range.start}-${range.end}`;
    }

    const command = new GetObjectCommand(commandInput);

    const response: any = await withRetry(() => client.send(command), this.getRetryOptions());
    return response.Body as NodeJS.ReadableStream;
  }

  /**
   * Delete file from S3 with automatic retry
   */
  async delete(key: string): Promise<boolean> {
    const { DeleteObjectCommand } = await import('@aws-sdk/client-s3');
    const client = await this.getClient();

    const actualKey = this.extractKey(key);

    const command = new DeleteObjectCommand({
      Bucket: this.config.bucket,
      Key: actualKey,
    });

    await withRetry(
      () => client.send(command),
      this.getRetryOptions()
    );
    return true;
  }

  /**
   * Check if file exists
   */
  async exists(key: string): Promise<boolean> {
    const { HeadObjectCommand } = await import('@aws-sdk/client-s3');
    const client = await this.getClient();

    const actualKey = this.extractKey(key);

    try {
      await client.send(new HeadObjectCommand({
        Bucket: this.config.bucket,
        Key: actualKey,
      }));
      return true;
    } catch (err: any) {
      if (err.name === 'NotFound' || err.$metadata?.httpStatusCode === 404) {
        return false;
      }
      throw err;
    }
  }

  /**
   * Get file metadata without downloading
   */
  async stat(key: string): Promise<FileStat> {
    const { HeadObjectCommand } = await import('@aws-sdk/client-s3');
    const client = await this.getClient();

    const actualKey = this.extractKey(key);
    const response: any = await withRetry(
      () => client.send(new HeadObjectCommand({
        Bucket: this.config.bucket,
        Key: actualKey,
      })),
      this.getRetryOptions()
    );

    return {
      size: response.ContentLength || 0,
      contentType: response.ContentType || 'application/octet-stream',
      lastModified: response.LastModified,
      etag: response.ETag,
      metadata: response.Metadata,
    };
  }

  /**
   * List files under a prefix (async generator for memory efficiency).
   * Yields storage keys matching the given prefix.
   */
  async *list(prefix: string): AsyncIterable<string> {
    const { ListObjectsV2Command } = await import('@aws-sdk/client-s3');
    const client = await this.getClient();

    let continuationToken: string | undefined;

    do {
      const command = new ListObjectsV2Command({
        Bucket: this.config.bucket,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      });

      const response: any = await withRetry(() => client.send(command), this.getRetryOptions());

      if (response.Contents) {
        for (const object of response.Contents) {
          if (object.Key) {
            yield object.Key;
          }
        }
      }

      continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
    } while (continuationToken);
  }

  /**
   * Copy a file to a new location within the same bucket
   */
  async copy(source: string, destination: string): Promise<WriteResult> {
    const { CopyObjectCommand } = await import('@aws-sdk/client-s3');
    const client = await this.getClient();

    const actualSource = this.extractKey(source);
    const actualDest = this.extractKey(destination);

    const command = new CopyObjectCommand({
      Bucket: this.config.bucket,
      CopySource: `${this.config.bucket}/${actualSource}`,
      Key: actualDest,
      ...(this.config.acl && { ACL: this.config.acl }),
    });

    await withRetry(() => client.send(command), this.getRetryOptions());

    // Get the size of the copied file for the WriteResult
    const stat = await this.stat(actualDest);

    return {
      key: actualDest,
      url: this.getPublicUrl(actualDest),
      size: stat.size,
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
   * Build public URL for a storage key
   */
  getPublicUrl(key: string): string {
    if (this.config.publicUrl) return `${this.config.publicUrl}/${key}`;
    if (this.config.endpoint) return `${this.config.endpoint}/${this.config.bucket}/${key}`;
    return `https://${this.config.bucket}.s3.${this.config.region}.amazonaws.com/${key}`;
  }

  /**
   * Get signed URL for private files
   */
  async getSignedUrl(key: string, expiresIn = 3600): Promise<string> {
    const { GetObjectCommand } = await import('@aws-sdk/client-s3');
    const { getSignedUrl } = await import('@aws-sdk/s3-request-presigner');
    const client = await this.getClient();

    const actualKey = this.extractKey(key);

    const command = new GetObjectCommand({
      Bucket: this.config.bucket,
      Key: actualKey,
    });

    return getSignedUrl(client, command, { expiresIn });
  }

  /**
   * Get presigned URL for direct browser uploads (PUT)
   */
  async getSignedUploadUrl(key: string, contentType: string, expiresIn = 3600): Promise<PresignedUploadResult> {
    const { PutObjectCommand } = await import('@aws-sdk/client-s3');
    const { getSignedUrl } = await import('@aws-sdk/s3-request-presigner');
    const client = await this.getClient();

    const actualKey = this.extractKey(key);

    const command = new PutObjectCommand({
      Bucket: this.config.bucket,
      Key: actualKey,
      ContentType: contentType,
      ...(this.config.acl && { ACL: this.config.acl }),
    });

    const uploadUrl = await getSignedUrl(client, command, { expiresIn });

    return {
      uploadUrl,
      key: actualKey,
      publicUrl: this.getPublicUrl(actualKey),
      expiresIn,
      headers: { 'Content-Type': contentType },
    };
  }

  // ============================================
  // MULTIPART UPLOAD (presigned per-part uploads)
  // ============================================

  /**
   * Initiate a multipart upload session.
   * Returns an uploadId used to sign parts and complete/abort the upload.
   */
  async createMultipartUpload(key: string, contentType: string): Promise<{ uploadId: string }> {
    const { CreateMultipartUploadCommand } = await import('@aws-sdk/client-s3');
    const client = await this.getClient();
    const actualKey = this.extractKey(key);

    const command = new CreateMultipartUploadCommand({
      Bucket: this.config.bucket,
      Key: actualKey,
      ContentType: contentType,
      ...(this.config.acl && { ACL: this.config.acl }),
    });

    const response: any = await client.send(command);
    return { uploadId: response.UploadId! };
  }

  /**
   * Generate a presigned URL for uploading a single part.
   * Client PUTs the chunk data to the returned URL, then sends back the ETag from the response.
   */
  async signUploadPart(
    key: string,
    uploadId: string,
    partNumber: number,
    expiresIn = 3600,
  ): Promise<SignedPartResult> {
    const { UploadPartCommand } = await import('@aws-sdk/client-s3');
    const { getSignedUrl } = await import('@aws-sdk/s3-request-presigner');
    const client = await this.getClient();
    const actualKey = this.extractKey(key);

    const command = new UploadPartCommand({
      Bucket: this.config.bucket,
      Key: actualKey,
      UploadId: uploadId,
      PartNumber: partNumber,
    });

    const uploadUrl = await getSignedUrl(client, command, { expiresIn });
    return { uploadUrl, partNumber, expiresIn };
  }

  /**
   * Complete a multipart upload by assembling all parts.
   * Parts are sorted by partNumber before assembly.
   */
  async completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: CompletedPart[],
  ): Promise<{ etag: string; size: number }> {
    const { CompleteMultipartUploadCommand } = await import('@aws-sdk/client-s3');
    const client = await this.getClient();
    const actualKey = this.extractKey(key);

    const command = new CompleteMultipartUploadCommand({
      Bucket: this.config.bucket,
      Key: actualKey,
      UploadId: uploadId,
      MultipartUpload: {
        Parts: parts
          .sort((a, b) => a.partNumber - b.partNumber)
          .map((p) => ({ PartNumber: p.partNumber, ETag: p.etag })),
      },
    });

    const response: any = await client.send(command);
    const fileStat = await this.stat(actualKey);
    return { etag: response.ETag || '', size: fileStat.size };
  }

  /**
   * Abort a multipart upload and clean up all uploaded parts.
   */
  async abortMultipartUpload(key: string, uploadId: string): Promise<void> {
    const { AbortMultipartUploadCommand } = await import('@aws-sdk/client-s3');
    const client = await this.getClient();
    const actualKey = this.extractKey(key);

    const command = new AbortMultipartUploadCommand({
      Bucket: this.config.bucket,
      Key: actualKey,
      UploadId: uploadId,
    });

    await client.send(command);
  }

  /**
   * Extract storage key from URL or key.
   * Handles full URLs (amazonaws.com, custom endpoint, CDN) and plain keys.
   */
  private extractKey(keyOrUrl: string): string {
    // If it's a full URL, extract the key
    if (keyOrUrl.startsWith('http')) {
      // Handle amazonaws.com URLs
      const amazonMatch = keyOrUrl.match(/\.amazonaws\.com\/(.+)$/);
      if (amazonMatch) return decodeURIComponent(amazonMatch[1]!);

      // Handle custom public URL
      if (this.config.publicUrl && keyOrUrl.startsWith(this.config.publicUrl)) {
        return decodeURIComponent(keyOrUrl.replace(`${this.config.publicUrl}/`, ''));
      }

      // Handle endpoint URLs
      if (this.config.endpoint && keyOrUrl.startsWith(this.config.endpoint)) {
        const path = keyOrUrl.replace(`${this.config.endpoint}/${this.config.bucket}/`, '');
        return decodeURIComponent(path);
      }
    }

    return keyOrUrl;
  }
}

export default S3Provider;
