/**
 * CdnBridge — custom URL transformation for storage keys.
 *
 * Storage drivers return raw URLs (e.g. S3 bucket URL). In production,
 * you typically want to serve through a CDN with custom domain, signed
 * URLs, or image transformation (imgix, Cloudflare Images, CloudFront
 * Functions). This bridge lets the host rewrite URLs without patching
 * the driver.
 *
 * Applied to both the main asset URL and each variant URL at read time.
 *
 * @example
 * ```typescript
 * // CloudFront signed URLs
 * const cdnBridge: CdnBridge = {
 *   transform(key, defaultUrl, ctx) {
 *     const url = `https://cdn.example.com/${key}`;
 *     if (ctx?.signed) return signCloudFrontUrl(url, { expiresIn: 3600 });
 *     return url;
 *   },
 * };
 *
 * // imgix transformation layer
 * const cdnBridge: CdnBridge = {
 *   transform(key) {
 *     return `https://my-images.imgix.net/${key}?auto=format,compress`;
 *   },
 * };
 * ```
 */

export interface CdnContext {
  /** Request a signed URL (for private assets). */
  signed?: boolean;
  /** Expiry for signed URLs in seconds (default: 3600). */
  expiresIn?: number;
  /** Organization scope for per-tenant CDN routing. */
  organizationId?: string;
  /** Additional host-specific hints. */
  [key: string]: unknown;
}

export interface CdnBridge {
  /**
   * Transform a storage key + default URL into a CDN-served URL.
   *
   * Return the original `defaultUrl` to opt out (pass through).
   */
  transform(key: string, defaultUrl: string, ctx?: CdnContext): string | Promise<string>;
}
