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

  /**
   * OPTIONAL — evict cached copies of the given storage keys from the CDN
   * edge. Called best-effort (fire-and-forget, failures logged) after
   * `hardDelete()` and after `replace()` (with the REPLACED keys) — the two
   * moments a CDN can keep serving bytes the origin no longer has. The host
   * maps keys back to its CDN URLs (it authored `transform()`, so it knows
   * the mapping) and calls its CDN's purge API (Cloudflare
   * `purge_cache`, CloudFront `CreateInvalidation`, ...). Absent method =
   * pre-3.8 behavior: stale copies age out via cache TTL.
   */
  purge?(keys: string[], ctx?: CdnContext): void | Promise<void>;
}
