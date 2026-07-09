/**
 * Cloudflare Images Storage Driver
 *
 * Implements StorageDriver for Cloudflare Images — a managed image pipeline
 * (storage + on-the-fly variants + global CDN delivery). Uses the Cloudflare
 * v4 REST API directly (native fetch, no SDK dependency).
 *
 * Two operating modes, selected by the `signing` config:
 *
 * **Public mode (no `signing`)** — the default.
 *   - `write()` uploads with a CUSTOM ID equal to the media-kit generated key
 *     (Cloudflare custom IDs support path-like values up to 1024 chars, any
 *     number of subpaths, no leading/trailing slash, must not be a UUID —
 *     media-kit keys satisfy all of these), so the stored key IS the key
 *     media-kit generated. No composite-key encoding needed.
 *   - `getSignedUploadUrl()` works: the direct_upload v2 API accepts the same
 *     custom `id`, so the generated key survives the presign → confirm round
 *     trip and `confirmUpload()`'s key-shape check passes.
 *     ⚠ CLIENT CONTRACT: Cloudflare's one-time `uploadURL` takes a
 *     `multipart/form-data` POST with the file in a `file` field — NOT a raw
 *     HTTP PUT like S3/GCS presigned URLs. Frontends must use FormData.
 *
 * **Private mode (`signing: { key }` configured)**
 *   - `write()` uploads with `requireSignedURLs: true` and NO custom ID —
 *     Cloudflare forbids custom IDs on images that require signed URLs — so
 *     the returned `WriteResult.key` is Cloudflare's generated UUID (stored
 *     on the media doc like any driver-owned key).
 *   - `getSignedUrl()` mints HMAC-SHA256 delivery tokens (`?exp=…&sig=…`)
 *     using the key from the dashboard (Images → Keys).
 *   - `getSignedUploadUrl()` THROWS: a private direct upload cannot carry a
 *     custom ID, so the CF-assigned UUID key would fail `confirmUpload()`'s
 *     generated-key-shape validation. Use server-side `upload()` instead.
 *
 * Delivery URLs: `https://imagedelivery.net/{accountHash}/{imageId}/{variant}`.
 * `read()`/`exists()`/`stat()` use the API details endpoint plus a delivery
 * fetch — Cloudflare Images has no byte-download API; the delivery CDN is the
 * only byte path, and it serves the requested VARIANT (transformed), not the
 * original upload. Size/contentType from `stat()` therefore describe the
 * `defaultVariant` rendition.
 *
 * Not supported by Cloudflare Images (left `undefined`, feature-detected by
 * the engine): `list` (no prefix filtering in the v2 list API), `copy`,
 * `move`, multipart and resumable uploads. Images only — max 10 MB per
 * upload, max 100 megapixels (PNG/JPEG/GIF/WebP incl. animation, SVG, AVIF).
 *
 * @example
 * ```ts
 * import { CloudflareImagesProvider } from '@classytic/media-kit/providers/cloudflare-images';
 *
 * const engine = await createMedia({
 *   connection: mongoose.connection,
 *   driver: new CloudflareImagesProvider({
 *     accountId: process.env.CF_ACCOUNT_ID,
 *     apiToken: process.env.CF_IMAGES_TOKEN, // needs Images:Edit permission
 *     accountHash: process.env.CF_IMAGES_ACCOUNT_HASH,
 *     defaultVariant: 'public',
 *   }),
 *   processing: { enabled: false }, // Cloudflare variants handle resizing
 * });
 * ```
 */

import { createHmac } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import type { FileStat, PresignedUploadResult, StorageDriver, WriteResult } from '../types.js';
import { LazySecret, type SecretValue, validateSecretValue } from '../utils/lazy-secret.js';

const API_BASE = 'https://api.cloudflare.com/client/v4/accounts';
const DELIVERY_BASE = 'https://imagedelivery.net';

/** Direct-upload URL expiry window enforced by Cloudflare (seconds). */
const DIRECT_UPLOAD_MIN_EXPIRY = 120; // 2 minutes
const DIRECT_UPLOAD_MAX_EXPIRY = 21_600; // 6 hours

