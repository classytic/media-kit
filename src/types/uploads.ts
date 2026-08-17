/** Upload, presign, folder, and bulk-operation contracts. */

import type { Types } from 'mongoose';
import type { FocalPoint, QualityMap } from './processing.js';
import type { MediaVisibility } from './media.js';
import type { HashStrategy } from './storage.js';
import type { ClientVariantInput } from '../operations/derivatives.js';

// ============================================
// OPERATION TYPES
// ============================================

/**
 * Context for operations (user, organization, etc.)
 */
export interface OperationContext {
  /** Current user ID */
  userId?: Types.ObjectId | string;
  /** Organization ID for multi-tenancy */
  organizationId?: Types.ObjectId | string;
  /** Include soft-deleted files in queries */
  includeTrashed?: boolean;
  /** Additional context data */
  [key: string]: unknown;
}

/**
 * Upload input for single file
 */
export interface UploadInput {
  /** File buffer */
  buffer: Buffer;
  /** Original filename */
  filename: string;
  /** MIME type */
  mimeType: string;
  /** Target folder */
  folder?: string;
  /** Alt text */
  alt?: string;
  /** Title (defaults to humanized filename) */
  title?: string;
  /** Description */
  description?: string;
  /** Tags */
  tags?: string[];
  /** Focal point for smart cropping */
  focalPoint?: FocalPoint;
  /** Content type hint for processing (e.g., 'product', 'avatar') */
  contentType?: string;
  /** Polymorphic source reference — entity this media belongs to */
  sourceId?: string;
  /** Polymorphic source model name */
  sourceModel?: string;
  /** Skip processing */
  skipProcessing?: boolean;
  /** Override processing quality for this upload (1-100 or per-format map) */
  quality?: number | QualityMap;
  /** Override output format for this upload */
  format?: 'webp' | 'jpeg' | 'png' | 'avif' | 'original';
  /** Override max width for this upload */
  maxWidth?: number;
  /** Override max height for this upload */
  maxHeight?: number;
  /** Provider name to use for this upload. Defaults to engine's defaultProvider. */
  provider?: string;
  /** Expiry timestamp. When set, the asset will be eligible for purgeExpired() cleanup. */
  expiresAt?: Date;
  /**
   * Access visibility for this upload. Overrides the engine's
   * `visibility.byFolder` / `visibility.default` policy. Default: 'public'.
   */
  visibility?: MediaVisibility;

  // --- Client-computed display hints (see ConfirmUploadInput for the full contract) ---

  /**
   * Client-computed image width in pixels — a DISPLAY HINT from client-side
   * processing (e.g. `@classytic/media-transform`). Honored ONLY when server
   * processing is skipped/disabled; when `processImage` runs, its computed
   * values overwrite these. Worst case a lying client wrongs its own
   * tenant's placeholder rendering.
   */
  width?: number | undefined;
  /** Client-computed image height in pixels. Same contract as `width`. */
  height?: number | undefined;
  /** Client-computed ThumbHash placeholder (base64). Same contract as `width`. */
  thumbhash?: string | undefined;
  /** Client-computed dominant color hex (e.g. '#aabbcc'). Same contract as `width`. */
  dominantColor?: string | undefined;
}

/**
 * Input for confirming a presigned upload
 */
export interface ConfirmUploadInput {
  /** Storage key from the presigned upload */
  key: string;
  /** Name to STORE under — its extension should match the uploaded bytes. */
  filename: string;
  /**
   * What the user actually picked, when it differs from `filename`.
   *
   * A client that re-encodes changes the extension (`photo.jpg` → `photo.webp`)
   * so the stored key matches its content type. Provenance is a different fact
   * and is kept separately; absent, it falls back to `filename`.
   */
  originalFilename?: string | undefined;
  /** MIME type */
  mimeType: string;
  /** File size in bytes */
  size: number;
  /** Target folder */
  folder?: string;
  /** Alt text */
  alt?: string;
  /** Title */
  title?: string;
  /**
   * @deprecated Ignored since 3.4.0 — the stored URL is always derived from
   * the storage driver. When provided it is only validated (absolute http(s),
   * origin must match the storage origin) and rejected with a 400 otherwise.
   */
  url?: string;
  /** Hash strategy: 'skip' (placeholder, default), 'etag' (use storage ETag), 'sha256' (stream file — expensive). Only use 'sha256' with deduplication enabled. */
  hashStrategy?: HashStrategy;
  /** ETag from storage (avoids stat() call if client provides it) */
  etag?: string;
  /** Run post-upload processing (ThumbHash, dominant color, variants). Default: false */
  process?: boolean;
  /** Expiry timestamp for the confirmed asset. Eligible for purgeExpired() cleanup. */
  expiresAt?: Date;
  /**
   * Access visibility for the confirmed asset. Overrides the engine's
   * `visibility.byFolder` / `visibility.default` policy. Default: 'public'.
   * Note: presigned PUTs write with the provider-level ACL — for strictly
   * private objects use a private bucket (recommended for private serving).
   */
  visibility?: MediaVisibility;

  // --- Client-computed display hints ---

  /**
   * Client-computed image width in pixels.
   *
   * These four fields are DISPLAY HINTS computed by client-side processing
   * (e.g. `@classytic/media-transform`, which compresses in the browser
   * before the presigned PUT). They are accepted because the server SKIPS
   * processing in that flow — without them the record would have no
   * dimensions/placeholder at all. Trust model: worst case a lying client
   * wrongs its own tenant's placeholder rendering; nothing security-relevant
   * reads them. When `process: true` runs, server-computed values OVERWRITE
   * these. `aspectRatio` is derived server-side when both `width` and
   * `height` are present.
   */
  width?: number | undefined;
  /** Client-computed image height in pixels. See `width` for the contract. */
  height?: number | undefined;
  /** Client-computed ThumbHash placeholder (base64, ~36 chars). See `width` for the contract. */
  thumbhash?: string | undefined;
  /** Client-computed dominant color hex (e.g. '#aabbcc'). See `width` for the contract. */
  dominantColor?: string | undefined;

  /**
   * Content hash of the uploaded bytes, computed on the device — the SAME value
   * `start-write` deduplicates against.
   *
   * Stored as the record's `hash` when no explicit `hashStrategy` was requested,
   * so the value written matches the value searched. Without it the record kept
   * a `key:size` placeholder while dedup queried by real SHA-256, and identical
   * re-uploads never matched.
   */
  sha256?: string | undefined;

  /**
   * Size variants the CLIENT produced and uploaded to keys this server signed
   * (`signDerivativeUploads`).
   *
   * Trust model is DIFFERENT from the display hints above, and deliberately
   * stricter. A hint is cosmetic — a lying client wrongs its own placeholder.
   * A variant carries a storage KEY, which is a pointer: accepting an arbitrary
   * one would bind another tenant's object into this record. So every key is
   * re-derived server-side and must match what was signed, and the stored `url`
   * comes from the driver rather than from this payload.
   *
   * Empty/absent means no client derivatives — the record simply has no
   * variants, which readers must already handle (a variant lookup falls back to
   * the primary).
   */
  variants?: readonly ClientVariantInput[] | undefined;
}
