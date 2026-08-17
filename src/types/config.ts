/** Engine configuration contracts. */

import type { StorageDriver } from './storage.js';
import type { MediaCacheConfig, ProcessingConfig } from './processing.js';
import type { IMediaDocument, MediaVisibility } from './media.js';
import type { TransformRequest } from './transforms.js';

// ============================================
// CONFIGURATION TYPES
// ============================================

/**
 * Allowed file types configuration
 */
export interface FileTypesConfig {
  /** Allowed MIME types */
  allowed: string[];
  /** Max file size in bytes */
  maxSize?: number;
  /**
   * Strict-profile content verification (default: false). When enabled,
   * `validateFile()` sniffs the buffer's magic bytes and REJECTS a dangerous
   * declared/detected mismatch — e.g. a file declared `image/png` whose bytes
   * are actually HTML or SVG (a stored-XSS vector). Off by default because it
   * requires the real bytes in hand (server-side upload / URL import); the
   * declared-MIME check always runs regardless.
   */
  verifyContent?: boolean;
}

/**
 * Folder configuration
 */
export interface FolderConfig {
  /** Default folder if not specified */
  defaultFolder?: string;
  /**
   * Storage-key root prefix prepended to EVERY generated key (originals,
   * variants, thumbnails), e.g. `'eternal'` → `eternal/products/<file>`.
   *
   * This namespaces one deployment's objects inside a bucket SHARED by
   * several companies — without touching the `folder` METADATA (content-type
   * mapping + folder browser stay keyed on the bare folder, e.g. `products`).
   *
   * Forward-only + non-breaking: keys/URLs are minted once at upload and
   * stored on the doc, then read/deleted verbatim — so setting or changing
   * this NEVER affects objects already uploaded (their stored keys win). Do
   * NOT apply a prefix inside the storage driver instead: that would
   * double-prefix or orphan existing keys on delete/copy.
   *
   * Omit / empty string → no prefix (default; back-compatible).
   */
  keyPrefix?: string;
  /** Content type mappings (folder pattern → content type) */
  contentTypeMap?: Record<string, string[]>;
  /** Enable unlimited subfolder nesting (default: true) */
  enableSubfolders?: boolean;
  /**
   * Rewrite storage keys when moving/renaming folders (default: true).
   * When true, move() and renameFolder() physically copy files to new
   * storage keys matching the target folder, then delete the originals.
   * When false, only the DB folder field is updated (metadata-only).
   */
  rewriteKeys?: boolean;
}

/**
 * Deduplication configuration
 */
export interface DeduplicationConfig {
  /**
   * Enable BEST-EFFORT deduplication by content hash (default: false).
   *
   * IMPORTANT — this is a best-effort LOOKUP, not a uniqueness guarantee. It
   * does a check-then-create (`getByHash` then `createMedia`) with no unique
   * index behind it, so two concurrent uploads of identical bytes can BOTH
   * create a record (the second's `getByHash` runs before the first commits).
   * It reliably collapses SEQUENTIAL re-uploads; it does not fence a race. For
   * a hard guarantee, add a unique partial index on your identity tuple (e.g.
   * `{ organizationId, hash }`) and let the duplicate-key error pick the winner.
   * Identity here is `(tenant, hash)` only — visibility, folder, provider, and
   * processing profile are NOT part of it, so a hit may return an existing
   * asset with different visibility/folder.
   */
  enabled: boolean;
  /** Return existing file instead of uploading duplicate (default: true) */
  returnExisting?: boolean;
  /** Hash algorithm: 'md5' (fast) or 'sha256' (secure, default) */
  algorithm?: 'md5' | 'sha256';
}

/**
 * Soft delete configuration
 */
export interface SoftDeleteConfig {
  /** Enable soft deletes (default: false) */
  enabled: boolean;
  /**
   * Purge window in days (default: 30). Used as the default cutoff for
   * `purgeDeleted()` — soft-deleted docs older than this are eligible for
   * purge. Set 0 to disable the default cutoff. Also feeds the optional
   * MongoDB TTL index when `ttlIndex: true`.
   */
  ttlDays?: number;
  /**
   * Create a MongoDB TTL index on `deletedAt` so Mongo itself removes
   * soft-deleted DOCUMENTS after `ttlDays` (default: false).
   *
   * WARNING: Mongo's TTL sweeper deletes the document only, with NO hooks —
   * the storage object (S3/GCS/local file) and its variants are NOT deleted
   * and are orphaned forever. Only enable this when a bucket lifecycle rule
   * (or acceptable orphaning) covers the blobs. The supported cleanup path
   * is a `purgeDeleted()` cron, which removes storage + DB together.
   */
  ttlIndex?: boolean | undefined;
}

