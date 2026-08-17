/**
 * Storage Router — Multi-Storage Driver
 *
 * A StorageDriver implementation that routes operations to different
 * drivers based on key prefixes or custom matchers. Enables using
 * multiple storage backends (S3 + Local, S3 + GCS, etc.) from a
 * single media engine instance.
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
 * const engine = await defineMedia({}).bind(connection, { driver: router });
 * ```
 */

import type {
  StorageDriver,
  WriteResult,
  FileStat,
  PresignedUploadResult,
  SignedPartResult,
  CompletedPart,
  ResumableUploadSession,
} from '../types/storage.js';

export type { StorageDriver, WriteResult, FileStat } from '../types/storage.js';

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
        throw new Error(`StorageRouter: route for driver '${rule.driver}' must have either 'prefix' or 'match'`);
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
      if (rule.match?.(key)) {
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
      throw new Error(`StorageRouter: driver '${name}' not found. Available: ${Object.keys(this.drivers).join(', ')}`);
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

  async signUploadPart(
    key: string,
    uploadId: string,
    partNumber: number,
    expiresIn?: number,
  ): Promise<SignedPartResult> {
    const driver = this.resolve(key);
    if (!driver.signUploadPart) {
      throw new Error(`Driver '${driver.name}' does not support multipart part signing`);
    }
    return driver.signUploadPart(key, uploadId, partNumber, expiresIn);
  }

  async completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: CompletedPart[],
  ): Promise<{ etag: string; size: number }> {
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

  /**
   * Which route driver a resumable session belongs to is encoded into the
   * returned `uploadUrl` as a URL FRAGMENT (`#__mkdriver=<name>`). A fragment
   * is client-side only — never sent over HTTP — so the provider receives the
   * clean URI when the client PUTs chunks, while abort/status (which round-trip
   * the full string) can resolve the owning driver STATELESSLY: correct after a
   * restart and on any replica, no shared map required. The in-memory map stays
   * as a same-process fast path (and a safety net if a client strips the tag).
   */
  private static readonly DRIVER_TAG = '__mkdriver';

  private tagSessionUri(uri: string, driverName: string): string {
    const sep = uri.includes('#') ? '&' : '#';
    return `${uri}${sep}${StorageRouter.DRIVER_TAG}=${encodeURIComponent(driverName)}`;
  }

  /** Resolve the owning driver + the provider-facing (untagged) URI, or fail loudly. */
  private resolveResumable(sessionUri: string): { driver: StorageDriver; cleanUri: string } {
    const hashIdx = sessionUri.indexOf('#');
    if (hashIdx >= 0) {
      const tagged = new URLSearchParams(sessionUri.slice(hashIdx + 1)).get(StorageRouter.DRIVER_TAG);
      if (tagged) {
        const driver = this.drivers[tagged];
        if (!driver) {
          throw new Error(
            `StorageRouter: resumable session names unknown driver '${tagged}'. ` +
              `Available: ${Object.keys(this.drivers).join(', ')}`,
          );
        }
        return { driver, cleanUri: sessionUri.slice(0, hashIdx) };
      }
    }
    const mapped = this.resumableSessions.get(sessionUri);
    if (mapped) return { driver: mapped, cleanUri: sessionUri };
    // No silent default: a mis-routed abort/status could target — or fail to
    // clean up — the wrong provider. Fail explicitly instead.
    throw new Error(
      'StorageRouter: cannot resolve the storage driver for this resumable session — its driver tag is ' +
        'missing and the router has no in-memory record (likely an app restart or a different replica). ' +
        'Route resumable uploads to a single provider, or ensure the client round-trips the full uploadUrl.',
    );
  }

  async createResumableUpload(
    key: string,
    contentType: string,
    options?: { size?: number },
  ): Promise<ResumableUploadSession> {
    const driver = this.resolve(key);
    if (!driver.createResumableUpload) {
      throw new Error(`Driver '${driver.name}' does not support resumable uploads`);
    }
    const session = await driver.createResumableUpload(key, contentType, options);
    // Encode the owning driver into the URL the client round-trips, and keep
    // the same-process map keyed by that same (tagged) URL.
    const uploadUrl = this.tagSessionUri(session.uploadUrl, driver.name);
    this.resumableSessions.set(uploadUrl, driver);
    return { ...session, uploadUrl };
  }

  async abortResumableUpload(sessionUri: string): Promise<void> {
    const { driver, cleanUri } = this.resolveResumable(sessionUri);
    if (!driver.abortResumableUpload) {
      throw new Error(`Driver '${driver.name}' does not support resumable abort`);
    }
    this.resumableSessions.delete(sessionUri);
    return driver.abortResumableUpload(cleanUri);
  }

  async getResumableUploadStatus(sessionUri: string): Promise<{ uploadedBytes: number }> {
    const { driver, cleanUri } = this.resolveResumable(sessionUri);
    if (!driver.getResumableUploadStatus) {
      throw new Error(`Driver '${driver.name}' does not support resumable status query`);
    }
    return driver.getResumableUploadStatus(cleanUri);
  }
}
