/**
 * Media Schema Factory — v3
 *
 * Creates a configurable Mongoose schema for media documents. Tenant field
 * type (string vs ObjectId) is injected via `injectTenantField()` from a
 * resolved `TenantConfig` (PACKAGE_RULES P11). Supports status lifecycle,
 * focal points, tags, soft deletes, and multi-tenancy.
 */

import type mongoose from 'mongoose';
import { Schema } from 'mongoose';
import type { ResolvedTenantConfig } from '@classytic/repo-core/tenant';
import type { IMediaDocument } from '../types.js';
import { injectTenantField } from './inject-tenant.js';

export interface MediaSchemaConfig {
  /** Resolved tenant config — from `resolveMediaTenant()`. */
  tenant?: ResolvedTenantConfig;
  softDelete?: {
    enabled: boolean;
    /** Purge window in days — `purgeDeleted()`'s default cutoff; also feeds the TTL index when `ttlIndex: true`. */
    ttlDays?: number;
    /**
     * Create a MongoDB TTL index on `deletedAt` (default: false).
     *
     * WARNING: Mongo's TTL sweeper deletes the DOCUMENT with no hooks — the
     * storage blob is NOT deleted and is orphaned forever. Only enable when a
     * bucket lifecycle rule (or acceptable orphaning) covers the blobs. The
     * supported cleanup path is a `purgeDeleted()` cron (storage + DB).
     */
    ttlIndex?: boolean | undefined;
  };
  extraFields?: Record<string, mongoose.SchemaDefinitionProperty>;
  extraIndexes?: Array<Record<string, 1 | -1 | 'text'>>;
  collection?: string;
  optimizedIndexes?: boolean;
}

