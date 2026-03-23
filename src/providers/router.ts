/**
 * Storage Router — Multi-Storage Driver
 *
 * A StorageDriver implementation that routes operations to different
 * drivers based on key prefixes or custom matchers. Enables using
 * multiple storage backends (S3 + Local, S3 + GCS, etc.) from a
 * single `createMedia()` instance.
 *
 * @example
 * ```ts
 * import { StorageRouter } from '@classytic/media-kit/providers/router';
 * import { S3Provider } from '@classytic/media-kit/providers/s3';
 * import { LocalProvider } from '@classytic/media-kit/providers/local';
 *
 * const router = new StorageRouter({
 *   drivers: {
 *     s3: new S3Provider({ bucket: 'prod', region: 'us-east-1' }),
 *     local: new LocalProvider({ basePath: './uploads', baseUrl: '/uploads' }),
 *   },
 *   routes: [
 *     { prefix: 'temp/', driver: 'local' },
 *     { prefix: 'drafts/', driver: 'local' },
 *   ],
 *   default: 's3',
 * });
 *
 * const media = createMedia({ driver: router });
 * ```
 */

import type { StorageDriver, WriteResult, FileStat, PresignedUploadResult, SignedPartResult, CompletedPart, ResumableUploadSession } from '../types';

/**
 * A single routing rule
 */
export interface RouteRule {
  /** Match keys starting with this prefix (e.g., 'temp/', 'avatars/') */
  prefix?: string;
  /** Custom matcher function for advanced routing */
  match?: (key: string) => boolean;
  /** Name of the driver to route to (must exist in `drivers` map) */
  driver: string;
}

/**
 * Storage Router Configuration
 */
export interface StorageRouterConfig {
  /** Named driver instances */
  drivers: Record<string, StorageDriver>;
  /** Routing rules, evaluated in order (first match wins) */
  routes?: RouteRule[];
  /** Default driver name for keys that don't match any route */
  default: string;
}

/**
 * Storage Router — routes operations to different drivers based on rules
 */
export class StorageRouter implements StorageDriver {
  readonly name = 'router';
  private drivers: Record<string, StorageDriver>;
  private routes: RouteRule[];
  private defaultDriver: StorageDriver;
  /** Tracks which driver owns each resumable session URI */
  private resumableSessions = new Map<string, StorageDriver>();

  constructor(config: StorageRouterConfig) {
    this.drivers = config.drivers;
    this.routes = config.routes ?? [];

    // Validate default driver exists
    const defaultDriver = this.drivers[config.default];
    if (!defaultDriver) {
      throw new Error(
        `StorageRouter: default driver '${config.default}' not found in drivers. ` +
        `Available: ${Object.keys(this.drivers).join(', ')}`,
      );
    }
    this.defaultDriver = defaultDriver;

    // Validate all route driver references
    for (const rule of this.routes) {
      if (!this.drivers[rule.driver]) {
        throw new Error(
          `StorageRouter: route references driver '${rule.driver}' which is not in drivers. ` +
          `Available: ${Object.keys(this.drivers).join(', ')}`,
        );
      }
      if (!rule.prefix && !rule.match) {
        throw new Error(
          `StorageRouter: route for driver '${rule.driver}' must have either 'prefix' or 'match'`,
        );
      }
    }
  }

  /**
   * Resolve which driver handles a given key.
   * Evaluates routes in order; first match wins. Falls back to default.
   */
  resolve(key: string): StorageDriver {
    for (const rule of this.routes) {
      if (rule.prefix && key.startsWith(rule.prefix)) {
        return this.drivers[rule.driver]!;
      }
      if (rule.match && rule.match(key)) {
        return this.drivers[rule.driver]!;
      }
    }
    return this.defaultDriver;
  }

  /**
   * Get a named driver directly (useful for advanced scenarios)
   */
  getDriver(name: string): StorageDriver {
    const driver = this.drivers[name];
    if (!driver) {
      throw new Error(
        `StorageRouter: driver '${name}' not found. Available: ${Object.keys(this.drivers).join(', ')}`,
      );
    }
    return driver;
  }

  // ============================================
  // CORE METHODS (delegate to resolved driver)
  // ============================================

  async write(key: string, data: Buffer | NodeJS.ReadableStream, contentType: string): Promise<WriteResult> {
    return this.resolve(key).write(key, data, contentType);
  }

  async read(key: string, range?: { start: number; end: number }): Promise<NodeJS.ReadableStream> {
    return this.resolve(key).read(key, range);
  }

  async delete(key: string): Promise<boolean> {
    return this.resolve(key).delete(key);
  }

  async exists(key: string): Promise<boolean> {
    return this.resolve(key).exists(key);
  }

  async stat(key: string): Promise<FileStat> {
    return this.resolve(key).stat(key);
  }

  getPublicUrl(key: string): string {
    return this.resolve(key).getPublicUrl(key);
  }