/**
 * Concurrency control configuration
 */
export interface ConcurrencyConfig {
  /** Maximum number of concurrent upload operations (default: 5) */
  maxConcurrent?: number;
  /**
   * Admission control: max callers allowed to WAIT for a slot. Beyond this the
   * upload rejects with a 503 `media.overloaded` error instead of queueing
   * unboundedly (each queued upload retains its buffer — an OOM vector under
   * overload). Default: unbounded (backward-compatible).
   */
  maxQueue?: number;
  /**
   * Admission control: max ms a caller waits for a slot before the acquire
   * rejects with a 503 `media.acquire_timeout`. Default: wait forever.
   */
  acquireTimeoutMs?: number;
}

/**
 * Import options for importing files from URL
 */
export interface ImportOptions {
  /** Target folder */
  folder?: string;
  /** Override filename (defaults to URL filename) */
  filename?: string;
  /** Alt text */
  alt?: string;
  /** Title */
  title?: string;
  /** Tags */
  tags?: string[];
  /** Maximum file size in bytes (default: from fileTypes config) */
  maxSize?: number;
  /** Request timeout in milliseconds (default: 30000) */
  timeout?: number;
  /** Provider name to use for this import. Defaults to engine's defaultProvider. */
  provider?: string;
}

/**
 * Policy for EXTERNAL (reference-only) media records — see
 * `MediaRepository.registerExternal()`.
 */
export interface ExternalMediaConfig {
  /**
   * Origin allowlist for registered external URLs. When set (non-empty),
   * `registerExternal()` rejects any URL whose origin isn't listed with a
   * 403 (`code: 'media.external.origin_not_allowed'`). Entries are
   * normalized via `new URL(entry).origin`, so `'https://cdn.example.com'`
   * and `'https://cdn.example.com/'` are equivalent. Unset/empty = any
   * http(s) origin.
   */
  allowedOrigins?: string[] | undefined;
}

/**
 * Input for `MediaRepository.registerExternal()` — register media hosted on
 * a third party (Cloudflare Images, an existing CDN asset, a partner's
 * hosted image) as a first-class media record WITHOUT media-kit owning the
 * bytes. The URL is never fetched — this is a reference registry, not an
 * importer (use `importFromUrl()` to re-host).
 */
export interface RegisterExternalInput {
  /** Absolute http(s) URL of the externally-hosted asset. REQUIRED. */
  url: string;
  /** Display filename. Default: last path segment of the URL, or `external-<hash>`. */
  filename?: string | undefined;
  /** MIME type, if known. Default: 'application/octet-stream'. */
  mimeType?: string | undefined;
  /** Size in bytes, if known. Default: 0 (unknown — never verified). */
  size?: number | undefined;
  /** Target folder (same normalization/visibility rules as uploads). */
  folder?: string | undefined;
  /** Access visibility — same precedence as uploads (explicit > byFolder > default). */
  visibility?: MediaVisibility | undefined;
  /** Searchable tags. */
  tags?: string[] | undefined;
  /** Alt text. */
  alt?: string | undefined;
  /** Display title (defaults to humanized filename). */
  title?: string | undefined;
  /** Custom metadata bag (stored as-is on `metadata`). */
  metadata?: Record<string, unknown> | undefined;
  /**
   * Freeform label of where the asset actually lives (e.g.
   * 'cloudflare-images'). Default 'external'. Stored on
   * `providerMetadata.sourceProvider` — the record's `provider` field is
   * ALWAYS the `'external'` sentinel.
   */
  sourceProvider?: string | undefined;

  // --- Client-computed display hints (same trust contract as ConfirmUploadInput) ---

  /** Known image width in pixels — display hint, never verified. */
  width?: number | undefined;
  /** Known image height in pixels. See `width`. */
  height?: number | undefined;
  /** ThumbHash placeholder (base64). See `width`. */
  thumbhash?: string | undefined;
  /** Dominant color hex (e.g. '#aabbcc'). See `width`. */
  dominantColor?: string | undefined;
}

