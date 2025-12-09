/**
 * AWS S3 Storage Provider
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

import type { StorageProvider, UploadResult, UploadOptions } from '../types';
import crypto from 'crypto';

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
 * AWS S3 Storage Provider
 */
export class S3Provider implements StorageProvider {
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
   * Generate unique storage key
   */
  private generateKey(filename: string, folder: string): string {
    const timestamp = Date.now();
    const random = crypto.randomBytes(6).toString('hex');
    const safeName = filename.replace(/[^a-zA-Z0-9.-]/g, '_');
    const baseName = safeName.replace(/\.[^/.]+$/, '');
    const ext = safeName.split('.').pop() || 'bin';
    
    return `${folder}/${timestamp}-${random}-${baseName}.${ext}`;
  }

  /**
   * Upload file to S3
   */
  async upload(buffer: Buffer, filename: string, options: UploadOptions = {}): Promise<UploadResult> {
    const { PutObjectCommand } = await import('@aws-sdk/client-s3');
    const client = await this.getClient();
    
    const folder = options.folder || 'uploads';
    const key = this.generateKey(filename, folder);
    
    // Detect MIME type
    const mimeTypes = await import('mime-types');
    const mimeType = mimeTypes.lookup(filename) || 'application/octet-stream';

    const command = new PutObjectCommand({
      Bucket: this.config.bucket,
      Key: key,
      Body: buffer,
      ContentType: mimeType,
      ...(this.config.acl && { ACL: this.config.acl }),
      Metadata: options.metadata,
    });

    await client.send(command);

    // Build public URL
    const url = this.config.publicUrl
      ? `${this.config.publicUrl}/${key}`
      : this.config.endpoint
        ? `${this.config.endpoint}/${this.config.bucket}/${key}`
        : `https://${this.config.bucket}.s3.${this.config.region}.amazonaws.com/${key}`;

    return {
      url,
      key,
      size: buffer.length,
      mimeType,
    };
  }

  /**
   * Delete file from S3
   */
  async delete(key: string): Promise<boolean> {
    const { DeleteObjectCommand } = await import('@aws-sdk/client-s3');
    const client = await this.getClient();

    // Handle full URL - extract key
    const actualKey = this.extractKey(key);

    const command = new DeleteObjectCommand({
      Bucket: this.config.bucket,
      Key: actualKey,
    });

    await client.send(command);
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
    } catch {
      return false;
    }
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
   * Extract storage key from URL or key
   */
  private extractKey(keyOrUrl: string): string {
    // If it's a full URL, extract the key
    if (keyOrUrl.startsWith('http')) {
      // Handle amazonaws.com URLs
      const amazonMatch = keyOrUrl.match(/\.amazonaws\.com\/(.+)$/);
      if (amazonMatch) return decodeURIComponent(amazonMatch[1]);
      
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
