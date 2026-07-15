/**
 * imgproxy URL builder — offload on-the-fly image transforms to an
 * [imgproxy](https://imgproxy.net/) instance instead of running Sharp inside
 * the app process.
 *
 * `AssetTransformService` transforms in-process: a burst of resize requests
 * competes with your API for CPU, and results are only edge-cached if a CDN
 * sits in front. The Supabase-style answer is a dedicated imgproxy container
 * (one `docker run ghcr.io/imgproxy/imgproxy`) doing the pixel work, with the
 * CDN caching its output. This module is the missing glue: signed imgproxy
 * URL generation (HMAC-SHA256, zero deps, `node:crypto` only) plus an
 * {@link CdnBridge} adapter so every `getAssetUrl()` call routes through it.
 *
 * @example
 * ```ts
 * import { createImgproxyUrlBuilder } from '@classytic/media-kit/transforms';
 *
 * const imgproxy = createImgproxyUrlBuilder({
 *   endpoint: 'https://img.example.com',
 *   key: process.env.IMGPROXY_KEY,   // hex, same as imgproxy's IMGPROXY_KEY
 *   salt: process.env.IMGPROXY_SALT, // hex, same as imgproxy's IMGPROXY_SALT
 * });
 *
 * imgproxy.buildUrl('https://cdn.example.com/uploads/cat.jpg', {
 *   width: 640, quality: 80, format: 'webp',
 * });
 * // → https://img.example.com/<sig>/rs:fit:640:0/q:80/<base64url>.webp
 *
 * // Route ALL public asset URLs through imgproxy:
 * const engine = await createMedia({ ..., bridges: { cdn: imgproxy.asCdnBridge({ format: 'webp' }) } });
 * ```
 */

import { createHmac } from 'node:crypto';
import type { CdnBridge } from '../bridges/cdn.bridge.js';

/** imgproxy resizing types — https://docs.imgproxy.net (resizing_type). */
export type ImgproxyResizingType = 'fit' | 'fill' | 'fill-down' | 'force' | 'auto';

export interface ImgproxyOptions {
  /** Target width in px (0 = auto). */
  width?: number;
  /** Target height in px (0 = auto). */
  height?: number;
  /** Resizing type. Default `'fit'`. */
  resizingType?: ImgproxyResizingType;
  /** Output quality 1–100. */
  quality?: number;
  /** Output format (`webp`, `avif`, `jpeg`, `png`, ...). */
  format?: string;
  /** Device pixel ratio multiplier. */
  dpr?: number;
  /**
   * Raw imgproxy processing options appended verbatim (escape hatch for the
   * full option surface: `'blur:5'`, `'watermark:0.5:soea'`, ...).
   */
  extra?: string[];
}

export interface ImgproxyUrlBuilderConfig {
  /** imgproxy base URL, e.g. `https://img.example.com` (no trailing slash needed). */
  endpoint: string;
  /**
   * Hex-encoded signing key — the same value as imgproxy's `IMGPROXY_KEY`.
   * Provide both `key` and `salt` or neither (unsigned `insecure` mode —
   * only for imgproxy instances running with no key configured).
   */
  key?: string;
  /** Hex-encoded signing salt — imgproxy's `IMGPROXY_SALT`. */
  salt?: string;
}

export interface ImgproxyUrlBuilder {
  /** Build a (signed) imgproxy URL for a source image URL. */
  buildUrl(sourceUrl: string, options?: ImgproxyOptions): string;
  /**
   * Adapt the builder into a {@link CdnBridge}: every public asset URL is
   * rewritten through imgproxy with `defaults`. Signed-URL requests
   * (`ctx.signed`) pass through UNCHANGED — a private asset's HMAC-gated URL
   * must reach media-kit's serve pipeline, not a public transform cache.
   */
  asCdnBridge(defaults?: ImgproxyOptions): CdnBridge;
}

function hexToBuffer(hex: string, name: string): Buffer {
  if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length % 2 !== 0) {
    throw new Error(`[media-kit] imgproxy ${name} must be a hex string (imgproxy prints them hex-encoded)`);
  }
  return Buffer.from(hex, 'hex');
}

function processingOptions(options: ImgproxyOptions): string[] {
  const parts: string[] = [];
  if (options.width !== undefined || options.height !== undefined) {
    const type = options.resizingType ?? 'fit';
    parts.push(`rs:${type}:${options.width ?? 0}:${options.height ?? 0}`);
  }
  if (options.dpr !== undefined) parts.push(`dpr:${options.dpr}`);
  if (options.quality !== undefined) parts.push(`q:${options.quality}`);
  if (options.extra) parts.push(...options.extra);
  return parts;
}

export function createImgproxyUrlBuilder(config: ImgproxyUrlBuilderConfig): ImgproxyUrlBuilder {
  const endpoint = config.endpoint.replace(/\/+$/, '');
  if ((config.key === undefined) !== (config.salt === undefined)) {
    throw new Error('[media-kit] imgproxy signing needs BOTH key and salt (or neither for insecure mode)');
  }
  const key = config.key !== undefined ? hexToBuffer(config.key, 'key') : null;
  const salt = config.salt !== undefined ? hexToBuffer(config.salt, 'salt') : null;

  const sign = (path: string): string => {
    if (!key || !salt) return 'insecure';
    // imgproxy signature: base64url(HMAC-SHA256(key, salt || path)).
    return createHmac('sha256', key)
      .update(Buffer.concat([salt, Buffer.from(path)]))
      .digest('base64url');
  };

  const buildUrl = (sourceUrl: string, options: ImgproxyOptions = {}): string => {
    // base64url source — survives any character in the origin URL (query
    // strings, unicode filenames) without plain-mode escaping edge cases.
    const encoded = Buffer.from(sourceUrl).toString('base64url');
    const source = options.format ? `${encoded}.${options.format}` : encoded;
    const path = `/${[...processingOptions(options), source].join('/')}`;
    return `${endpoint}/${sign(path)}${path}`;
  };

  return {
    buildUrl,
    asCdnBridge(defaults: ImgproxyOptions = {}): CdnBridge {
      return {
        transform(_key, defaultUrl, ctx) {
          if (ctx?.signed) return defaultUrl;
          return buildUrl(defaultUrl, defaults);
        },
      };
    },
  };
}
