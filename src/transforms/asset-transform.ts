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
} from '../types';
import { calculateFocalPointCrop } from '../processing/focal-point';

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
}

/**
 * Parse transform params from query string values
 */
function parseParams(raw: Record<string, any>): TransformParams {
  const params: TransformParams = {};

  if (raw.w) params.w = Math.max(1, parseInt(String(raw.w), 10) || 0);
  if (raw.h) params.h = Math.max(1, parseInt(String(raw.h), 10) || 0);
  if (raw.q) params.q = Math.max(1, Math.min(100, parseInt(String(raw.q), 10) || 80));
  if (raw.fit && ['cover', 'contain', 'fill', 'inside', 'outside'].includes(raw.fit)) {
    params.fit = raw.fit;
  }
  if (raw.format && ['webp', 'avif', 'jpeg', 'png', 'auto'].includes(raw.format)) {
    params.format = raw.format;
  }
  if (raw.download !== undefined) params.download = true;

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

  constructor(config: AssetTransformConfig) {
    this.config = config;
    this.media = config.media;
    this.cache = config.cache;
    this.maxWidth = config.maxWidth || 4096;
    this.maxHeight = config.maxHeight || 4096;
  }

  /**
   * Handle a transform request. Framework-agnostic.
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
      : await this.media.getById!(fileId);
    if (!file) {
      throw new Error(`File not found: ${fileId}`);
    }

    const isImage = file.mimeType.startsWith('image/');
    const hasTransforms = params.w || params.h || params.format || params.q;

    // --- Non-image or no transforms: proxy raw file ---
    if (!isImage || !hasTransforms) {
      return this.serveRaw(file.key, file.mimeType, file.size, range, params.download);
    }

    // --- Image transform ---
    const format = params.format === 'auto'
      ? resolveFormat(accept)
      : (params.format || 'jpeg');

    const cacheKey = buildCacheKey(fileId, params, format);

    // Check cache
    if (this.cache) {
      const cached = await this.cache.get(cacheKey);
      if (cached) {
        return {
          stream: cached.stream,
          contentType: cached.contentType,
          status: 200,
          headers: {
            'Cache-Control': 'public, max-age=31536000, immutable',
            'Vary': 'Accept',
          },
        };
      }
    }

    // Process image
    const transformed = await this.transformImage(file, params, format);

    // Cache result
    if (this.cache) {
      // Don't await cache write — fire and forget
      this.cache.set(cacheKey, transformed.buffer, transformed.contentType).catch(() => {});
    }

    const { Readable } = await import('stream');
    const stream = Readable.from(transformed.buffer);

    return {
      stream,
      contentType: transformed.contentType,
      contentLength: transformed.buffer.length,
      status: 200,
      headers: {
        'Cache-Control': 'public, max-age=31536000, immutable',
        'Content-Length': String(transformed.buffer.length),
        'Vary': 'Accept',
        ...(params.download ? { 'Content-Disposition': `attachment; filename="${file.filename}"` } : {}),
      },
    };
  }

  /**
   * Serve raw file (no transform) — supports range requests
   */
  private async serveRaw(
    key: string,
    contentType: string,
    fileSize: number,
    rangeHeader?: string,
    download?: boolean
  ): Promise<TransformResponse> {
    const headers: Record<string, string> = {
      'Content-Type': contentType,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'public, max-age=86400',
    };

    if (download) {
      const filename = key.split('/').pop() || 'download';
      headers['Content-Disposition'] = `attachment; filename="${filename}"`;
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
    format: string
  ): Promise<{ buffer: Buffer; contentType: string }> {
    let sharp: any;
    try {
      // Prefer shared processor's Sharp instance (respects concurrency/cache config)
      if (this.config.processor && 'getSharpInstance' in this.config.processor) {
        sharp = await (this.config.processor as any).getSharpInstance();
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
      case 'webp': instance = instance.webp({ quality }); break;
      case 'avif': instance = instance.avif({ quality }); break;
      case 'jpeg': instance = instance.jpeg({ quality }); break;
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
