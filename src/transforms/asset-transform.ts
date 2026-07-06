/**
 * Asset Transform Service
 *
 * Framework-agnostic image transformation service.
 * Takes plain request objects, returns plain response objects.
 * Supports content negotiation, focal-point-aware cropping, caching,
 * and byte-range requests for video/audio streaming.
 *
 * @example
 * ```ts
 * import { createAssetTransform } from '@classytic/media-kit/transforms';
 *
 * const transform = createAssetTransform({ media, cache: transformCache });
 *
 * // Express
 * app.get('/assets/:id', async (req, res) => {
 *   const result = await transform.handle({
 *     fileId: req.params.id,
 *     params: req.query,
 *     accept: req.headers.accept,
 *     range: req.headers.range,
 *   });
 *   res.status(result.status);
 *   for (const [k, v] of Object.entries(result.headers)) res.set(k, v);
 *   result.stream.pipe(res);
 * });
 * ```
 */

import type {
  TransformParams,
  TransformRequest,
  TransformResponse,
  TransformCache,
  FocalPoint,
  ImageAdapter,
  IMediaDocument,
  StorageDriver,
  ServeAuthorize,
} from '../types';
import type { UrlSigner } from '../signing/index';
import type { SharpModule, SharpInstanceSource } from '../processing/image';
import { calculateFocalPointCrop } from '../processing/focal-point';
import { contentDispositionAttachment } from '../utils/content-disposition';

/**
 * Minimal structural type — accepts either a MediaEngine or a raw repo+driver pair.
 * Keeps transforms framework-agnostic and compatible with v3 MediaEngine.
 */
export interface MediaTransformSource {
  readonly driver: StorageDriver;
  readonly repositories?: {
    readonly media: {
      getById(id: string): Promise<IMediaDocument | null>;
    };
  };
  /** v2 legacy — direct getById on the kit. Prefer .repositories.media.getById. */
  getById?(id: string): Promise<IMediaDocument | null>;
  /** Shared URL signer — MediaEngine exposes it when `signing` is configured. */
  readonly signing?: UrlSigner | undefined;
  /** Host authorize callback — MediaEngine exposes it when configured. */
  readonly authorize?: ServeAuthorize | undefined;
}

/**
 * Asset transform configuration
 */
export interface AssetTransformConfig {
  /** MediaEngine instance or any source exposing driver + getById */
  media: MediaTransformSource;
  /** Optional transform cache */
  cache?: TransformCache;
  /** Max allowed width (security) */
  maxWidth?: number;
  /** Max allowed height (security) */
  maxHeight?: number;
  /** Allowed formats */
  allowedFormats?: string[];
  /** Optional: reuse the ImageProcessor for shared Sharp config */
  processor?: ImageAdapter;
  /**
   * URL signer used to verify signed requests for `visibility: 'private'`
   * assets. Defaults to the engine's shared signer (`media.signing`).
   */
  signing?: UrlSigner | undefined;
  /**
   * Host authorization callback for private assets served WITHOUT a valid
   * signature (session access — e.g. an admin's own media library, where
   * per-URL signing of 400 thumbnails would be pointless). Defaults to the
   * engine's `authorize`. Return `true` to allow; `false` or a throw denies
   * with 403 (fail-closed). Plug entitlement engines (e.g. @classytic/access
   * `check()`) here — media-kit never imports them.
   */
  authorize?: ServeAuthorize | undefined;
}

/** Deny codes returned in the 403 JSON body: `{ error: { code } }`. */
type ServeDenyCode = 'media.serve.forbidden' | 'media.serve.link_expired';

/** Result of the private-media gate. */
type GateResult = { allowed: true; cacheControl: string | null } | { allowed: false; code: ServeDenyCode };

const FIT_MODES = ['cover', 'contain', 'fill', 'inside', 'outside'] as const;
const FORMAT_MODES = ['webp', 'avif', 'jpeg', 'png', 'auto'] as const;

/**
 * Parse transform params from query string values
 */
function parseParams(raw: TransformParams | Record<string, unknown>): TransformParams {
  const r = raw as Record<string, unknown>;
  const params: TransformParams = {};

  if (r.w) params.w = Math.max(1, parseInt(String(r.w), 10) || 0);
  if (r.h) params.h = Math.max(1, parseInt(String(r.h), 10) || 0);
  if (r.q) params.q = Math.max(1, Math.min(100, parseInt(String(r.q), 10) || 80));
  if (typeof r.fit === 'string' && (FIT_MODES as readonly string[]).includes(r.fit)) {
    params.fit = r.fit as TransformParams['fit'];
  }
  if (typeof r.format === 'string' && (FORMAT_MODES as readonly string[]).includes(r.format)) {
    params.format = r.format as TransformParams['format'];
  }
  if (r.download !== undefined) params.download = true;

  return params;
}

