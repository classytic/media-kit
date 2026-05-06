/**
 * Cloudinary Storage Driver
 *
 * Implements StorageDriver for Cloudinary — a transformation-first media CDN.
 * Uses Cloudinary's REST Upload API + Admin API directly (no SDK dependency).
 * Signed uploads via SHA-1 HMAC — no upload preset required.
 *
 * Key encoding: `{publicId}\n{resourceType}` (newline = safe separator in both fields).
 *   - `getPublicUrl(key)` → https://res.cloudinary.com/{cloudName}/{resourceType}/upload/{publicId}
 *   - `delete(key)` → POST /v1_1/{cloudName}/{resourceType}/destroy (publicId + signature)
 *   - `stat(key)` → GET /v1_1/{cloudName}/resources/{resourceType}/{publicId}
 *
 * resourceType is derived from contentType on write():
 *   - image/* → 'image'
 *   - video/* | audio/* → 'video'
 *   - everything else → 'raw'
 *
 * Transformation URLs are automatically supported — append Cloudinary
 * transformation strings between /upload/ and the publicId:
 *   `https://res.cloudinary.com/demo/image/upload/w_400,c_fill/photo`
 *
 * @example
 * ```ts
 * import { CloudinaryProvider } from '@classytic/media-kit/providers/cloudinary';
 *
 * const engine = await createMedia({
 *   connection: mongoose.connection,
 *   driver: new CloudinaryProvider({
 *     cloudName: process.env.CLOUDINARY_CLOUD_NAME,
 *     apiKey: process.env.CLOUDINARY_API_KEY,
 *     apiSecret: process.env.CLOUDINARY_API_SECRET,
 *   }),
 *   processing: { enabled: false }, // Cloudinary handles optimization
 * });
 * ```
 */

import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import type { FileStat, StorageDriver, WriteResult } from '../types.js';

const SEP = '\n';

export interface CloudinaryProviderConfig {
  /** Cloudinary cloud name (e.g. 'my-cloud') */
  cloudName: string;
  /** Cloudinary API key (numeric string from dashboard) */
  apiKey: string;
  /** Cloudinary API secret */
  apiSecret: string;
  /**
   * Default folder prefix for uploads (e.g. 'my-app/media').
   * Cloudinary prepends this to the public_id on upload.
   * Defaults to '' (root).
   */
  folder?: string;
  /**
   * Whether to overwrite existing files with the same public_id.
   * Defaults to true — keeps behaviour consistent with other drivers.
   */
  overwrite?: boolean;
  /**
   * Deliver via HTTPS (default: true).
   */
  secure?: boolean;
  /**
   * Apply `f_auto,q_auto` to image delivery URLs for automatic format
   * negotiation (WebP/AVIF) and quality optimisation — Cloudinary's primary
   * value prop. Default: true.
   * Set to false if you are building transformation URLs manually.
   */
  autoOptimize?: boolean;
}

// ── Response shapes ───────────────────────────────────────────────────────────

interface CloudinaryUploadResponse {
  public_id: string;
  resource_type: string;
  format: string;
  bytes: number;
  secure_url: string;
  url: string;
  width?: number;
  height?: number;
  etag?: string;
  asset_id?: string;
  created_at?: string;
  original_filename?: string;
}

interface CloudinaryResourceResponse {
  public_id: string;
  resource_type: string;
  format: string;
  bytes: number;
  created_at?: string;
  width?: number;
  height?: number;
  etag?: string;
  error?: { message: string };
}

