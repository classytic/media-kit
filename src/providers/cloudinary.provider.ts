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
 * const engine = await defineMedia({
 *   processing: { enabled: false }, // Cloudinary handles optimization
 * }).bind(mongoose.connection, {
 *   driver: new CloudinaryProvider({
 *     cloudName: process.env.CLOUDINARY_CLOUD_NAME,
 *     apiKey: process.env.CLOUDINARY_API_KEY,
 *     apiSecret: process.env.CLOUDINARY_API_SECRET,
 *   }),
 * });
 * ```
 */

import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import type { FileStat, PresignedUploadResult, StorageDriver, WriteResult } from '../types/storage.js';
import { LazySecret, type SecretValue, validateSecretValue } from '../utils/lazy-secret.js';
import { uploadFetch, metadataFetch, streamFetch } from './http.js';

export type { StorageDriver, WriteResult, FileStat } from '../types/storage.js';

const SEP = '\n';

export interface CloudinaryProviderConfig {
  /**
   * Cloudinary cloud name (e.g. 'my-cloud'). NOT a secret — appears in every
   * public CDN URL — kept as an eager string because `getPublicUrl()` is
   * synchronous per the `StorageDriver` contract.
   */
  cloudName: string;
  /**
   * Cloudinary API key (numeric string from dashboard).
   *
   * Accepts a string OR a `() => string | Promise<string>` resolver. The
   * resolver form defers credential resolution to the first upload, so
   * environments that DON'T exercise the upload pipeline (test runners,
   * dev previews, partial-deploy workers) can boot without the secret.
   */
  apiKey: SecretValue;
  /** Cloudinary API secret. Same `SecretValue` rules as `apiKey`. */
  apiSecret: SecretValue;
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

/**
 * Split the COMPOSITE key `write()` mints (`publicId