/**
 * Resolve best format from Accept header
 */
function resolveFormat(accept?: string): 'avif' | 'webp' | 'jpeg' {
  if (!accept) return 'jpeg';

  if (accept.includes('image/avif')) return 'avif';
  if (accept.includes('image/webp')) return 'webp';
  return 'jpeg';
}

/**
 * Build a cache key from file ID + transform params
 */
function buildCacheKey(fileId: string, params: TransformParams, format: string): string {
  const parts = [fileId];
  if (params.w) parts.push(`w${params.w}`);
  if (params.h) parts.push(`h${params.h}`);
  if (params.fit) parts.push(`f${params.fit}`);
  if (params.q) parts.push(`q${params.q}`);
  parts.push(format);
  return parts.join('-');
}

const FORMAT_MIME: Record<string, string> = {
  webp: 'image/webp',
  avif: 'image/avif',
  jpeg: 'image/jpeg',
  png: 'image/png',
};

/**
 * Parse Range header
 */
function parseRange(range: string, totalSize: number): { start: number; end: number } | null {
  const match = range.match(/^bytes=(\d+)-(\d*)$/);
  if (!match) return null;

  const start = parseInt(match[1]!, 10);
  const end = match[2] ? parseInt(match[2]!, 10) : totalSize - 1;

  if (start >= totalSize || start > end) return null;

  return { start, end: Math.min(end, totalSize - 1) };
}

/**
 * Asset Transform Service
 */
export class AssetTransformService {
  private media: MediaTransformSource;
  private cache?: TransformCache;
  private maxWidth: number;
  private maxHeight: number;
  private config: AssetTransformConfig;
  private signing: UrlSigner | undefined;
  private authorize: ServeAuthorize | undefined;

  constructor(config: AssetTransformConfig) {
    this.config = config;
    this.media = config.media;
    this.cache = config.cache;
    this.maxWidth = config.maxWidth || 4096;
    this.maxHeight = config.maxHeight || 4096;
    // Explicit service config wins; otherwise pick up the engine's shared
    // signer / authorize so `createAssetTransform({ media: engine })` is
    // fully wired with zero extra host code.
    this.signing = config.signing ?? config.media.signing;
    this.authorize = config.authorize ?? config.media.authorize;
  }

  /**
   * Handle a transform request. Framework-agnostic.
   *
   * Private media: when the doc has `visibility: 'private'`, the request must
   * carry a valid HMAC signature (`request.query`) or be approved by the
   * host's `authorize` callback BEFORE any bytes are read from storage.
   * Denials return a 403 response with a JSON body `{ error: { code } }` —
   * `media.serve.link_expired` for authentically-signed-but-expired URLs,
   * `media.serve.forbidden` for everything else.
   */
  async handle(request: TransformRequest): Promise<TransformResponse> {
    const { fileId, accept, range } = request;
    const params = parseParams(request.params);

    // Enforce security limits
    if (params.w) params.w = Math.min(params.w, this.maxWidth);
    if (params.h) params.h = Math.min(params.h, this.maxHeight);

    // Fetch file metadata from DB — prefer v3 engine shape, fall back to v2
    const file = this.media.repositories
      ? await this.media.repositories.media.getById(fileId)
      : await this.media.getById?.(fileId);
    if (!file) {
      throw new Error(`File not found: ${fileId}`);
    }

    // --- Auth gate: BEFORE any bytes are read or cache is consulted ---
    const gate = await this.gate(request, file);
    if (!gate.allowed) {
      return this.deny(gate.code);
    }
    // Non-null for private files: overrides every public Cache-Control below.
    const cacheControl = gate.cacheControl;

    // --- Variant resolution: serve a specific variant's bytes when requested ---
    let serveTarget: { key: string; mimeType: string; size: number; filename: string } = file;
    if (request.variant) {
      const variant = (file.variants ?? []).find((v) => v.name === request.variant);
      if (!variant) {
        throw new Error(`Variant not found: ${request.variant} (file ${fileId})`);
      }
      serveTarget = variant;
    }

    const isImage = serveTarget.mimeType.startsWith('image/');
    const hasTransforms = params.w || params.h || params.format || params.q;

    // --- Non-image or no transforms: proxy raw file ---
    if (!isImage || !hasTransforms) {
      return this.serveRaw(
        serveTarget.key,
        serveTarget.mimeType,
        serveTarget.size,
        range,
        params.download,
        cacheControl,
      );
    }

    // --- Image transform ---
    const format = params.format === 'auto' ? resolveFormat(accept) : params.format || 'jpeg';

    const cacheKey = buildCacheKey(request.variant ? `${fileId}-${request.variant}` : fileId, params, format);

    // Check cache (auth already passed — private hits still get private headers)
    if (this.cache) {
      const cached = await this.cache.get(cacheKey);
      if (cached) {
        return {
          stream: cached.stream,
          contentType: cached.contentType,
          status: 200,
          headers: {
            'Cache-Control': cacheControl ?? 'public, max-age=31536000, immutable',
            Vary: 'Accept',
          },
        };
      }
    }

    // Process image
    const transformed = await this.transformImage(
      {
        key: serveTarget.key,
        mimeType: serveTarget.mimeType,
        focalPoint: file.focalPoint,
        width: file.width,
        height: file.height,
      },
      params,
      format,
    );

    // Cache result
    if (this.cache) {
      // Don't await cache write — fire and forget
      this.cache.set(cacheKey, transformed.buffer, transformed.contentType).catch(() => {});
    }

    const { Readable } = await import('node:stream');
    const stream = Readable.from(transformed.buffer);

    return {
      stream,
      contentType: transformed.contentType,
      contentLength: transformed.buffer.length,
      status: 200,
      headers: {
        'Cache-Control': cacheControl ?? 'public, max-age=31536000, immutable',
        'Content-Length': String(transformed.buffer.length),
        Vary: 'Accept',
        ...(params.download ? { 'Content-Disposition': contentDispositionAttachment(serveTarget.filename) } : {}),
      },
    };
  }