/**
 * Default-visibility policy for new uploads.
 *
 * Precedence at upload time (first match wins):
 *   1. explicit per-upload `visibility` option
 *   2. `byFolder` rule — longest matching folder prefix (a rule for
 *      `'invoices'` also covers `'invoices/2026'`)
 *   3. `default`
 *   4. `'public'`
 */
export interface VisibilityConfig {
  /** Fallback visibility when no folder rule matches (default: 'public'). */
  default?: MediaVisibility | undefined;
  /** Folder-path → visibility rules. Longest prefix (by path segment) wins. */
  byFolder?: Record<string, MediaVisibility> | undefined;
}

/**
 * HMAC URL-signing configuration for private media serving.
 *
 * Constructing the engine with this config creates ONE `UrlSigner`
 * (see `@classytic/media-kit/signing`) shared by the repository
 * (`getSignedAssetUrl()`) and the transform service (verification).
 *
 * Why not storage-native presigning? S3/GCS presigned GETs cap at 7 days and
 * only exist on S3/GCS. The HMAC proxy works on every driver and supports
 * arbitrary TTLs — required for URLs handed to LLM providers, which re-fetch
 * them anonymously on every chat-history replay.
 */
export interface MediaSigningConfig {
  /** Keyring: kid → secret. Keep N-1 old keys during rotation. */
  keys?: Record<string, string> | undefined;
  /** Single-secret convenience (kid `k1`). Mutually exclusive with `keys`. */
  secret?: string | undefined;
  /** Kid used for new signatures. Required with a multi-key ring. */
  currentKid?: string | undefined;
  /** Default TTL in seconds for minted URLs (default: 3600). */
  defaultTtl?: number | undefined;
  /**
   * Path (or absolute URL) of the host route that fronts
   * `AssetTransformService.handle()` — e.g. `'/media/content'`.
   * `getSignedAssetUrl()` mints `${servePath}/${id}[/variant]?<signed query>`.
   */
  servePath: string;
}

/**
 * Host authorization callback for serving PRIVATE media without a signature
 * (session-based access — e.g. a tenant admin browsing their own library).
 *
 * This is the bridge point for entitlement engines: a host using
 * `@classytic/access` implements this callback with `access.check(...)` —
 * media-kit never imports that package.
 *
 * Contract: return `true` to allow. Returning `false`, or THROWING, denies
 * with 403 (fail-closed — an erroring authorizer must never leak bytes).
 */
export type ServeAuthorize = (request: TransformRequest, media: IMediaDocument) => boolean | Promise<boolean>;

/**
 * Main media-kit configuration
 */
export interface MediaKitConfig {
  /** Storage driver instance */
  driver: StorageDriver;
  /** File type restrictions */
  fileTypes?: FileTypesConfig;
  /** Folder configuration */
  folders?: FolderConfig;
  /** Image processing config */
  processing?: ProcessingConfig;
  /** File deduplication config */
  deduplication?: DeduplicationConfig;
  /** Soft delete config */
  softDelete?: SoftDeleteConfig;
  /** Concurrency control */
  concurrency?: ConcurrencyConfig;
  /** Cache adapter for read-through caching (Redis, Memcached, in-memory) */
  cache?: MediaCacheConfig;
  /** Logger instance (optional) */
  logger?: MediaKitLogger;
  /** Suppress warnings about missing optional dependencies (default: false) */
  suppressWarnings?: boolean;
  /** Mongokit plugins to apply to the repository */
  plugins?: import('@classytic/mongokit').PluginType[];
  /** Pagination configuration for the repository */
  pagination?: import('@classytic/mongokit').PaginationConfig;
  /** Default-visibility policy for new uploads (folder rules win over default). */
  visibility?: VisibilityConfig;
  /** HMAC URL-signing config — enables `getSignedAssetUrl()` + signed private serving. */
  signing?: MediaSigningConfig;
  /** External (reference-only) media policy — see `registerExternal()`. */
  external?: ExternalMediaConfig | undefined;
}

/**
 * Logger interface (compatible with console, pino, winston, etc.)
 */
export interface MediaKitLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
  debug?(message: string, meta?: Record<string, unknown>): void;
}
