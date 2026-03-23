/**
 * Media Schema Factory
 *
 * Creates a configurable Mongoose schema for media documents.
 * Supports status lifecycle, focal points, tags, soft deletes, and multi-tenancy.
 *
 * @example
 * ```ts
 * import { createMediaSchema } from '@classytic/media-kit';
 * const MediaSchema = createMediaSchema();
 * const Media = mongoose.model('Media', MediaSchema);
 *
 * // With multi-tenancy
 * const MediaSchema = createMediaSchema({
 *   multiTenancy: { enabled: true, field: 'organizationId' }
 * });
 * ```
 */

import mongoose, { Schema } from 'mongoose';
import type { IMediaDocument, MultiTenancyConfig } from '../types';

/**
 * Schema configuration options
 */
export interface MediaSchemaOptions {
  /** Multi-tenancy configuration */
  multiTenancy?: MultiTenancyConfig;
  /** Additional schema fields */
  additionalFields?: Record<string, mongoose.SchemaDefinitionProperty>;
  /** Custom indexes */
  indexes?: Array<Record<string, 1 | -1 | 'text'>>;
  /** Collection name override */
  collection?: string;
  /**
   * Enable performance-optimized compound indexes.
   * Adds indexes that cover soft-delete-aware pagination queries:
   *   - `{ deletedAt: 1, createdAt: -1, _id: -1 }` — keyset pagination with soft-delete
   *   - `{ deletedAt: 1, folder: 1, createdAt: -1 }` — folder browse with soft-delete
   *   - `{ deletedAt: 1, status: 1, createdAt: -1 }` — status filter with soft-delete
   *
   * Default: false. Enable when using soft-delete with large collections.
   */
  optimizedIndexes?: boolean;
}

/**
 * Create media schema with given options
 */
export function createMediaSchema(options: MediaSchemaOptions = {}): Schema<IMediaDocument> {
  const {
    multiTenancy = { enabled: false },
    additionalFields = {},
    indexes = [],
    collection = 'media',
    optimizedIndexes = false,
  } = options;

  const schemaDefinition: mongoose.SchemaDefinition = {
    // --- Identity (Directus triple-name pattern) ---
    filename: {
      type: String,
      required: true,
      index: true,
    },
    originalFilename: {
      type: String,
      required: true,
    },
    title: {
      type: String,
      required: true,
      default: '',
    },

    // --- Storage ---
    mimeType: {
      type: String,
      required: true,
      index: true,
    },
    size: {
      type: Number,
      required: true,
    },
    url: {
      type: String,
      required: true,
    },
    key: {
      type: String,
      required: true,
      index: true,
    },
    hash: {
      type: String,
      required: true,
      index: true,
    },

    // --- Status Lifecycle ---
    status: {
      type: String,
      enum: ['pending', 'processing', 'ready', 'error'],
      default: 'pending',
      required: true,
      index: true,
    },
    errorMessage: {
      type: String,
    },

    // --- Organization ---
    folder: {
      type: String,
      default: 'general',
      required: true,
      index: true,
    },
    tags: {
      type: [String],
      default: [],
      index: true,
    },
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

    // --- Variants (Payload pattern — independent metadata per variant) ---
    variants: [{
      name: { type: String, required: true },
      key: { type: String, required: true },
      url: { type: String, required: true },
      filename: { type: String, required: true },
      mimeType: { type: String, required: true },
      size: { type: Number, required: true },
      width: Number,
      height: Number,
    }],

    // --- Video/Audio ---
    duration: Number,

    // --- Placeholders ---
    thumbhash: String,
    dominantColor: String,

    // --- Video Metadata ---
    videoMetadata: {
      type: Schema.Types.Mixed,
    },

    // --- Extensible ---
    metadata: {
      type: Schema.Types.Mixed,
      default: {},
    },
    exif: {
      type: Schema.Types.Mixed,
    },

    // --- Soft Delete ---
    deletedAt: {
      type: Date,
      default: null,
      index: true,
    },

    // --- Audit ---
    uploadedBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      index: true,
    },

    // Additional fields
    ...additionalFields,
  };

  // Add multi-tenancy field
  if (multiTenancy.enabled) {
    const fieldName = multiTenancy.field || 'organizationId';
    schemaDefinition[fieldName] = {
      type: Schema.Types.ObjectId,
      ref: 'Organization',
      required: multiTenancy.required ?? false,
      index: true,
    };
  }

  // Create schema
  const schema = new Schema<IMediaDocument>(schemaDefinition, {
    timestamps: true,
    collection,
  });

  // --- Indexes ---

  // Status + time (filter by lifecycle state)
  schema.index({ status: 1, createdAt: -1 });

  // Folder + time (browse by folder)
  schema.index({ folder: 1, createdAt: -1 });

  // Cursor pagination
  schema.index({ createdAt: -1, _id: -1 });

  // Full-text search (title, tags, description, originalFilename)
  schema.index(
    { title: 'text', tags: 'text', description: 'text', originalFilename: 'text' },
    { name: 'media_text_search' }
  );

  // Multi-tenancy compound indexes
  if (multiTenancy.enabled) {
    const field = multiTenancy.field || 'organizationId';
    schema.index({ [field]: 1, folder: 1, createdAt: -1 });
    schema.index({ [field]: 1, status: 1, createdAt: -1 });
  }

  // Optimized compound indexes for soft-delete-aware queries
  if (optimizedIndexes) {
    schema.index({ deletedAt: 1, createdAt: -1, _id: -1 }); // keyset pagination
    schema.index({ deletedAt: 1, folder: 1, createdAt: -1 }); // folder browse
    schema.index({ deletedAt: 1, status: 1, createdAt: -1 }); // status filter

    if (multiTenancy.enabled) {
      const field = multiTenancy.field || 'organizationId';
      schema.index({ deletedAt: 1, [field]: 1, createdAt: -1, _id: -1 });
    }
  }

  // Custom indexes
  for (const indexSpec of indexes) {
    schema.index(indexSpec);
  }

  return schema;
}

/**
 * Pre-built schema with common defaults
 */
export const MediaSchema: Schema<IMediaDocument> = createMediaSchema();

export default createMediaSchema;