export interface CloudflareImagesProviderConfig {
  /** Cloudflare account ID (from the dashboard URL / API section). NOT a secret. */
  accountId: string;
  /**
   * API token with `Cloudflare Images: Edit` permission.
   *
   * Accepts a string OR a `() => string | Promise<string>` resolver. The
   * resolver form defers credential resolution to the first upload, so
   * environments that DON'T exercise the upload pipeline (test runners,
   * dev previews, partial-deploy workers) can boot without the secret.
   */
  apiToken: SecretValue;
  /**
   * Images account hash (dashboard → Images → Developer Resources). Appears
   * in every delivery URL — NOT a secret; kept eager because
   * `getPublicUrl()` is synchronous per the `StorageDriver` contract.
   */
  accountHash: string;
  /**
   * Named variant used for delivery URLs (default: 'public' — the variant
   * Cloudflare creates automatically for every account).
   */
  defaultVariant?: string;
  /**
   * Enables PRIVATE mode: uploads are created with `requireSignedURLs: true`
   * and `getSignedUrl()` mints HMAC-SHA256 `?exp=…&sig=…` delivery tokens.
   * `key` is the Images signing key from dashboard → Images → Keys.
   *
   * Trade-offs (Cloudflare platform constraints, not media-kit choices):
   *   - custom IDs are forbidden on signed images → stored keys are CF UUIDs
   *   - `getSignedUploadUrl()` is unavailable (see class doc)
   */
  signing?: { key: string } | undefined;
}

// ── Response shapes (Cloudflare v4 envelope) ─────────────────────────────────

interface CloudflareEnvelope<T> {
  success: boolean;
  result: T | null;
  errors?: Array<{ code?: number; message?: string }>;
}

interface CloudflareImageResult {
  id: string;
  filename?: string;
  uploaded?: string;
  requireSignedURLs?: boolean;
  variants?: string[];
  draft?: boolean;
  meta?: Record<string, unknown>;
}

interface CloudflareDirectUploadResult {
  id: string;
  uploadURL: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Encode a path-like image ID for use in URLs, preserving `/` separators. */
function encodeImageId(id: string): string {
  return id.split('/').map(encodeURIComponent).join('/');
}

/** Extract the first API error message from a Cloudflare envelope. */
function envelopeError(json: CloudflareEnvelope<unknown> | undefined): string | undefined {
  return json?.errors?.find((e) => e.message)?.message;
}

function toBuffer(data: Buffer | NodeJS.ReadableStream): Promise<Buffer> {
  if (Buffer.isBuffer(data)) return Promise.resolve(data);
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    (data as NodeJS.ReadableStream).on('data', (chunk: Buffer | string) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    (data as NodeJS.ReadableStream).on('end', () => resolve(Buffer.concat(chunks)));
    (data as NodeJS.ReadableStream).on('error', reject);
  });
}

/**
 * Byte-window transform for range emulation. Cloudflare's delivery CDN does
 * not document Range support for transformed images — when it answers 200 to
 * a ranged request we slice the window locally instead of returning wrong
 * bytes. Streams through without buffering the whole body.
 */
function sliceStream(source: NodeJS.ReadableStream, start: number, end: number): NodeJS.ReadableStream {
  let offset = 0;
  const windowEnd = end + 1; // end is inclusive per HTTP Range semantics
  const transform = new Transform({
    transform(chunk: Buffer, _enc, callback) {
      const chunkStart = offset;
      offset += chunk.length;
      const from = Math.max(start - chunkStart, 0);
      const to = Math.min(windowEnd - chunkStart, chunk.length);
      if (to > from) this.push(chunk.subarray(from, to));
      callback();
    },
  });
  source.on('error', (err) => transform.destroy(err as Error));
  return (source as unknown as Readable).pipe(transform);
}

// ── Driver ────────────────────────────────────────────────────────────────────

/**
 * Cloudflare Images Storage Driver — plug into any @classytic/media-kit engine.
 */
export class CloudflareImagesProvider implements StorageDriver {
  readonly name = 'cloudflare-images';

  private readonly accountId: string;
  private readonly accountHash: string;
  private readonly defaultVariant: string;
  private readonly signingKey: string | undefined;
  private readonly apiTokenSecret: LazySecret;
  /** Memoized bearer header — computed on first request that needs credentials. */
  private cachedAuthHeader?: string;