  // ============================================
  // NAVIGATION METHODS
  // ============================================

  async *list(prefix: string): AsyncIterable<string> {
    const driver = this.resolve(prefix);
    if (!driver.list) {
      return;
    }
    yield* driver.list(prefix);
  }

  async copy(source: string, destination: string): Promise<WriteResult> {
    const srcDriver = this.resolve(source);
    const dstDriver = this.resolve(destination);

    // Same driver — delegate directly if it supports copy
    if (srcDriver === dstDriver && srcDriver.copy) {
      return srcDriver.copy(source, destination);
    }

    // Cross-driver copy: read from source → write to destination
    const stat = await srcDriver.stat(source);
    const stream = await srcDriver.read(source);
    return dstDriver.write(destination, stream, stat.contentType);
  }

  async move(source: string, destination: string): Promise<WriteResult> {
    const srcDriver = this.resolve(source);
    const dstDriver = this.resolve(destination);

    // Same driver — delegate directly if it supports move
    if (srcDriver === dstDriver && srcDriver.move) {
      return srcDriver.move(source, destination);
    }

    // Cross-driver move: copy + delete
    const result = await this.copy(source, destination);
    await srcDriver.delete(source);
    return result;
  }

  // ============================================
  // URL METHODS (delegate if supported)
  // ============================================

  async getSignedUrl(key: string, expiresIn?: number): Promise<string> {
    const driver = this.resolve(key);
    if (!driver.getSignedUrl) {
      throw new Error(`Driver '${driver.name}' does not support signed URLs`);
    }
    return driver.getSignedUrl(key, expiresIn);
  }

  async getSignedUploadUrl(key: string, contentType: string, expiresIn?: number): Promise<PresignedUploadResult> {
    const driver = this.resolve(key);
    if (!driver.getSignedUploadUrl) {
      throw new Error(`Driver '${driver.name}' does not support presigned upload URLs`);
    }
    return driver.getSignedUploadUrl(key, contentType, expiresIn);
  }

  // ============================================
  // MULTIPART UPLOAD METHODS (S3-style)
  // ============================================

  async createMultipartUpload(key: string, contentType: string): Promise<{ uploadId: string }> {
    const driver = this.resolve(key);
    if (!driver.createMultipartUpload) {
      throw new Error(`Driver '${driver.name}' does not support multipart uploads`);
    }
    return driver.createMultipartUpload(key, contentType);
  }

  async signUploadPart(key: string, uploadId: string, partNumber: number, expiresIn?: number): Promise<SignedPartResult> {
    const driver = this.resolve(key);
    if (!driver.signUploadPart) {
      throw new Error(`Driver '${driver.name}' does not support multipart part signing`);
    }
    return driver.signUploadPart(key, uploadId, partNumber, expiresIn);
  }

  async completeMultipartUpload(key: string, uploadId: string, parts: CompletedPart[]): Promise<{ etag: string; size: number }> {
    const driver = this.resolve(key);
    if (!driver.completeMultipartUpload) {
      throw new Error(`Driver '${driver.name}' does not support multipart completion`);
    }
    return driver.completeMultipartUpload(key, uploadId, parts);
  }

  async abortMultipartUpload(key: string, uploadId: string): Promise<void> {
    const driver = this.resolve(key);
    if (!driver.abortMultipartUpload) {
      throw new Error(`Driver '${driver.name}' does not support multipart abort`);
    }
    return driver.abortMultipartUpload(key, uploadId);
  }

  // ============================================
  // RESUMABLE UPLOAD METHODS (GCS-style)
  // ============================================

  async createResumableUpload(key: string, contentType: string, options?: { size?: number }): Promise<ResumableUploadSession> {
    const driver = this.resolve(key);
    if (!driver.createResumableUpload) {
      throw new Error(`Driver '${driver.name}' does not support resumable uploads`);
    }
    const session = await driver.createResumableUpload(key, contentType, options);
    // Track which driver owns this session for abort/status calls
    this.resumableSessions.set(session.uploadUrl, driver);
    return session;
  }

  async abortResumableUpload(sessionUri: string): Promise<void> {
    const driver = this.resumableSessions.get(sessionUri) ?? this.defaultDriver;
    if (!driver.abortResumableUpload) {
      throw new Error(`Driver '${driver.name}' does not support resumable abort`);
    }
    this.resumableSessions.delete(sessionUri);
    return driver.abortResumableUpload(sessionUri);
  }

  async getResumableUploadStatus(sessionUri: string): Promise<{ uploadedBytes: number }> {
    const driver = this.resumableSessions.get(sessionUri) ?? this.defaultDriver;
    if (!driver.getResumableUploadStatus) {
      throw new Error(`Driver '${driver.name}' does not support resumable status query`);
    }
    return driver.getResumableUploadStatus(sessionUri);
  }
}

export default StorageRouter;
