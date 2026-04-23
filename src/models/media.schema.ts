/**
 * Media Schema Factory — v3
 *
 * Creates a configurable Mongoose schema for media documents. Tenant field
 * type (string vs ObjectId) is injected via `injectTenantField()` from a
 * resolved `TenantConfig` (PACKAGE_RULES P11). Supports status lifecycle,
 * focal points, tags, soft deletes, and multi-tenancy.
 */

import mongoose, { Schema } from 'mongoose';
import type { ResolvedTenantConfig } from '@classytic/primitives/tenant';
import type { IMediaDocument } from '../types.js';
import { injectTenantField } from './inject-tenant.js';

export interface MediaSchemaConfig {
  /** Resolved tenant config — from `resolveMediaTenant()`. */
  tenant?: ResolvedTenantConfig;
  softDelete?: {
    enabled: boolean;
    ttlDays?: number;
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

  // Soft delete TTL index
  if (softDelete.enabled && softDelete.ttlDays && softDelete.ttlDays > 0) {
    schema.index({ deletedAt: 1 }, {
      expireAfterSeconds: softDelete.ttlDays * 86400,
      partialFilterExpression: { deletedAt: { $type: 'date' } },
    });
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