  /**
   * Private-media gate. Runs BEFORE any storage read.
   *
   * Decision order:
   *   1. `visibility !== 'private'` → allow (zero behavior change for
   *      existing/public media — headers stay public).
   *   2. Valid signature (verified against the doc's current tokenVersion)
   *      → allow with `private, max-age=min(remaining TTL, 3600)`. Rationale:
   *      a signed URL IS the credential — anyone holding the URL gets the
   *      bytes anyway, so letting the holder's browser/proxy cache it for
   *      (at most) the signature's own validity window leaks nothing and
   *      keeps LLM/embed replays cheap. Capped at 1h so revocation
   *      (tokenVersion bump) has a bounded staleness horizon.
   *   3. `authorize` callback approves → allow with `private, no-store`:
   *      session-authorized responses depend on ambient credentials
   *      (cookies), so shared caches must never store them.
   *   4. Otherwise deny 403 — `link_expired` only when an authentic
   *      signature had merely expired, `forbidden` for everything else.
   *
   * An `authorize` callback that THROWS is treated as a denial (fail-closed,
   * same stance as arc's `isRevoked`): an erroring authorizer must never
   * leak private bytes, and a 500 here would turn transient host bugs into
   * a probe-friendly oracle.
   */
  private async gate(request: TransformRequest, file: IMediaDocument): Promise<GateResult> {
    if (file.visibility !== 'private') {
      return { allowed: true, cacheControl: null };
    }

    let signatureExpired = false;

    if (this.signing && request.query?.sig) {
      const result = this.signing.verify({
        id: request.fileId,
        variant: request.variant,
        params: request.query,
        expectedTokenVersion: file.tokenVersion ?? 0,
      });
      if (result.ok) {
        const expiry = Number.parseInt(request.query.e ?? '0', 10);
        const remaining = expiry - Math.floor(Date.now() / 1000);
        const maxAge = Math.max(0, Math.min(remaining, 3600));
        return { allowed: true, cacheControl: `private, max-age=${maxAge}` };
      }
      signatureExpired = result.reason === 'expired';
    }

    if (this.authorize) {
      try {
        if (await this.authorize(request, file)) {
          return { allowed: true, cacheControl: 'private, no-store' };
        }
      } catch {
        // Fail-closed: an erroring authorizer denies, it never serves.
      }
    }

    return { allowed: false, code: signatureExpired ? 'media.serve.link_expired' : 'media.serve.forbidden' };
  }

