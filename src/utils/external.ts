/**
 * External (reference-only) media helpers.
 *
 * An EXTERNAL media record registers a URL that lives on a third party
 * (Cloudflare Images delivery URL, an existing CDN asset, a partner's hosted
 * image) as a first-class media record — tenancy, visibility, folders, tags,
 * listing, events — WITHOUT media-kit owning the bytes.
 *
 * Discriminator: `provider === 'external'` (the `provider` field, NOT the
 * key prefix, is the single source of truth — use {@link isExternalMedia}
 * everywhere). No driver named `'external'` is ever registered, so every
 * storage-op call site MUST check `isExternalMedia()` before resolving a
 * driver for a record's provider.
 *
 * Sentinel key: `__external__/<sha256-hex-16-of-url>` — lives in the
 * package's reserved `__` namespace (like `__transforms/` and `__t-`), so it
 * can never collide with host folders or generated presign keys
 * (`assertGeneratedKeyShape` rejects it: the basename has no
 * `<timestamp>-<hex12>-<name>.<ext>` shape). 16 hex chars = 64 bits of the
 * URL's SHA-256 — collision-safe for a registry (two DIFFERENT urls sharing
 * a key would need ~2^32 registrations; and the key is only a namespace
 * marker, never used for storage I/O).
 */

import { createHash } from 'node:crypto';
import { createError } from '@classytic/repo-core/errors';

/** Value stored on `IMedia.provider` for external (reference-only) records. */
export const EXTERNAL_PROVIDER = 'external';

/** Reserved key-namespace prefix for external records' sentinel keys. */
export const EXTERNAL_KEY_PREFIX = '__external__/';

/**
 * TRUE when the record is an external reference (no readable bytes in any
 * registered storage driver). The `provider` field is the canonical
 * discriminator — the `__external__/` key prefix is informational only.
 */
export function isExternalMedia(media: { provider?: string | undefined }): boolean {
  return media.provider === EXTERNAL_PROVIDER;
}

/** SHA-256 hex of the URL string — stored as the record's `hash`. */
export function externalUrlHash(url: string): string {
  return createHash('sha256').update(url).digest('hex');
}

/** Sentinel key for an external record: `__external__/<sha256-hex-16-of-url>`. */
export function buildExternalKey(url: string): string {
  return `${EXTERNAL_KEY_PREFIX}${externalUrlHash(url).slice(0, 16)}`;
}

/**
 * Validate a register-time external URL: must parse as an ABSOLUTE http(s)
 * URL. `javascript:`, `data:`, `file:`, protocol-relative, and relative URLs
 * are all rejected with a 400 `HttpError` (`code:
 * 'media.external.invalid_url'`).
 *
 * Deliberately does NOT fetch the URL — `registerExternal()` is a reference
 * registry, not an importer. Re-hosting (which fetches, and carries the SSRF
 * machinery) is `importFromUrl()`.
 */
export function assertExternalUrl(raw: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    const err = createError(400, `[media-kit] registerExternal: '${raw}' is not an absolute URL`);
    err.code = 'media.external.invalid_url';
    throw err;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    const err = createError(
      400,
      `[media-kit] registerExternal: unsupported protocol '${parsed.protocol}' — only http/https allowed`,
    );
    err.code = 'media.external.invalid_url';
    throw err;
  }
  return parsed;
}

/**
 * Enforce the optional `external.allowedOrigins` config allowlist. Each
 * entry is normalized through `new URL().origin` so `'https://cdn.example.com/'`
 * and `'https://cdn.example.com'` both match. Throws a 403 `HttpError`
 * (`code: 'media.external.origin_not_allowed'`) on mismatch. No-op when the
 * allowlist is unset or empty.
 */
export function assertExternalOriginAllowed(url: URL, allowedOrigins?: string[] | undefined): void {
  if (!allowedOrigins || allowedOrigins.length === 0) return;
  for (const entry of allowedOrigins) {
    try {
      if (new URL(entry).origin === url.origin) return;
    } catch {
      // Malformed allowlist entry — skip (config-schema validation should
      // have caught it; a bad entry must never widen the allowlist).
    }
  }
  const err = createError(
    403,
    `[media-kit] registerExternal: origin '${url.origin}' is not in external.allowedOrigins`,
  );
  err.code = 'media.external.origin_not_allowed';
  throw err;
}