  constructor(config: CloudflareImagesProviderConfig) {
    if (!config.accountId) throw new Error('CloudflareImagesProvider: accountId is required');
    if (!config.accountHash) throw new Error('CloudflareImagesProvider: accountHash is required');
    // String form validated eagerly (preserves "fail at boot" UX); function
    // form deferred to first use.
    validateSecretValue(config.apiToken, 'CloudflareImagesProvider: apiToken');
    if (config.signing !== undefined && !config.signing.key) {
      throw new Error('CloudflareImagesProvider: signing.key must be a non-empty string when signing is configured');
    }

    this.accountId = config.accountId;
    this.accountHash = config.accountHash;
    this.defaultVariant = config.defaultVariant ?? 'public';
    this.signingKey = config.signing?.key;
    this.apiTokenSecret = new LazySecret(config.apiToken, 'CloudflareImagesProvider: apiToken');

    // Eager-string fast path: pre-compute the auth header so existing hosts
    // on the literal form pay zero overhead.
    const literalToken = this.apiTokenSecret.literalValue();
    if (literalToken !== undefined) {
      this.cachedAuthHeader = `Bearer ${literalToken}`;
    }
  }

  /** Resolve + cache the bearer header used for every API call. */
  private async resolveAuthHeader(): Promise<string> {
    if (this.cachedAuthHeader !== undefined) return this.cachedAuthHeader;
    const token = await this.apiTokenSecret.resolve();
    this.cachedAuthHeader = `Bearer ${token}`;
    return this.cachedAuthHeader;
  }

  private apiUrl(path: string): string {
    return `${API_BASE}/${this.accountId}/images${path}`;
  }

  private deliveryUrl(imageId: string, variant: string): string {
    // The variant segment is NOT encoded — flexible-variant strings
    // (`w=400,sharpen=3`) must keep their `=` and `,` literal.
    return `${DELIVERY_BASE}/${this.accountHash}/${encodeImageId(imageId)}/${variant}`;
  }

  /** Delivery URL for reads — signed when private mode is on (CF 403s otherwise). */
  private readUrl(key: string): string {
    return this.signingKey !== undefined ? this.signDeliveryUrl(key, 300, this.defaultVariant) : this.getPublicUrl(key);
  }

  /**
   * Sign a delivery URL per Cloudflare's serve-private-images scheme:
   * HMAC-SHA256(key, `${pathname}?${searchParams}`) with `exp` present in the
   * params, hex-encoded, appended as `sig`.
   */
  private signDeliveryUrl(key: string, expiresIn: number, variant: string): string {
    if (this.signingKey === undefined) {
      throw new Error(
        'CloudflareImagesProvider: getSignedUrl() requires signing.key (dashboard → Images → Keys) — configure signing to serve private images',
      );
    }
    const url = new URL(this.deliveryUrl(key, variant));
    const exp = Math.floor(Date.now() / 1000) + expiresIn;
    url.searchParams.set('exp', String(exp));
    const stringToSign = `${url.pathname}?${url.searchParams.toString()}`;
    const sig = createHmac('sha256', this.signingKey).update(stringToSign).digest('hex');
    url.searchParams.set('sig', sig);
    return url.toString();
  }

