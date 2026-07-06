/**
 * URL Signing — zero-dependency HMAC-SHA256 query signing for private media.
 *
 * Standalone by design: this module imports ONLY `node:crypto` and nothing
 * from the rest of the package, so it stays tree-shakeable and hosts can use
 * it independently (e.g. to verify signatures at a CDN edge worker or in a
 * separate service that never touches the media engine).
 *
 * Why package-level HMAC signing instead of storage-native presigning?
 *   - Storage-native signing (S3 SigV4 / GCS V4) caps expiry at 7 days.
 *     HMAC proxy URLs can live as long as the host wants — which matters for
 *     URLs handed to LLM providers (see below).
 *   - It works uniformly across ALL drivers, including Local, Cloudinary,
 *     ImageKit and imgbb, which have no native GET presigning.
 *   - Signatures survive key rotation: keep N-1 keys in the keyring and old
 *     URLs keep verifying until they expire.
 *
 * LLM-context design note (bake this into host decisions):
 *   Anthropic/OpenAI fetch `url`-sourced images server-side, ANONYMOUSLY
 *   (no headers, no cookies), per request, on EVERY chat-history replay.
 *   A signed URL handed to an LLM therefore must be query-signed (all auth
 *   material in the URL itself) and long-lived enough to survive replays —
 *   or the host should send base64 / provider file ids instead.
 *   Re-signing (i.e. a CHANGING URL for the same asset) in chat history
 *   breaks Anthropic prompt caching — byte-stable references win.
 *
 * @example
 * ```ts
 * import { createUrlSigner } from '@classytic/media-kit/signing';
 *
 * const signer = createUrlSigner({ secret: process.env.MEDIA_SIGNING_SECRET });
 * const { query, expiresAt } = signer.sign({ id: '665f...', expiresIn: 86400 });
 * const url = `https://api.example.com/media/content/665f...?${query}`;
 *
 * // Later, in the serve route:
 * const result = signer.verify({ id: '665f...', params: req.query });
 * if (!result.ok) return reply.code(403).send({ error: { code: result.reason } });
 * ```
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

// ── Types ─────────────────────────────────────────────────────

/** Options for {@link createUrlSigner}. Provide EITHER `keys` OR `secret`. */
export interface UrlSignerOptions {
  /**
   * Keyring: kid → secret. Keep retired keys in the ring so previously
   * minted URLs verify until expiry (N-1 rollover), and point `currentKid`
   * at the key new signatures should use.
   */
  keys?: Record<string, string> | undefined;
  /** Single-secret convenience — equivalent to `keys: { k1: secret }`. */
  secret?: string | undefined;
  /** Key id used for NEW signatures. Required when `keys` has 2+ entries. */
  currentKid?: string | undefined;
  /** Default TTL in seconds when `sign()` gets no `expiresIn` (default: 3600). */
  defaultTtl?: number | undefined;
}

/** Input to {@link UrlSigner.sign}. */
export interface SignUrlInput {
  /** Asset id (media document id) the URL grants access to. */
  id: string;
  /** Variant name, when the URL targets a specific variant. */
  variant?: string | undefined;
  /** TTL in seconds (falls back to the signer's `defaultTtl`). */
  expiresIn?: number | undefined;
  /**
   * Extra signed claims (e.g. `{ uid: 'user_1' }` to bind a URL to a user or
   * conversation). Serialized as `c.<key>=<value>` query params — every claim
   * is covered by the signature.
   */
  claims?: Record<string, string> | undefined;
  /**
   * Document token version (default 0). Bump the doc's `tokenVersion`
   * (`repo.revokeAccess()`) to invalidate every outstanding URL at once.
   */
  tokenVersion?: number | undefined;
}

/** Result of {@link UrlSigner.sign}. */
export interface SignUrlResult {
  /** Ready-to-append query string: `e=...&kid=...&v=...[&c.k=v...]&sig=...` */
  query: string;
  /** Unix expiry (seconds). */
  expiresAt: number;
}

/** Input to {@link UrlSigner.verify}. */
export interface VerifyUrlInput {
  /** Asset id from the request path. */
  id: string;
  /** Variant from the request path (must match what was signed). */
  variant?: string | undefined;
  /** Decoded query params of the incoming request (`req.query`). */
  params: Record<string, string>;
  /** The doc's CURRENT tokenVersion — mismatch → `version_mismatch`. */
  expectedTokenVersion?: number | undefined;
  /** Clock override for tests (unix seconds; default `Date.now()/1000`). */
  now?: number | undefined;
}

/** Failure reasons returned by {@link UrlSigner.verify}. */
export type VerifyFailureReason = 'expired' | 'bad_signature' | 'unknown_kid' | 'version_mismatch' | 'malformed';

/** Result of {@link UrlSigner.verify} — a discriminated union on `ok`. */
export type VerifyUrlResult = { ok: true } | { ok: false; reason: VerifyFailureReason };

/** HMAC query signer/verifier — created via {@link createUrlSigner}. */
export interface UrlSigner {
  sign(input: SignUrlInput): SignUrlResult;
  verify(input: VerifyUrlInput): VerifyUrlResult;
}

// ── Internals ─────────────────────────────────────────────────

const CANONICAL_VERSION = 'mkv1';

/**
 * Build the canonical string the HMAC covers. EVERY externally-supplied
 * parameter is included — id, variant, expiry, kid, tokenVersion, and all
 * claims (sorted by key). Components are URI-encoded before joining so a
 * crafted value containing the `\n` delimiter cannot forge a collision.
 */
