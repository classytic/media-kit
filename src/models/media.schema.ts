/**
 * Media Schema Factory — v3
 *
 * Creates a configurable Mongoose schema for media documents.
 * Uses tenantFieldDef() for dynamic tenant field type.
 * Supports status lifecycle, focal points, tags, soft deletes, and multi-tenancy.
 */

import mongoose, { Schema } from 'mongoose';
import type { IMediaDocument } from '../types.js';
import { tenantFieldDef, type TenantFieldConfig } from './tenant-field.js';

export interface MediaSchemaConfig {
  multiTenancy?: {
    enabled: boolean;
    field?: string;
    required?: boolean;
  };
  tenantFieldType?: 'objectId' | 'string';
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
    multiTenancy = { enabled: false },
    tenantFieldType = 'string',
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

  // Dynamic tenant field (PACKAGE_RULES §9.2)
  if (multiTenancy.enabled) {
    const fieldName = multiTenancy.field || 'organizationId';
    const tenantConfig: TenantFieldConfig = {
      tenantFieldType,
      required: multiTenancy.required ?? false,
    };
    schemaDefinition[fieldName] = tenantFieldDef(tenantConfig);
  }

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

  // Multi-tenancy compound indexes
  if (multiTenancy.enabled) {
    const field = multiTenancy.field || 'organizationId';
    schema.index({ [field]: 1, folder: 1, createdAt: -1 });
    schema.index({ [field]: 1, status: 1, createdAt: -1 });
  }

  // Optimized compound indexes for soft-delete-aware queries
  if (optimizedIndexes) {
    schema.index({ deletedAt: 1, createdAt: -1, _id: -1 });
    schema.index({ deletedAt: 1, folder: 1, createdAt: -1 });
    schema.index({ deletedAt: 1, status: 1, createdAt: -1 });
    if (multiTenancy.enabled) {
      const field = multiTenancy.field || 'organizationId';
      schema.index({ deletedAt: 1, [field]: 1, createdAt: -1, _id: -1 });
    }
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

  return schema;
}