interface CloudinaryListResponse {
  resources: Array<{ public_id: string; resource_type: string }>;
  next_cursor?: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseKey(key: string): { publicId: string; resourceType: string } {
  const idx = key.indexOf(SEP);
  if (idx === -1) return { publicId: key, resourceType: 'image' };
  return { publicId: key.slice(0, idx), resourceType: key.slice(idx + 1) };
}

/** SHA-1 signature over sorted param string (Cloudinary signing spec). */
function sign(params: Record<string, string>, apiSecret: string): string {
  const str = Object.keys(params)
    .sort()
    .filter((k) => params[k] !== '')
    .map((k) => `${k}=${params[k]}`)
    .join('&');
  return createHash('sha1').update(str + apiSecret).digest('hex');
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

// ── Driver ────────────────────────────────────────────────────────────────────

/**
 * Cloudinary Storage Driver — plug into any @classytic/media-kit engine.
 */
export class CloudinaryProvider implements StorageDriver {
  readonly name = 'cloudinary';

  private readonly cloudName: string;
  private readonly apiKey: string;
  private readonly apiSecret: string;
  private readonly folder: string;
  private readonly overwrite: boolean;
  private readonly secure: boolean;
  private readonly autoOptimize: boolean;
  private readonly authHeader: string;

  constructor(config: CloudinaryProviderConfig) {
    if (!config.cloudName) throw new Error('CloudinaryProvider: cloudName is required');
    if (!config.apiKey) throw new Error('CloudinaryProvider: apiKey is required');
    if (!config.apiSecret) throw new Error('CloudinaryProvider: apiSecret is required');

    this.cloudName = config.cloudName;
    this.apiKey = config.apiKey;
    this.apiSecret = config.apiSecret;
    this.folder = config.folder?.replace(/\/+$/, '') ?? '';
    this.overwrite = config.overwrite ?? true;
    this.secure = config.secure ?? true;
    this.autoOptimize = config.autoOptimize ?? true;

    // Basic auth for Admin API (apiKey:apiSecret)
    this.authHeader = 'Basic ' + Buffer.from(`${this.apiKey}:${this.apiSecret}`).toString('base64');
  }

  // Upload API always uses 'auto' — Cloudinary detects resource_type from the file.
  // Response carries the resolved resource_type which we store in the composite key.
  private get uploadUrl(): string {
    return `https://api.cloudinary.com/v1_1/${this.cloudName}/auto/upload`;
  }

  private adminUrl(path: string): string {
    return `https://api.cloudinary.com/v1_1/${this.cloudName}${path}`;
  }

  private cdnUrl(publicId: string, resourceType: string): string {
    const scheme = this.secure ? 'https' : 'http';
    // f_auto: serve WebP/AVIF to supporting browsers; q_auto: Cloudinary picks
    // optimal quality per-image. Only applied to images — not video or raw.
    const transforms = (this.autoOptimize && resourceType === 'image') ? 'f_auto,q_auto/' : '';
    return `${scheme}://res.cloudinary.com/${this.cloudName}/${resourceType}/upload/${transforms}${publicId}`;
  }

  /**
   * Upload a file to Cloudinary via the signed REST Upload API.
   *
   * Uses `resource_type: auto` so Cloudinary detects the type from the file
   * rather than guessing from the MIME type. The response's `resource_type`
   * is stored in the composite key `publicId\nresourceType`.
   */
  async write(key: string, data: Buffer | NodeJS.ReadableStream, contentType: string): Promise<WriteResult> {
    const buffer = await toBuffer(data);
    // Derive public_id from key — strip extension for non-raw (Cloudinary stores format separately).
    // We can't know the final resource_type before upload when using 'auto', so we strip any
    // image/video-like extension and keep for everything else.
    const likelyRaw = !contentType.startsWith('image/') && !contentType.startsWith('video/') && !contentType.startsWith('audio/');
    const rawPublicId = likelyRaw ? key : key.replace(/\.[^./]+$/, '');
    const publicId = this.folder ? `${this.folder}/${rawPublicId}` : rawPublicId;

    const timestamp = String(Math.floor(Date.now() / 1000));

    const signParams: Record<string, string> = {
      public_id: publicId,
      timestamp,
      overwrite: String(this.overwrite),
    };

    const signature = sign(signParams, this.apiSecret);

    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(buffer)], { type: contentType }));
    form.append('public_id', publicId);
    form.append('timestamp', timestamp);
    form.append('api_key', this.apiKey);
    form.append('signature', signature);
    form.append('overwrite', String(this.overwrite));