function canonicalString(
  id: string,
  variant: string | undefined,
  e: number,
  kid: string,
  tokenVersion: number,
  claims: Array<[string, string]>,
): string {
  const parts = [
    CANONICAL_VERSION,
    encodeURIComponent(id),
    encodeURIComponent(variant ?? ''),
    String(e),
    encodeURIComponent(kid),
    String(tokenVersion),
  ];
  for (const [key, value] of claims) {
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(value)}`);
  }
  return parts.join('\n');
}

function hmac(secret: string, canonical: string): Buffer {
  return createHmac('sha256', secret).update(canonical).digest();
}

function sortClaims(claims: Record<string, string>): Array<[string, string]> {
  return Object.entries(claims).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

const INT_RE = /^-?\d+$/;

// ── Factory ───────────────────────────────────────────────────

/**
 * Create a URL signer backed by an HMAC-SHA256 keyring.
 *
 * Key rotation: add the new key to `keys`, point `currentKid` at it, and keep
 * the old key(s) in the ring until their longest-lived URLs expire. `verify()`
 * resolves the key from the URL's `kid` param; a kid absent from the ring
 * fails with `unknown_kid`.
 */
export function createUrlSigner(options: UrlSignerOptions): UrlSigner {
  const { secret, currentKid, defaultTtl = 3600 } = options;

  if (secret !== undefined && options.keys !== undefined) {
    throw new Error('[media-kit] createUrlSigner: provide either `keys` or `secret`, not both');
  }
  const keys: Record<string, string> = secret !== undefined ? { k1: secret } : { ...(options.keys ?? {}) };
  const kids = Object.keys(keys);
  if (kids.length === 0) {
    throw new Error('[media-kit] createUrlSigner: a signing key is required (`keys` or `secret`)');
  }
  for (const kid of kids) {
    if (!keys[kid]) throw new Error(`[media-kit] createUrlSigner: key '${kid}' has an empty secret`);
  }
  const signingKid = currentKid ?? (kids.length === 1 ? kids[0]! : undefined);
  if (!signingKid) {
    throw new Error('[media-kit] createUrlSigner: `currentKid` is required when the keyring has multiple keys');
  }
  if (!keys[signingKid]) {
    throw new Error(`[media-kit] createUrlSigner: currentKid '${signingKid}' is not in the keyring`);
  }
  if (!Number.isFinite(defaultTtl) || defaultTtl <= 0) {
    throw new Error('[media-kit] createUrlSigner: defaultTtl must be a positive number of seconds');
  }

  return {
    sign(input: SignUrlInput): SignUrlResult {
      const ttl = input.expiresIn ?? defaultTtl;
      if (!Number.isFinite(ttl) || ttl <= 0) {
        throw new Error('[media-kit] sign: expiresIn must be a positive number of seconds');
      }
      const e = Math.floor(Date.now() / 1000) + Math.floor(ttl);
      const tokenVersion = input.tokenVersion ?? 0;
      const claims = sortClaims(input.claims ?? {});

      const canonical = canonicalString(input.id, input.variant, e, signingKid, tokenVersion, claims);
      const sig = hmac(keys[signingKid]!, canonical).toString('base64url');

      const parts = [`e=${e}`, `kid=${encodeURIComponent(signingKid)}`, `v=${tokenVersion}`];
      for (const [key, value] of claims) {
        parts.push(`c.${encodeURIComponent(key)}=${encodeURIComponent(value)}`);
      }
      parts.push(`sig=${sig}`);

      return { query: parts.join('&'), expiresAt: e };
    },

    verify(input: VerifyUrlInput): VerifyUrlResult {
      const { params } = input;
      const e = params.e;
      const kid = params.kid;
      const v = params.v;
      const sig = params.sig;

      if (!e || !kid || !v || !sig || !INT_RE.test(e) || !INT_RE.test(v)) {
        return { ok: false, reason: 'malformed' };
      }

      const key = keys[kid];
      if (key === undefined) {
        return { ok: false, reason: 'unknown_kid' };
      }

      // Reconstruct claims from `c.`-prefixed params (host frameworks hand us
      // already-decoded query values).
      const claims: Record<string, string> = {};
      for (const [paramKey, paramValue] of Object.entries(params)) {
        if (paramKey.startsWith('c.')) {
          claims[paramKey.slice(2)] = paramValue;
        }
      }

      const canonical = canonicalString(
        input.id,
        input.variant,
        Number.parseInt(e, 10),
        kid,
        Number.parseInt(v, 10),
        sortClaims(claims),
      );
      const expected = hmac(key, canonical);

      let provided: Buffer;
      try {
        provided = Buffer.from(sig, 'base64url');
      } catch {
        return { ok: false, reason: 'malformed' };
      }
      // timingSafeEqual throws on length mismatch — a mismatched length is
      // just a bad signature, never an exception surface.
      if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
        return { ok: false, reason: 'bad_signature' };
      }

      // Signature is authentic — NOW interpret the signed fields.
      const now = input.now ?? Math.floor(Date.now() / 1000);
      if (Number.parseInt(e, 10) < now) {
        return { ok: false, reason: 'expired' };
      }
      if (input.expectedTokenVersion !== undefined && Number.parseInt(v, 10) !== input.expectedTokenVersion) {
        return { ok: false, reason: 'version_mismatch' };
      }

      return { ok: true };
    },
  };
}