export function buildMediaSchema(config: MediaSchemaConfig = {}): Schema<IMediaDocument> {
  const {
    tenant,
    softDelete = { enabled: false },
    extraFields = {},
    extraIndexes = [],
    collection = 'media',
    optimizedIndexes = false,
  } = config;

  const schemaDefinition: mongoose.SchemaDefinition = {
    // --- Identity (Directus triple-name pattern) ---
    filename: { type: String, required: true, index: true },
    originalFilename: { type: String, required: true },
    title: { type: String, required: true, default: '' },

    // --- Storage ---
    mimeType: { type: String, required: true, index: true },
    size: { type: Number, required: true },
    url: { type: String, required: true },
    key: { type: String, required: true, index: true },
    hash: { type: String, required: true, index: true },

    // --- Status Lifecycle ---
    status: {
      type: String,
      enum: ['pending', 'processing', 'ready', 'error'],
      default: 'pending',
      required: true,
      index: true,
    },
    errorMessage: { type: String },

    // --- Access control ---
    // 'public' (default) serves exactly as pre-3.4.0. 'private' makes the
    // AssetTransformService demand a valid HMAC signature or an authorize()
    // approval before sending bytes. Docs created before 3.4.0 lack the
    // field — reads treat absent as public.
    visibility: {
      type: String,
      enum: ['public', 'private'],
      default: 'public',
      required: true,
      index: true,
    },
    // Signed-URL revocation counter. revokeAccess() $inc's it; every
    // outstanding signed URL (which embeds the version it was minted with)
    // stops verifying immediately.
    tokenVersion: { type: Number, default: 0, required: true },

    // --- Organization ---
    folder: { type: String, default: 'general', required: true, index: true },
    tags: { type: [String], default: [], index: true },
    alt: String,
    description: String,

    // --- Image Metadata ---
    width: Number,
    height: Number,
    aspectRatio: Number,
    focalPoint: {
      x: { type: Number, min: 0, max: 1 },
      y: { type: Number, min: 0, max: 1 },
    },

    // --- Variants (Payload pattern) ---
    variants: [
      {
        name: { type: String, required: true },
        key: { type: String, required: true },
        url: { type: String, required: true },
        filename: { type: String, required: true },
        mimeType: { type: String, required: true },
        size: { type: Number, required: true },
        width: Number,
        height: Number,
      },
    ],

    // --- Video/Audio ---
    duration: Number,

    // --- Placeholders ---
    thumbhash: String,
    dominantColor: String,

    // --- Video Metadata ---
    videoMetadata: { type: Schema.Types.Mixed },

    // --- Extensible ---
    metadata: { type: Schema.Types.Mixed, default: {} },
    exif: { type: Schema.Types.Mixed },

    // --- Soft Delete ---
    deletedAt: { type: Date, default: null, index: true },

    // --- Storage Provider ---
    // Name of the StorageDriver that holds this file. Used to route storage
    // operations (delete, read, stat) in multi-provider setups. Absent on
    // docs created before multi-provider was introduced — those fall back to
    // the engine's defaultProvider at query time.
    provider: { type: String, index: true },

    // Provider-specific write metadata (fileId, etag, dimensions, etc.).
    // Stored as-is; not normalized across providers.
    providerMetadata: { type: Schema.Types.Mixed },

    // --- Temporal lifecycle ---
    // NOT a MongoDB TTL index — purgeExpired() is code-driven so storage
    // files are cleaned up before the doc is removed. A plain index here
    // enables fast range queries for the purge batch and getExpiringSoon().
    expiresAt: { type: Date, default: null, index: true },

    // --- Polymorphic Source Reference (PACKAGE_RULES §7) ---
    sourceId: { type: String, index: true },
    sourceModel: { type: String, index: true },

    // --- Audit ---
    uploadedBy: { type: Schema.Types.ObjectId, ref: 'User', index: true },

    // --- Additional fields from config ---
    ...extraFields,
  };

  const schema = new Schema<IMediaDocument>(schemaDefinition, {
    timestamps: true,
    collection,
  });

  // --- Indexes ---
  schema.index({ status: 1, createdAt: -1 });
  schema.index({ folder: 1, createdAt: -1 });
  schema.index({ createdAt: -1, _id: -1 });
  schema.index(
    { title: 'text', tags: 'text', description: 'text', originalFilename: 'text' },
    { name: 'media_text_search' },
  );

  // Note: tenant-scoped compound indexes for folder / status queries are
  // formed automatically by injectTenantField() below — it prepends the
  // tenant field onto the `{folder:1, createdAt:-1}` and
  // `{status:1, createdAt:-1}` indexes declared above.

  // Optimized compound indexes for soft-delete-aware queries. When tenant
  // scoping is enabled, injectTenantField() prepends the tenant key to each
  // of these at the bottom of the function, producing tenant-scoped
  // deletedAt indexes automatically.
  if (optimizedIndexes) {
    schema.index({ deletedAt: 1, createdAt: -1, _id: -1 });
    schema.index({ deletedAt: 1, folder: 1, createdAt: -1 });
    schema.index({ deletedAt: 1, status: 1, createdAt: -1 });
  }

  // Soft delete TTL index — OPT-IN (`ttlIndex: true`). Mongo's TTL sweeper
  // removes documents with no hooks, so the storage blob would be orphaned;
  // the default cleanup path is a purgeDeleted() cron (storage + DB).
  if (softDelete.enabled && softDelete.ttlIndex === true && softDelete.ttlDays && softDelete.ttlDays > 0) {
    schema.index(
      { deletedAt: 1 },
      {
        // Explicit name: the path-level `deletedAt: { index: true }` above
        // auto-names its index `deletedAt_1`; an unnamed TTL index on the
        // same key would collide with it (IndexOptionsConflict) and never
        // build. The distinct name + partial filter let both coexist.
        name: 'media_deletedAt_ttl',
        expireAfterSeconds: softDelete.ttlDays * 86400,
        partialFilterExpression: { deletedAt: { $type: 'date' } },
      },
    );
  }

  // Custom indexes
  for (const indexSpec of extraIndexes) {
    schema.index(indexSpec);
  }

  // Inject tenant field + prepend tenant key to compound indexes (P11).
  if (tenant) {
    injectTenantField(schema, tenant);
  }

  return schema;
}
