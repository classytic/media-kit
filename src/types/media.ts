/** Persisted media domain model. This is the only core type module coupled to Mongoose. */

import type { Document, Model, Types } from 'mongoose';
import type { FocalPoint, GeneratedVariant } from './processing.js';

// ============================================
// MEDIA DOCUMENT TYPES
// ============================================

/**
 * File status lifecycle (Directus/Mux pattern)
 */
export type MediaStatus = 'pending' | 'processing' | 'ready' | 'error' | 'deleting';

/**
 * Access visibility of a media document.
 *
 * - `'public'` — served with long-lived public cache headers, URL is stable
 *   and unauthenticated (default; pre-3.4.0 behavior).
 * - `'private'` — the serve pipeline (AssetTransformService) refuses to send
 *   bytes unless the request carries a valid HMAC signature (`/signing`) or
 *   the host's `authorize` callback approves it.
 *
 * Deliberately named `visibility` (NOT `access`) to avoid concept collision
 * with `@classytic/access`, the org's entitlement engine — which plugs in via
 * the `authorize` callback, never via imports.
 */
export type MediaVisibility = 'public' | 'private';

/**
 * EXIF metadata extracted from images
 */
export interface ExifMetadata {
  make?: string;
  model?: string;
  iso?: number;
  aperture?: number;
  shutterSpeed?: string;
  focalLength?: number;
  dateTimeOriginal?: Date;
  latitude?: number;
  longitude?: number;
  orientation?: number;
}

/**
 * Base media document interface
 *
 * Uses Directus triple-name pattern (filename, originalFilename, title),
 * Payload-style independent variants, and a status lifecycle.
 */
export interface IMedia {
  // --- Identity (Directus triple-name pattern) ---

  /** Sanitized storage filename */
  filename: string;
  /** Original filename as uploaded by user */
  originalFilename: string;
  /** Display title (auto-generated from filename or user-set) */
  title: string;

  // --- Storage ---

  /** Storage key/path */
  key: string;
  /** Public URL */
  url: string;
  /** MIME type */
  mimeType: string;
  /** File size in bytes */
  size: number;
  /** SHA-256 content hash (auto-computed on every upload) */
  hash: string;

  // --- Status Lifecycle ---

  /** File status: pending → processing → ready | error */
  status: MediaStatus;
  /** Error message if status === 'error' */
  errorMessage?: string;

  // --- Access control ---

  /**
   * Access visibility. Default `'public'`. Optional in the type because
   * documents created before 3.4.0 lack the field — absent means public.
   */
  visibility?: MediaVisibility;
  /**
   * Signed-URL revocation counter (default 0). `revokeAccess()` increments it,
   * instantly invalidating every outstanding signed URL minted for this doc
   * (signatures embed the version; verify checks it against this value).
   */
  tokenVersion?: number;

  // --- Organization ---

  /** Full folder path */
  folder: string;
  /** Searchable tags (Directus pattern) */
  tags: string[];
  /** Alt text for images */
  alt?: string;
  /** Description */
  description?: string;

  // --- Image Metadata ---

  /** Image width in pixels */
  width?: number;
  /** Image height in pixels */
  height?: number;
  /** Aspect ratio (width / height, auto-computed) */
  aspectRatio?: number;
  /** Focal point for smart cropping (Payload CMS pattern) */
  focalPoint?: FocalPoint;

  // --- Variants (Payload pattern — independent metadata per variant) ---

  variants: GeneratedVariant[];

  // --- Video/Audio ---

  /** Duration in milliseconds (Directus pattern) */
  duration?: number;

  // --- Placeholders ---

  /** ThumbHash placeholder (base64, ~33 chars) for blur-up loading */
  thumbhash?: string;
  /** Dominant color hex (e.g., '#3b82f6') for placeholder backgrounds */
  dominantColor?: string;

  // --- Video Metadata ---

  /** Video metadata — populated when videoAdapter is provided */
  videoMetadata?: {
    codec?: string;
    fps?: number;
    bitrate?: number;
    audioCodec?: string;
  };

  // --- Extensible ---

  /** Custom metadata */
  metadata: Record<string, unknown>;
  /** EXIF data from images */
  exif?: ExifMetadata;

  // --- Soft Delete ---

  /** Null = active, Date = soft-deleted */
  deletedAt?: Date | null;

  // --- Polymorphic Source Reference (PACKAGE_RULES §7) ---

  /** Source entity ID (opaque — ObjectId hex, UUID, Stripe ID, etc.) */
  sourceId?: string;
  /** Source entity type (e.g. 'Product', 'Order', 'StripeCharge') */
  sourceModel?: string;

  // --- Storage provider ---

  /** Name of the StorageDriver that holds this file. Used to route delete/read/stat
   *  through the correct provider in multi-provider setups. Falls back to the
   *  engine's defaultProvider when absent (backward-compat with existing docs). */
  provider?: string;

  /** Provider-specific metadata returned by the driver's write() call.
   *  e.g. { fileId, filePath } for ImageKit, { id, width, height } for imgbb,
   *  { bucket, etag } for S3. Stored as-is; not normalized. */
  providerMetadata?: Record<string, unknown>;

  // --- Temporal lifecycle ---

  /** Explicit expiry timestamp. When set, the file is a candidate for
   *  programmatic purge via purgeExpired(). NOT a MongoDB TTL — purge is
   *  code-driven so storage files are cleaned up before the doc is removed. */
  expiresAt?: Date | null;

  // --- Audit ---

  /** User who uploaded the file */
  uploadedBy?: Types.ObjectId;
  /** Organization for multi-tenancy */
  organizationId?: Types.ObjectId | string;

  // --- Timestamps ---

  createdAt: Date;
  updatedAt: Date;
}

export interface IMediaDocument extends IMedia, Document {
  _id: Types.ObjectId;
}

export type MediaModel = Model<IMediaDocument>;