  /**
   * Upload a file to Cloudflare Images (multipart POST to `/images/v1`).
   *
   * Public mode: uploads under a CUSTOM ID equal to `key` — the generated key
   * is preserved verbatim (path-like custom IDs are supported by Cloudflare).
   * Private mode (`signing` configured): uploads with
   * `requireSignedURLs: true` and no custom ID (a Cloudflare constraint), so
   * the returned key is Cloudflare's UUID.
   *
   * Images only — Cloudflare rejects non-image payloads (max 10 MB,
   * 100 megapixels). Pair with `StorageRouter` to send videos/documents to a
   * bucket provider.
   */
  async write(key: string, data: Buffer | NodeJS.ReadableStream, contentType: string): Promise<WriteResult> {
    const buffer = await toBuffer(data);
    const isPrivate = this.signingKey !== undefined;

    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(buffer)], { type: contentType }), key.split('/').pop() ?? key);
    if (isPrivate) {
      form.append('requireSignedURLs', 'true');
    } else {
      // Custom ID: no leading/trailing slash, not a UUID — generated keys
      // (`folder/<ts>-<hex12>-<name>.<ext>`) always qualify.
      form.append('id', key.replace(/^\/+|\/+$/g, ''));
    }

    const authHeader = await this.resolveAuthHeader();
    const res = await fetch(this.apiUrl('/v1'), {
      method: 'POST',
      headers: { Authorization: authHeader },
      body: form,
    });

    const json = (await res.json().catch(() => undefined)) as CloudflareEnvelope<CloudflareImageResult> | undefined;
    if (!res.ok || json === undefined || !json.success || json.result === null) {
      throw new Error(`Cloudflare Images upload failed (${res.status}): ${envelopeError(json) ?? 'unknown error'}`);
    }

    const storedKey = json.result.id;
    return {
      key: storedKey,
      url: this.getPublicUrl(storedKey),
      size: buffer.length,
      metadata: {
        id: json.result.id,
        ...(json.result.filename !== undefined && { filename: json.result.filename }),
        ...(json.result.uploaded !== undefined && { uploaded: json.result.uploaded }),
        ...(json.result.requireSignedURLs !== undefined && { requireSignedURLs: json.result.requireSignedURLs }),
        ...(json.result.variants !== undefined && { variants: json.result.variants }),
      },
    };
  }

  /**
   * Read image bytes by proxying a GET to the delivery URL (signed in private
   * mode). Cloudflare Images has no byte-download API — the delivery CDN is
   * the only byte path, and it serves the `defaultVariant` rendition.
   *
   * Byte-range: Range support on `imagedelivery.net` is undocumented. The
   * `Range` header is forwarded; when the CDN honors it (206) the partial
   * stream is returned as-is, and when it answers 200 the requested window is
   * sliced locally so callers always get exactly the bytes they asked for.
   */
  async read(key: string, range?: { start: number; end: number }): Promise<NodeJS.ReadableStream> {
    const url = this.readUrl(key);
    const res = await fetch(url, {
      headers: range ? { Range: `bytes=${range.start}-${range.end}` } : {},
    });

    if (!res.ok) throw new Error(`Cloudflare Images read failed (${res.status}): ${this.getPublicUrl(key)}`);
    if (!res.body) throw new Error('Cloudflare Images response has no body');

    const stream = Readable.fromWeb(res.body as import('stream/web').ReadableStream);
    if (range && res.status === 200) return sliceStream(stream, range.start, range.end);
    return stream;
  }

  /**
   * Delete an image (`DELETE /images/v1/{id}`). All copies are purged from
   * cache by Cloudflare. 404 = already gone — treated as success.
   */
  async delete(key: string): Promise<boolean> {
    const authHeader = await this.resolveAuthHeader();
    const res = await fetch(this.apiUrl(`/v1/${encodeImageId(key)}`), {
      method: 'DELETE',
      headers: { Authorization: authHeader },
    });

    if (res.status === 404) return true;
    const json = (await res.json().catch(() => undefined)) as CloudflareEnvelope<unknown> | undefined;
    if (!res.ok || json === undefined || !json.success) {
      throw new Error(`Cloudflare Images delete failed (${res.status}): ${envelopeError(json) ?? 'unknown error'}`);
    }
    return true;
  }

  /**
   * Check existence via the image-details endpoint (`GET /images/v1/{id}`) —
   * authoritative for private images too, unlike a delivery-URL HEAD.
   */
  async exists(key: string): Promise<boolean> {
    const authHeader = await this.resolveAuthHeader();
    const res = await fetch(this.apiUrl(`/v1/${encodeImageId(key)}`), {
      headers: { Authorization: authHeader },
    });
    return res.ok;
  }

  /**
   * Get file metadata. Cloudflare's details endpoint carries identity
   * (filename, upload date, signed-URL flag) but NOT byte size or MIME type,
   * so a HEAD against the delivery URL fills those in — meaning `size` /
   * `contentType` describe the `defaultVariant` rendition Cloudflare serves,
   * not the original upload bytes. If the HEAD fails (e.g. variant not yet
   * warm), size falls back to 0 rather than failing the stat.
   */
  async stat(key: string): Promise<FileStat> {
    const authHeader = await this.resolveAuthHeader();
    const res = await fetch(this.apiUrl(`/v1/${encodeImageId(key)}`), {
      headers: { Authorization: authHeader },
    });

    const json = (await res.json().catch(() => undefined)) as CloudflareEnvelope<CloudflareImageResult> | undefined;
    if (!res.ok || json === undefined || !json.success || json.result === null) {
      throw new Error(`Cloudflare Images stat failed (${res.status}): ${envelopeError(json) ?? key}`);
    }

    let size = 0;
    let contentType = 'application/octet-stream';
    try {
      const head = await fetch(this.readUrl(key), { method: 'HEAD' });
      if (head.ok) {
        size = Number(head.headers.get('content-length') ?? 0);
        contentType = head.headers.get('content-type') ?? contentType;
      }
    } catch {
      // Delivery HEAD is best-effort — identity metadata alone is still a valid stat.
    }

    return {
      size,
      contentType,
      lastModified: json.result.uploaded ? new Date(json.result.uploaded) : undefined,
      metadata: {
        ...(json.result.filename !== undefined && { filename: json.result.filename }),
        ...(json.result.requireSignedURLs !== undefined && {
          requireSignedURLs: String(json.result.requireSignedURLs),
        }),
      },
    };
  }

  /**
   * Delivery URL for the `defaultVariant`:
   * `https://imagedelivery.net/{accountHash}/{key}/{variant}`.
   * In private mode this URL 403s without a token — use `getSignedUrl()`.
   */
  getPublicUrl(key: string): string {
    return this.deliveryUrl(key, this.defaultVariant);
  }

  /**
   * Mint a signed delivery URL (`?exp=…&sig=…`, HMAC-SHA256 hex) for a
   * private image. Requires `signing.key` (dashboard → Images → Keys).
   * Cloudflare only ENFORCES the token on images uploaded with
   * `requireSignedURLs: true` (i.e. written while `signing` was configured).
   */
  async getSignedUrl(key: string, expiresIn = 3600): Promise<string> {
    return this.signDeliveryUrl(key, expiresIn, this.defaultVariant);
  }

  /**
   * Create a one-time direct-creator-upload URL
   * (`POST /images/v2/direct_upload`) carrying the generated key as the
   * custom image ID, so the presign → client upload → `confirmUpload()` flow
   * keeps the exact key media-kit minted (and its tenant binding).
   *
   * ⚠ CLIENT CONTRACT — differs from S3/GCS presigned URLs: the client must
   * send `multipart/form-data` POST with the file in a `file` field, NOT a
   * raw PUT of the bytes. `expiresIn` is clamped to Cloudflare's window
   * (2 minutes – 6 hours); the returned `expiresIn` is the clamped value.
   *
   * Unavailable in private mode: Cloudflare forbids custom IDs on
   * `requireSignedURLs` images, and the CF-assigned UUID key would fail
   * `confirmUpload()`'s generated-key-shape validation — throws a clear
   * error instead of shipping a broken flow. Use server-side `upload()`.
   */
  async getSignedUploadUrl(key: string, _contentType: string, expiresIn = 3600): Promise<PresignedUploadResult> {
    if (this.signingKey !== undefined) {
      throw new Error(
        'CloudflareImagesProvider: getSignedUploadUrl() is unsupported in private mode (signing configured) — ' +
          'Cloudflare forbids custom IDs on requireSignedURLs images, so the presigned key cannot be preserved ' +
          'through confirmUpload(). Use server-side upload() for private images.',
      );
    }

    const clamped = Math.min(Math.max(expiresIn, DIRECT_UPLOAD_MIN_EXPIRY), DIRECT_UPLOAD_MAX_EXPIRY);
    const id = key.replace(/^\/+|\/+$/g, '');

    const form = new FormData();
    form.append('id', id);
    form.append('expiry', new Date(Date.now() + clamped * 1000).toISOString());

    const authHeader = await this.resolveAuthHeader();
    const res = await fetch(this.apiUrl('/v2/direct_upload'), {
      method: 'POST',
      headers: { Authorization: authHeader },
      body: form,
    });

    const json = (await res.json().catch(() => undefined)) as
      | CloudflareEnvelope<CloudflareDirectUploadResult>
      | undefined;
    if (!res.ok || json === undefined || !json.success || json.result === null) {
      throw new Error(
        `Cloudflare Images direct_upload failed (${res.status}): ${envelopeError(json) ?? 'unknown error'}`,
      );
    }

    return {
      uploadUrl: json.result.uploadURL,
      key: json.result.id,
      publicUrl: this.getPublicUrl(json.result.id),
      expiresIn: clamped,
    };
  }

  // ── Cloudflare-specific extensions ───────────────────────────────────────────
  // Beyond the StorageDriver interface — cast engine.driver (or
  // registry.resolve('cloudflare-images')) to CloudflareImagesProvider.

  /**
   * Delivery URL for a specific named variant (e.g. `'thumbnail'`), or a
   * flexible-variant transform string (e.g. `'w=400,sharpen=3'`) when
   * flexible variants are enabled on the account. Flexible variants cannot
   * be used with images that require signed URLs.
   */
  getVariantUrl(key: string, variant: string): string {
    return this.deliveryUrl(key, variant);
  }

  /**
   * Signed delivery URL for a specific named variant — private-mode
   * counterpart of {@link getVariantUrl}. Requires `signing.key`.
   */
  getSignedVariantUrl(key: string, variant: string, expiresIn = 3600): string {
    return this.signDeliveryUrl(key, expiresIn, variant);
  }
}