resourceType`).
 *
 * `null` when the key is not composite — a presigned upload stores the
 * generated key instead, and that needs the folder prefix and extension
 * handling {@link CloudinaryProvider.resolveKey} applies.
 */
function parseCompositeKey(key: string): { publicId: string; resourceType: string } | null {
  const idx = key.indexOf(SEP);
  if (idx === -1) return null;
  return { publicId: key.slice(0, idx), resourceType: key.slice(idx + 1) };
}

/**
 * Cloudinary request signature — SIGNATURE VERSION 2, matching the official
 * SDK's `api_sign_request` (`cloudinary/lib/utils/index.js`).
 *
 * v2 differs from v1 by percent-encoding `&` inside each `k=v` pair before
 * joining. That is not cosmetic: without it a value containing `&` splits into
 * extra parameters when Cloudinary parses the signed string, so a crafted
 * `public_id` can smuggle parameters the signer never authorised. v2 is the
 * SDK's default and this signs the same bytes.
 *
 * Sorting is `localeCompare` for the same reason — it is what the SDK does, and
 * a signature that agrees only for ASCII keys is a signature that disagrees
 * eventually.
 */
function sign(params: Record<string, string>, apiSecret: string): string {
  const str = Object.entries(params)
    .filter(([, v]) => v !== null && v !== undefined && v !== '')
    .sort(([a], [b]) => a.localeCompare(b))
    // encode_param: only `&` is escaped, per the SDK.
    .map(([k, v]) => `${k}=${v}`.replace(/&/g, '%26'))
    .join('&');
  return createHash('sha1')
    .update(str + apiSecret)
    .digest('hex');
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
  private readonly apiKeySecret: LazySecret;
  private readonly apiSecretSecret: LazySecret;
  private readonly folder: string;
  private readonly overwrite: boolean;
  private readonly secure: boolean;
  private readonly autoOptimize: boolean;
  /** Memoized basic-auth header — computed on first request that needs credentials. */
  private cachedAuthHeader?: string;

  constructor(config: CloudinaryProviderConfig) {
    if (!config.cloudName) throw new Error('CloudinaryProvider: cloudName is required');
    // String form validated eagerly (preserves "fail at boot" UX); function
    // form deferred to first use.
    validateSecretValue(config.apiKey, 'CloudinaryProvider: apiKey');
    validateSecretValue(config.apiSecret, 'CloudinaryProvider: apiSecret');

    this.cloudName = config.cloudName;
    this.apiKeySecret = new LazySecret(config.apiKey, 'CloudinaryProvider: apiKey');
    this.apiSecretSecret = new LazySecret(config.apiSecret, 'CloudinaryProvider: apiSecret');
    this.folder = config.folder?.replace(/\/+$/, '') ?? '';
    this.overwrite = config.overwrite ?? true;
    this.secure = config.secure ?? true;
    this.autoOptimize = config.autoOptimize ?? true;

    // Eager-string fast path: pre-compute the auth header so existing
    // hosts on the literal form pay zero overhead.
    const literalKey = this.apiKeySecret.literalValue();
    const literalSecret = this.apiSecretSecret.literalValue();
    if (literalKey !== undefined && literalSecret !== undefined) {
      this.cachedAuthHeader = `Basic ${Buffer.from(`${literalKey}:${literalSecret}`).toString('base64')}`;
    }
  }

  /** Resolve + cache the basic-auth header used for every Admin / Upload API call. */
  private async resolveAuthHeader(): Promise<string> {
    if (this.cachedAuthHeader !== undefined) return this.cachedAuthHeader;
    const [apiKey, apiSecret] = await Promise.all([this.apiKeySecret.resolve(), this.apiSecretSecret.resolve()]);
    this.cachedAuthHeader = `Basic ${Buffer.from(`${apiKey}:${apiSecret}`).toString('base64')}`;
    return this.cachedAuthHeader;
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
    const transforms = this.autoOptimize && resourceType === 'image' ? 'f_auto,q_auto/' : '';
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
    const likelyRaw =
      !contentType.startsWith('image/') && !contentType.startsWith('video/') && !contentType.startsWith('audio/');
    const rawPublicId = likelyRaw ? key : key.replace(/\.[^./]+$/, '');
    const publicId = this.folder ? `${this.folder}/${rawPublicId}` : rawPublicId;

    const timestamp = String(Math.floor(Date.now() / 1000));

    const signParams: Record<string, string> = {
      public_id: publicId,
      timestamp,
      overwrite: String(this.overwrite),
    };

    const [apiKey, apiSecret] = await Promise.all([this.apiKeySecret.resolve(), this.apiSecretSecret.resolve()]);
    const signature = sign(signParams, apiSecret);

    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(buffer)], { type: contentType }));
    form.append('public_id', publicId);
    form.append('timestamp', timestamp);
    form.append('api_key', apiKey);
    form.append('signature', signature);
    form.append('overwrite', String(this.overwrite));

    const res = await uploadFetch(this.uploadUrl, { method: 'POST', body: form });

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
    const res = await streamFetch(url);

    if (!res.ok) throw new Error(`Cloudinary read failed (${res.status}): ${url}`);
    if (!res.body) throw new Error('Cloudinary response has no body');

    return Readable.fromWeb(res.body as import('stream/web').ReadableStream);
  }

  /**
   * Delete a file via the Admin API destroy endpoint.
   * `invalidate: true` purges the file from Cloudinary's CDN cache.
   */
  async delete(key: string): Promise<boolean> {
    const { publicId, resourceType } = this.resolveKey(key);
    const timestamp = String(Math.floor(Date.now() / 1000));

    // invalidate must be included in signParams — Cloudinary signs ALL sent params
    // (except api_key, file, resource_type). Omitting it causes 401 Invalid Signature.
    const signParams = { invalidate: 'true', public_id: publicId, timestamp };
    const [apiKey, apiSecret] = await Promise.all([this.apiKeySecret.resolve(), this.apiSecretSecret.resolve()]);
    const signature = sign(signParams, apiSecret);

    const body = new URLSearchParams({
      public_id: publicId,
      timestamp,
      api_key: apiKey,
      signature,
      invalidate: 'true',
    });

    const res = await metadataFetch(this.adminUrl(`/${resourceType}/destroy`), {
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
    const { publicId, resourceType } = this.resolveKey(key);
    const encodedId = encodeURIComponent(publicId).replace(/%2F/g, '/');
    const authHeader = await this.resolveAuthHeader();

    const res = await metadataFetch(this.adminUrl(`/resources/${resourceType}/upload/${encodedId}`), {
      headers: { Authorization: authHeader },
    });

    return res.ok;
  }

  /**
   * Get file metadata via Admin API.
   */
  async stat(key: string): Promise<FileStat> {
    const { publicId, resourceType } = this.resolveKey(key);
    const encodedId = encodeURIComponent(publicId).replace(/%2F/g, '/');
    const authHeader = await this.resolveAuthHeader();

    const res = await metadataFetch(this.adminUrl(`/resources/${resourceType}/upload/${encodedId}`), {
      headers: { Authorization: authHeader },
    });

    if (!res.ok) throw new Error(`Cloudinary stat failed (${res.status}): ${publicId}`);

    const json = (await res.json()) as CloudinaryResourceResponse;
    if (json.error) throw new Error(`Cloudinary stat error: ${json.error.message}`);

    const ext = json.format ? `.${json.format}` : '';
    return {
      size: json.bytes,
      contentType:
        resourceType === 'raw' ? 'application/octet-stream' : `${resourceType}/${json.format || 'octet-stream'}`,
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
    const authHeader = await this.resolveAuthHeader();
    for (const resourceType of ['image', 'video', 'raw'] as const) {
      let nextCursor: string | undefined;

      while (true) {
        const params = new URLSearchParams({
          type: 'upload',
          prefix,
          max_results: '100',
          ...(nextCursor && { next_cursor: nextCursor }),
        });

        const res = await metadataFetch(this.adminUrl(`/resources/${resourceType}?${params}`), {
          headers: { Authorization: authHeader },
        });

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
   * Signed direct upload — the browser POSTs to Cloudinary, the bytes never
   * touch the API server.
   *
   * Cloudinary signs a MULTIPART POST rather than a raw-body PUT, so the result
   * carries `method: 'POST'` plus the `fields` the client must send with the
   * file. Without this method the driver was absent from the presign path and
   * every upload 500'd with "does not support presigned uploads" — the media
   * library was simply non-functional on a Cloudinary deployment.
   *
   * `expiresIn` is advisory: Cloudinary validates the signature against its own
   * timestamp window (~1h) rather than an expiry we choose, so the value is
   * reported for the caller's UI, never enforced here.
   */
  async getSignedUploadUrl(key: string, contentType: string, expiresIn = 3600): Promise<PresignedUploadResult> {
    // Same publicId derivation as write(), or the presigned upload lands at a
    // different key than getPublicUrl() reports and the record points nowhere.
    const likelyRaw =
      !contentType.startsWith('image/') && !contentType.startsWith('video/') && !contentType.startsWith('audio/');
    const rawPublicId = likelyRaw ? key : key.replace(/\.[^./]+$/, '');
    const publicId = this.folder ? `${this.folder}/${rawPublicId}` : rawPublicId;

    const timestamp = String(Math.floor(Date.now() / 1000));
    const signParams: Record<string, string> = {
      public_id: publicId,
      timestamp,
      overwrite: String(this.overwrite),
    };

    const [apiKey, apiSecret] = await Promise.all([this.apiKeySecret.resolve(), this.apiSecretSecret.resolve()]);

    /**
     * PIN the resource type instead of posting to `/auto/upload`.
     *
     * `write()` builds the composite key from Cloudinary's RESPONSE
     * (`public_id
