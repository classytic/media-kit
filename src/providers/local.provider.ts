/**
 * Local Filesystem Storage Driver
 *
 * Implements the StorageDriver interface using Node.js built-in
 * `fs` and `path` modules. Zero external dependencies.
 *
 * Ideal for development, testing, self-hosted deployments, or
 * hybrid setups via StorageRouter (local + cloud).
 *
 * @example
 * ```ts
 * import { LocalProvider } from '@classytic/media-kit/providers/local';
 *
 * const local = new LocalProvider({
 *   basePath: './uploads',
 *   baseUrl: 'http://localhost:3000/uploads',
 * });
 * ```
 */

import { createReadStream, createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { StorageDriver, WriteResult, FileStat, PresignedUploadResult } from '../types/storage.js';
import { getMimeType } from '../utils/mime';
import { createUrlSigner, type UrlSigner } from '../signing/index.js';
import { MEDIA_ERROR_CODES, mediaError } from '../errors.js';

export type { StorageDriver, WriteResult, FileStat } from '../types/storage.js';

/**
 * Local Provider Configuration
 */
export interface LocalProviderConfig {
  /** Root directory for file storage (absolute or relative to cwd) */
  basePath: string;
  /** Public URL prefix for serving files (e.g., 'http://localhost:3000/uploads' or '/uploads') */
  baseUrl: string;
  /**
   * Dev/test presigned PUT, so the two-phase direct upload (presign, PUT bytes, confirm) runs
   * on local disk exactly as it does against S3/GCS. Off unless `enabled` is literally `true`.
   * See {@link LocalPresignConfig}.
   */
  presign?: LocalPresignConfig | undefined;
}

/**
 * HMAC-signed presigned PUT for {@link LocalProvider} (development and tests).
 *
 * With `enabled: true`, `getSignedUploadUrl()` returns an expiring URL on the HOST's own API
 * (`uploadUrl?key=...&e=...&sig=...`), signed with `@classytic/media-kit/signing`. The host
 * mounts one PUT route at `uploadUrl` that hands the raw body to
 * {@link LocalProvider.acceptSignedUpload}; that call verifies the signature, expiry and
 * signed Content-Type, then writes the bytes. Everything else (confirm, stat, serve) is
 * unchanged.
 *
 * **Production safety.** Nothing activates by default: without `presign`, or with any
 * `enabled` value other than `true`, the provider has NO `getSignedUploadUrl` (presign calls
 * fail as on any non-presigning driver) and `acceptSignedUpload` refuses every request with
 * 404 `media.upload.receiver_disabled`. Derive `enabled` from your environment config
 * (e.g. `enabled: !config.isProduction`) and do not mount the receiver in production: a
 * production bucket presigns natively (S3/GCS).
 */
export interface LocalPresignConfig {
  /** Must be `true` to activate. Any other value leaves presign and the receiver off. */
  enabled: boolean;
  /** Absolute URL of the host's receiver route (what clients PUT to), without a query string. */
  uploadUrl: string;
  /** HMAC secret for upload URLs. Use a dedicated one, not the GET-signing secret. */
  secret: string;
  /** Largest body `acceptSignedUpload` writes, in bytes. Omit for no package-side cap. */
  maxBytes?: number | undefined;
  /** Default URL lifetime in seconds when the caller passes none (default 900). */
  defaultExpiresIn?: number | undefined;
  /** Injected clock for signing and expiry (default `() => new Date()`). */
  now?: (() => Date) | undefined;
}

/** What a host's receiver route passes to {@link LocalProvider.acceptSignedUpload}. */
export interface LocalSignedUploadRequest {
  /** Decoded query params of the PUT (`req.query`). */
  query: Record<string, unknown>;
  /** The request's `Content-Type` header. Must equal the signed type (parameters ignored). */
  contentType?: string | undefined;
  /** Raw request body (Buffer or Uint8Array). */
  body: unknown;
}

/** Signed claim marking an upload URL, so a GET-serve signature can never authorise a write. */
const PUT_CLAIM_OP = 'put';

function firstString(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  return undefined;
}

function bareMime(contentType: string | undefined): string {
  return (contentType ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
}

/**
 * Local Filesystem Storage Driver
 */
export class LocalProvider implements StorageDriver {
  readonly name = 'local';
  private basePath: string;
  private baseUrl: string;

  constructor(config: LocalProviderConfig) {
    this.basePath = path.resolve(config.basePath);
    this.baseUrl = config.baseUrl.replace(/\/+$/, ''); // strip trailing slash
    if (config.presign?.enabled === true) {
      const presign = config.presign;
      if (!presign.uploadUrl) throw new Error('[media-kit] LocalProvider presign: uploadUrl is required');
      this.presign = {
        config: presign,
        signer: createUrlSigner({ secret: presign.secret, defaultTtl: presign.defaultExpiresIn ?? 900 }),
      };
      this.getSignedUploadUrl = (key, contentType, expiresIn) => this.signUpload(key, contentType, expiresIn);
    }
  }

  private presign: { config: LocalPresignConfig; signer: UrlSigner } | undefined;

  /**
   * Present only when `presign.enabled === true`. Absent otherwise, so capability checks
   * (`if (!driver.getSignedUploadUrl)`) see a non-presigning driver.
   */
  getSignedUploadUrl?: (key: string, contentType: string, expiresIn?: number) => Promise<PresignedUploadResult>;

  /** Unix seconds from the injected clock. */
  private presignNow(): number {
    const clock = this.presign?.config.now;
    return Math.floor((clock ? clock().getTime() : Date.now()) / 1000);
  }

  private async signUpload(key: string, contentType: string, expiresIn?: number): Promise<PresignedUploadResult> {
    const signer = this.presign!.signer;
    this.resolvePath(key); // refuse a traversal key before signing it
    const ct = bareMime(contentType);
    const now = this.presignNow();
    const { query, expiresAt } = signer.sign({
      id: key,
      claims: { op: PUT_CLAIM_OP, ct },
      now,
      ...(expiresIn !== undefined && { expiresIn }),
    });
    return {
      uploadUrl: `${this.presign!.config.uploadUrl}?key=${encodeURIComponent(key)}&${query}`,
      key,
      publicUrl: this.getPublicUrl(key),
      expiresIn: expiresAt - now,
      headers: { 'Content-Type': ct },
    };
  }

  /**
   * The receiver for a presigned local PUT. Framework-agnostic: the host's route passes the
   * query, `Content-Type` and raw body, and lets its error handler map a thrown `HttpError`.
   * Verifies the signature (keyring, expiry, PUT claim), the signed Content-Type and the size
   * cap, then writes the bytes at the signed key.
   *
   * @throws 404 `media.upload.receiver_disabled`: presign is not enabled on this provider
   * @throws 403 `media.upload.signature_invalid`: missing, forged or expired signature
   * @throws 415 `media.upload.content_type_mismatch`: Content-Type differs from the signed one
   * @throws 400 `media.file.empty`, 413 `media.file.too_large`, 400 `media.key.invalid`
   */
  async acceptSignedUpload(request: LocalSignedUploadRequest): Promise<{ key: string; size: number }> {
    const presign = this.presign;
    if (!presign) {
      throw mediaError(404, MEDIA_ERROR_CODES.UPLOAD_RECEIVER_DISABLED, 'Local presigned uploads are not enabled');
    }

    const params: Record<string, string> = {};
    for (const [name, value] of Object.entries(request.query ?? {})) {
      const str = firstString(value);
      if (str !== undefined) params[name] = str;
    }
    const key = params.key ?? '';
    const verdict = key
      ? presign.signer.verify({ id: key, params, now: this.presignNow() })
      : ({ ok: false, reason: 'malformed' } as const);
    if (!verdict.ok || params['c.op'] !== PUT_CLAIM_OP) {
      throw mediaError(403, MEDIA_ERROR_CODES.UPLOAD_SIGNATURE_INVALID, 'Upload URL is invalid or expired', {
        reason: verdict.ok ? 'not_an_upload_url' : verdict.reason,
      });
    }

    const signedType = params['c.ct'] ?? '';
    if (bareMime(request.contentType) !== signedType) {
      throw mediaError(
        415,
        MEDIA_ERROR_CODES.UPLOAD_CONTENT_TYPE_MISMATCH,
        `Content-Type must match the signed type '${signedType}'`,
      );
    }

    const { body } = request;
    const bytes = Buffer.isBuffer(body) ? body : body instanceof Uint8Array ? Buffer.from(body) : undefined;
    if (!bytes || bytes.length === 0) {
      throw mediaError(400, MEDIA_ERROR_CODES.FILE_EMPTY, 'Empty upload');
    }
    const { maxBytes } = presign.config;
    if (maxBytes !== undefined && bytes.length > maxBytes) {
      throw mediaError(413, MEDIA_ERROR_CODES.FILE_TOO_LARGE, `Upload exceeds ${maxBytes} bytes`, {
        maxSize: maxBytes,
      });
    }

    const result = await this.write(key, bytes, signedType);
    return { key, size: result.size };
  }

  /**
   * Resolve a storage key to an absolute filesystem path
   */
  private resolvePath(key: string): string {
    const resolved = path.resolve(this.basePath, key);
    // Prevent directory traversal — use basePath + sep to avoid sibling-prefix bypass
    // e.g. basePath="/uploads" must not allow "/uploads2/evil.txt"
    if (resolved !== this.basePath && !resolved.startsWith(this.basePath + path.sep)) {
      throw mediaError(400, MEDIA_ERROR_CODES.KEY_INVALID, `Invalid key: path traversal detected for key '${key}'`);
    }
    return resolved;
  }

  /**
   * Write data to the local filesystem.
   * Creates parent directories automatically.
   */
  async write(key: string, data: Buffer | NodeJS.ReadableStream, _contentType: string): Promise<WriteResult> {
    const filePath = this.resolvePath(key);
    const dir = path.dirname(filePath);

    // Ensure parent directory exists
    await fs.mkdir(dir, { recursive: true });

    if (Buffer.isBuffer(data)) {
      await fs.writeFile(filePath, data);
      return {
        key,
        url: this.getPublicUrl(key),
        size: data.length,
      };
    }

    // Stream write — on pipeline failure, remove the partial file so a
    // broken source stream can't leave truncated garbage on disk.
    const writeStream = createWriteStream(filePath);
    try {
      await pipeline(data, writeStream);
    } catch (err) {
      await fs.unlink(filePath).catch(() => {
        /* best-effort cleanup */
      });
      throw err;
    }

    const stat = await fs.stat(filePath);
    return {
      key,
      url: this.getPublicUrl(key),
      size: stat.size,
    };
  }

  /**
   * Read a file as a stream. Supports optional byte-range for partial reads.
   */
  async read(key: string, range?: { start: number; end: number }): Promise<NodeJS.ReadableStream> {
    const filePath = this.resolvePath(key);

    // Verify file exists before creating stream
    await fs.access(filePath);

    const options = range ? { start: range.start, end: range.end } : undefined;
    return createReadStream(filePath, options);
  }

  /**
   * Delete a file from the filesystem.
   * Returns true even if the file was already gone.
   */
  async delete(key: string): Promise<boolean> {
    const filePath = this.resolvePath(key);

    try {
      await fs.unlink(filePath);
    } catch (err: unknown) {
      // File already gone — not an error
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return true;
      }
      throw err;
    }

    return true;
  }

  /**
   * Check if a file exists
   */
  async exists(key: string): Promise<boolean> {
    const filePath = this.resolvePath(key);

    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get file metadata without reading the file
   */
  async stat(key: string): Promise<FileStat> {
    const filePath = this.resolvePath(key);
    const stat = await fs.stat(filePath);

    return {
      size: stat.size,
      contentType: getMimeType(key),
      lastModified: stat.mtime,
    };
  }

  /**
   * List files under a prefix (async generator for memory efficiency).
   * Yields storage keys relative to basePath.
   */
  async *list(prefix: string): AsyncIterable<string> {
    const dirPath = this.resolvePath(prefix);

    let entries: string[];
    try {
      entries = (await fs.readdir(dirPath, { recursive: true })) as string[];
    } catch (err: unknown) {
      // Directory doesn't exist — no files to list
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return;
      }
      throw err;
    }

    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry);
      const stat = await fs.stat(fullPath).catch(() => null);
      if (stat?.isFile()) {
        // Yield key relative to basePath, using forward slashes
        const key = path.relative(this.basePath, fullPath).replace(/\\/g, '/');
        yield key;
      }
    }
  }

  /**
   * Copy a file to a new location
   */
  async copy(source: string, destination: string): Promise<WriteResult> {
    const srcPath = this.resolvePath(source);
    const dstPath = this.resolvePath(destination);

    // Ensure destination directory exists
    await fs.mkdir(path.dirname(dstPath), { recursive: true });

    await fs.copyFile(srcPath, dstPath);

    const stat = await fs.stat(dstPath);
    return {
      key: destination,
      url: this.getPublicUrl(destination),
      size: stat.size,
    };
  }

  /**
   * Move a file to a new location.
   * Uses rename (fast on same filesystem), with copy+delete fallback for cross-device moves.
   */
  async move(source: string, destination: string): Promise<WriteResult> {
    const srcPath = this.resolvePath(source);
    const dstPath = this.resolvePath(destination);

    // Ensure destination directory exists
    await fs.mkdir(path.dirname(dstPath), { recursive: true });

    try {
      await fs.rename(srcPath, dstPath);
    } catch (err: unknown) {
      // EXDEV = cross-device link — fallback to copy+delete
      if ((err as NodeJS.ErrnoException).code === 'EXDEV') {
        await fs.copyFile(srcPath, dstPath);
        await fs.unlink(srcPath);
      } else {
        throw err;
      }
    }

    const stat = await fs.stat(dstPath);
    return {
      key: destination,
      url: this.getPublicUrl(destination),
      size: stat.size,
    };
  }

  /**
   * Build the public URL for a storage key
   */
  getPublicUrl(key: string): string {
    // Ensure forward slashes in URL
    const normalizedKey = key.replace(/\\/g, '/');
    return `${this.baseUrl}/${normalizedKey}`;
  }
}