  /**
   * Build a 403 denial response with a JSON body `{ error: { code } }`.
   * Returned (not thrown) so hosts that pipe `handle()` results verbatim get
   * correct denial semantics with zero extra error mapping.
   */
  private async deny(code: ServeDenyCode): Promise<TransformResponse> {
    const body = Buffer.from(JSON.stringify({ error: { code } }));
    const { Readable } = await import('node:stream');
    return {
      stream: Readable.from(body),
      contentType: 'application/json',
      contentLength: body.length,
      status: 403,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': String(body.length),
        'Cache-Control': 'private, no-store',
      },
    };
  }

  /**
   * Serve raw file (no transform) — supports range requests.
   * `cacheControl` (set for private files) replaces the public default.
   */
  private async serveRaw(
    key: string,
    contentType: string,
    fileSize: number,
    rangeHeader?: string,
    download?: boolean,
    cacheControl?: string | null,
  ): Promise<TransformResponse> {
    const headers: Record<string, string> = {
      'Content-Type': contentType,
      'Accept-Ranges': 'bytes',
      'Cache-Control': cacheControl ?? 'public, max-age=86400',
    };

    if (download) {
      const filename = key.split('/').pop() || 'download';
      headers['Content-Disposition'] = contentDispositionAttachment(filename);
    }

    // Range request (HTTP 206)
    if (rangeHeader && fileSize > 0) {
      const range = parseRange(rangeHeader, fileSize);
      if (range) {
        const stream = await this.media.driver.read(key, range);
        const contentLength = range.end - range.start + 1;

        return {
          stream,
          contentType,
          contentLength,
          status: 206,
          headers: {
            ...headers,
            'Content-Length': String(contentLength),
            'Content-Range': `bytes ${range.start}-${range.end}/${fileSize}`,
          },
        };
      }
    }

    // Full file
    const stream = await this.media.driver.read(key);

    return {
      stream,
      contentType,
      contentLength: fileSize,
      status: 200,
      headers: {
        ...headers,
        'Content-Length': String(fileSize),
      },
    };
  }

  /**
   * Transform an image using Sharp
   */
  private async transformImage(
    file: { key: string; mimeType: string; focalPoint?: FocalPoint; width?: number; height?: number },
    params: TransformParams,
    format: string,
  ): Promise<{ buffer: Buffer; contentType: string }> {
    let sharp: SharpModule;
    try {
      // Prefer shared processor's Sharp instance (respects concurrency/cache config)
      if (this.config.processor && 'getSharpInstance' in this.config.processor) {
        sharp = await (this.config.processor as ImageAdapter & SharpInstanceSource).getSharpInstance();
      } else {
        sharp = (await import('sharp')).default;
      }
    } catch {
      throw new Error('sharp is required for image transforms. Install: npm install sharp');
    }

    // Read file as stream, buffer it
    const stream = await this.media.driver.read(file.key);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const buffer = Buffer.concat(chunks);

    let instance = sharp(buffer);
    const metadata = await sharp(buffer).metadata();
    const origWidth = metadata.width || 0;
    const origHeight = metadata.height || 0;

    const targetWidth = params.w || origWidth;
    const targetHeight = params.h || origHeight;

    // Focal-point-aware crop
    if (params.fit === 'cover' && file.focalPoint && params.w && params.h) {
      const crop = calculateFocalPointCrop({
        originalWidth: origWidth,
        originalHeight: origHeight,
        targetWidth,
        targetHeight,
        focalX: file.focalPoint.x,
        focalY: file.focalPoint.y,
      });

      instance = instance.extract(crop).resize(targetWidth, targetHeight, { fit: 'fill' });
    } else if (params.w || params.h) {
      instance = instance.resize(params.w || null, params.h || null, {
        fit: params.fit || 'cover',
        withoutEnlargement: true,
      });
    }

    // Format conversion
    const quality = params.q || 82;
    switch (format) {
      case 'webp':
        instance = instance.webp({ quality });
        break;
      case 'avif':
        instance = instance.avif({ quality });
        break;
      case 'jpeg':
        instance = instance.jpeg({ quality });
        break;
      case 'png': {
        const compressionLevel = Math.round(9 - (quality / 100) * 9);
        instance = instance.png({ compressionLevel, palette: quality < 100 });
        break;
      }
    }

    const outputBuffer = await instance.toBuffer();

    return {
      buffer: outputBuffer,
      contentType: FORMAT_MIME[format] || 'image/jpeg',
    };
  }
}

/**
 * Create an asset transform service instance
 */
export function createAssetTransform(config: AssetTransformConfig): AssetTransformService {
  return new AssetTransformService(config);
}