resource_type`), which a presigned upload never sees — the
     * browser gets the response, not us. Under `auto` the type is unknowable in
     * advance, so the key we hand back could not be reconstructed and
     * `confirmUpload`'s `exists()` looked up the wrong id: the upload
     * succeeded and registering it failed with "File not found in storage".
     *
     * Deriving from the declared MIME and posting to that explicit endpoint
     * makes the key deterministic — Cloudinary cannot resolve a type we did not
     * ask for.
     */
    const resourceType = contentType.startsWith('image/')
      ? 'image'
      : contentType.startsWith('video/') || contentType.startsWith('audio/')
        ? 'video'
        : 'raw';

    return {
      uploadUrl: `https://api.cloudinary.com/v1_1/${this.cloudName}/${resourceType}/upload`,
      /**
       * The GENERATED key, unchanged — NOT Cloudinary's composite.
       *
       * `confirmUpload` runs `assertGeneratedKeyShape`, a security control that
       * only accepts a basename the server minted; handing back a
       * driver-shaped key made every confirm 400 with "basename does not match
       * the generated-key format". The publicId is derived from this key on the
       * way in and again in `resolveKey()` on the way out, so the mapping is a
       * function of the key rather than something the client has to carry.
       */
      key,
      publicUrl: this.cdnUrl(publicId, resourceType),
      expiresIn,
      method: 'POST',
      fileField: 'file',
      fields: {
        ...signParams,
        api_key: apiKey,
        signature: sign(signParams, apiSecret),
      },
    };
  }

  /**
   * Resolve a stored key to Cloudinary's `{ publicId, resourceType }`.
   *
   * TWO key shapes reach this driver and both are legitimate:
   *   - `write()` stores the COMPOSITE `publicId
resourceType`, taken from
   *     Cloudinary's own upload response;
   *   - a PRESIGNED upload stores the GENERATED key, because `confirmUpload`
   *     only accepts a server-minted basename.
   *
   * Deriving the second the same way `write()`/`getSignedUploadUrl()` do keeps
   * `exists`, `delete`, `stat` and `getPublicUrl` correct for both. Without it a
   * presigned asset uploaded fine and then read as missing.
   */
  private resolveKey(key: string): { publicId: string; resourceType: string } {
    const composite = parseCompositeKey(key);
    if (composite) return composite;
    // Same derivation as the upload paths: strip the media extension (Cloudinary
    // stores format separately) and apply the configured folder.
    const ext = key.slice(key.lastIndexOf('.') + 1).toLowerCase();
    const isRawExt = !/^(jpe?g|png|gif|webp|avif|svg|bmp|tiff?|mp4|mov|webm|mp3|wav|ogg|m4a)$/.test(ext);
    const rawPublicId = isRawExt ? key : key.replace(/\.[^./]+$/, '');
    return {
      publicId: this.folder ? `${this.folder}/${rawPublicId}` : rawPublicId,
      resourceType: isRawExt ? 'raw' : /^(mp4|mov|webm|mp3|wav|ogg|m4a)$/.test(ext) ? 'video' : 'image',
    };
  }

  /**
   * Reconstruct the Cloudinary CDN URL from the composite key.
   * The publicId is stable even as transformation parameters change.
   */
  getPublicUrl(key: string): string {
    const { publicId, resourceType } = this.resolveKey(key);
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
    const { publicId, resourceType } = this.resolveKey(key);
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
    const { publicId, resourceType } = this.resolveKey(key);
    const expireAt = Math.floor(Date.now() / 1000) + expiresIn;
    const t = transform ? `${transform.replace(/^\/+|\/+$/g, '')}/` : '';

    // Cloudinary signed URL signature: SHA-1 of transform + publicId + expireAt + secret
    const apiSecret = await this.apiSecretSecret.resolve();
    const toSign = `${t}${publicId}${expireAt}${apiSecret}`;
    const signature = createHash('sha1').update(toSign).digest('hex').slice(0, 8);

    const scheme = this.secure ? 'https' : 'http';
    return `${scheme}://res.cloudinary.com/${this.cloudName}/${resourceType}/upload/s--${signature}--/${t}${publicId}?_a=BATAAB0`;
  }
}