    const res = await fetch(this.uploadUrl, { method: 'POST', body: form });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Cloudinary upload failed (${res.status}): ${body}`);
    }

    const json = (await res.json()) as CloudinaryUploadResponse;
    const compositeKey = json.public_id + SEP + json.resource_type;

    return {
      key: compositeKey,
      url: this.secure ? json.secure_url : json.url,
      size: json.bytes,
      metadata: {
        publicId: json.public_id,
        resourceType: json.resource_type,
        format: json.format,
        assetId: json.asset_id,
        etag: json.etag,
        ...(json.width !== undefined && { width: json.width }),
        ...(json.height !== undefined && { height: json.height }),
      },
    };
  }

  /**
   * Read a file by proxying a GET to the Cloudinary CDN URL.
   */
  async read(key: string): Promise<NodeJS.ReadableStream> {
    const url = this.getPublicUrl(key);
    const res = await fetch(url);

    if (!res.ok) throw new Error(`Cloudinary read failed (${res.status}): ${url}`);
    if (!res.body) throw new Error('Cloudinary response has no body');

    return Readable.fromWeb(res.body as import('stream/web').ReadableStream);
  }

  /**
   * Delete a file via the Admin API destroy endpoint.
   * `invalidate: true` purges the file from Cloudinary's CDN cache.
   */
  async delete(key: string): Promise<boolean> {
    const { publicId, resourceType } = parseKey(key);
    const timestamp = String(Math.floor(Date.now() / 1000));

    // invalidate must be included in signParams — Cloudinary signs ALL sent params
    // (except api_key, file, resource_type). Omitting it causes 401 Invalid Signature.
    const signParams = { invalidate: 'true', public_id: publicId, timestamp };
    const signature = sign(signParams, this.apiSecret);

    const body = new URLSearchParams({
      public_id: publicId,
      timestamp,
      api_key: this.apiKey,
      signature,
      invalidate: 'true',
    });

    const res = await fetch(this.adminUrl(`/${resourceType}/destroy`), {
      method: 'POST',
      body,
    });

    if (res.status === 404) return true;
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Cloudinary delete failed (${res.status}): ${text}`);
    }

    const json = (await res.json()) as { result: string };
    // 'not found' means already deleted — treat as success
    return json.result === 'ok' || json.result === 'not found';
  }

  /**
   * Check if a file exists by fetching its resource details from Admin API.
   */
  async exists(key: string): Promise<boolean> {
    const { publicId, resourceType } = parseKey(key);
    const encodedId = encodeURIComponent(publicId).replace(/%2F/g, '/');

    const res = await fetch(
      this.adminUrl(`/resources/${resourceType}/upload/${encodedId}`),
      { headers: { Authorization: this.authHeader } },
    );

    return res.ok;
  }

  /**
   * Get file metadata via Admin API.
   */
  async stat(key: string): Promise<FileStat> {
    const { publicId, resourceType } = parseKey(key);
    const encodedId = encodeURIComponent(publicId).replace(/%2F/g, '/');

    const res = await fetch(
      this.adminUrl(`/resources/${resourceType}/upload/${encodedId}`),
      { headers: { Authorization: this.authHeader } },
    );

    if (!res.ok) throw new Error(`Cloudinary stat failed (${res.status}): ${publicId}`);

    const json = (await res.json()) as CloudinaryResourceResponse;
    if (json.error) throw new Error(`Cloudinary stat error: ${json.error.message}`);

    const ext = json.format ? `.${json.format}` : '';
    return {
      size: json.bytes,
      contentType: resourceType === 'raw' ? 'application/octet-stream' : `${resourceType}/${json.format || 'octet-stream'}`,
      lastModified: json.created_at ? new Date(json.created_at) : undefined,
      etag: json.etag,
      metadata: {
        ...(json.width !== undefined && { width: String(json.width) }),
        ...(json.height !== undefined && { height: String(json.height) }),
        format: json.format + ext,
      },
    };
  }

  /**
   * List files under a folder prefix using Admin API resource listing.
   * Yields composite keys (`publicId\nresourceType`) for each file.
   */
  async *list(prefix: string): AsyncIterable<string> {
    for (const resourceType of ['image', 'video', 'raw'] as const) {
      let nextCursor: string | undefined;

      while (true) {
        const params = new URLSearchParams({
          type: 'upload',
          prefix,
          max_results: '100',
          ...(nextCursor && { next_cursor: nextCursor }),
        });

        const res = await fetch(
          this.adminUrl(`/resources/${resourceType}?${params}`),
          { headers: { Authorization: this.authHeader } },
        );

        if (!res.ok) break;

        const json = (await res.json()) as CloudinaryListResponse;

        for (const r of json.resources) {
          yield r.public_id + SEP + r.resource_type;
        }

        if (!json.next_cursor) break;
        nextCursor = json.next_cursor;
      }
    }
  }

  /**
   * Reconstruct the Cloudinary CDN URL from the composite key.
   * The publicId is stable even as transformation parameters change.
   */
  getPublicUrl(key: string): string {
    const { publicId, resourceType } = parseKey(key);
    return this.cdnUrl(publicId, resourceType);
  }

  // ── Cloudinary-specific extensions ───────────────────────────────────────────
  // These go beyond the StorageDriver interface and expose Cloudinary's
  // transformation + delivery capabilities directly. Cast engine.driver (or
  // registry.resolve('cloudinary')) to CloudinaryProvider to access them.

  /**
   * Build a Cloudinary transformation URL for an existing asset.
   *
   * `transform` is the raw Cloudinary transformation string inserted between
   * `/upload/` and the public_id. Chain multiple transformations with `/`.
   *
   * @example
   * ```ts
   * const driver = engine.driver as CloudinaryProvider;
   *
   * // Resize + smart crop + face gravity
   * driver.getTransformUrl(media.key, 'w_400,h_400,c_fill,g_face');
   *
   * // Chained: thumbnail → blur background
   * driver.getTransformUrl(media.key, 'w_800,h_600,c_fill/e_blur:800');
   *
   * // AI background removal (Cloudinary AI add-on)
   * driver.getTransformUrl(media.key, 'e_background_removal');
   *
   * // Named transformation
   * driver.getTransformUrl(media.key, 't_product-thumbnail');
   * ```
   */
  getTransformUrl(key: string, transform: string): string {
    const { publicId, resourceType } = parseKey(key);
    const scheme = this.secure ? 'https' : 'http';
    const t = transform.replace(/^\/+|\/+$/g, ''); // strip leading/trailing slashes
    return `${scheme}://res.cloudinary.com/${this.cloudName}/${resourceType}/upload/${t}/${publicId}`;
  }

  /**
   * Generate a signed delivery URL for a private or authenticated asset.
   *
   * Uses Cloudinary's signed URL pattern: the signature is computed over
   * the transformation string + public_id + expiry timestamp and appended
   * as `s--{signature}--` between `/upload/` and the transformation.
   *
   * @param key      Composite key from write()
   * @param expiresIn Seconds until the signed URL expires (default: 3600)
   * @param transform Optional transformation string to include
   */
  async getSignedUrl(key: string, expiresIn = 3600, transform?: string): Promise<string> {
    const { publicId, resourceType } = parseKey(key);
    const expireAt = Math.floor(Date.now() / 1000) + expiresIn;
    const t = transform ? transform.replace(/^\/+|\/+$/g, '') + '/' : '';

    // Cloudinary signed URL signature: SHA-1 of transform + publicId + expireAt + secret
    const toSign = `${t}${publicId}${expireAt}${this.apiSecret}`;
    const signature = createHash('sha1').update(toSign).digest('hex').slice(0, 8);

    const scheme = this.secure ? 'https' : 'http';
    return `${scheme}://res.cloudinary.com/${this.cloudName}/${resourceType}/upload/s--${signature}--/${t}${publicId}?_a=BATAAB0`;
  }
}

export default CloudinaryProvider;
