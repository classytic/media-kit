/**
 * Google Cloud Storage Provider
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

import type { StorageProvider, UploadResult, UploadOptions } from '../types';
import crypto from 'crypto';

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
}

/**
 * Google Cloud Storage Provider
 */
export class GCSProvider implements StorageProvider {
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
   * Upload file to GCS
   */
  async upload(buffer: Buffer, filename: string, options: UploadOptions = {}): Promise<UploadResult> {
    const bucket = await this.getStorage();
    
    const folder = options.folder || 'uploads';
    const key = this.generateKey(filename, folder);
    
    // Detect MIME type
    const mimeTypes = await import('mime-types');
    const mimeType = mimeTypes.lookup(filename) || 'application/octet-stream';

    const file = bucket.file(key);
    
    await file.save(buffer, {
      metadata: {
        contentType: mimeType,
        metadata: options.metadata,
      },
    });

    // Make public if configured
    if (this.config.makePublic) {
      await file.makePublic();
    }

    // Build public URL
    const url = this.config.publicUrl
      ? `${this.config.publicUrl}/${key}`
      : `https://storage.googleapis.com/${this.config.bucket}/${key}`;

    return {
      url,
      key,
      size: buffer.length,
      mimeType,
    };
  }

  /**
   * Delete file from GCS
   */
  async delete(key: string): Promise<boolean> {
    const bucket = await this.getStorage();
    const actualKey = this.extractKey(key);

    const file = bucket.file(actualKey);
    await file.delete();
    
    return true;
  }

  /**
   * Check if file exists
   */
  async exists(key: string): Promise<boolean> {
    const bucket = await this.getStorage();
    const actualKey = this.extractKey(key);

    const file = bucket.file(actualKey);
    const [exists] = await file.exists();
    
    return exists;
  }

  /**
   * Get signed URL for private files
   */
  async getSignedUrl(key: string, expiresIn = 3600): Promise<string> {
    const bucket = await this.getStorage();
    const actualKey = this.extractKey(key);

    const file = bucket.file(actualKey);
    const [url] = await file.getSignedUrl({
      action: 'read',
      expires: Date.now() + expiresIn * 1000,
    });
    
    return url;
  }

  /**
   * Extract storage key from URL or key
   */
  private extractKey(keyOrUrl: string): string {
    if (keyOrUrl.startsWith('http')) {
      // Handle storage.googleapis.com URLs
      const gcsMatch = keyOrUrl.match(/storage\.googleapis\.com\/[^/]+\/(.+)$/);
      if (gcsMatch) return decodeURIComponent(gcsMatch[1]);
      
      // Handle custom public URL
      if (this.config.publicUrl && keyOrUrl.startsWith(this.config.publicUrl)) {
        return decodeURIComponent(keyOrUrl.replace(`${this.config.publicUrl}/`, ''));
      }
    }
    
    return keyOrUrl;
  }
}

export default GCSProvider;
