/**
 * Media Schema Factory
 * 
 * Creates a configurable Mongoose schema for media documents.
 * Supports multi-tenancy and custom fields.
 * 
 * @example
 * ```ts
 * // Basic usage
 * import { createMediaSchema } from '@classytic/media-kit';
 * const MediaSchema = createMediaSchema();
 * const Media = mongoose.model('Media', MediaSchema);
 * 
 * // With multi-tenancy
 * const MediaSchema = createMediaSchema({
 *   multiTenancy: { enabled: true, field: 'organizationId' }
 * });
 * 
 * // With custom base folders
 * const MediaSchema = createMediaSchema({
 *   baseFolders: ['products', 'users', 'posts']
 * });
 * ```
 */

import mongoose, { Schema } from 'mongoose';
import type { IMediaDocument, MultiTenancyConfig } from '../types';

/**
 * Schema configuration options
 */
export interface MediaSchemaOptions {
  /** Allowed base folders (first segment of path) */
  baseFolders?: string[];
  /** Multi-tenancy configuration */
  multiTenancy?: MultiTenancyConfig;
  /** Additional schema fields */
  additionalFields?: Record<string, mongoose.SchemaDefinitionProperty>;
  /** Custom indexes */
  indexes?: Array<Record<string, 1 | -1 | 'text'>>;
  /** Collection name override */
  collection?: string;
}

/**
 * Default base folders
 */
export const DEFAULT_BASE_FOLDERS = [
  'general',
  'images',
  'documents',
  'videos',
  'audio',
];

/**
 * Create media schema with given options
 */
export function createMediaSchema(options: MediaSchemaOptions = {}): Schema<IMediaDocument> {
  const {
    baseFolders = DEFAULT_BASE_FOLDERS,
    multiTenancy = { enabled: false },
    additionalFields = {},
    indexes = [],
    collection = 'media',
  } = options;

  // Build schema definition
  const schemaDefinition: mongoose.SchemaDefinition = {
    // File info
    filename: {
      type: String,
      required: true,
      index: true,
    },
    originalName: {
      type: String,
      required: true,
    },
    mimeType: {
      type: String,
      required: true,
      index: true,
    },
    size: {
      type: Number,
      required: true,
    },

    // Storage info
    url: {
      type: String,
      required: true,
    },
    key: {
      type: String,
      required: true,
      index: true,
    },

    // Organization
    baseFolder: {
      type: String,
      enum: baseFolders,
      default: baseFolders[0],
      required: true,
      index: true,
    },
    folder: {
      type: String,
      default: baseFolders[0],
      required: true,
      index: true,
    },

    // Metadata
    alt: String,
    title: String,
    description: String,
    dimensions: {
      width: Number,
      height: Number,
    },

    // Size variants (thumbnail, medium, large, etc.)
    variants: [{
      name: { type: String, required: true },
      url: { type: String, required: true },
      key: { type: String, required: true },
      size: { type: Number, required: true },
      width: Number,
      height: Number,
    }],

    metadata: {
      type: Schema.Types.Mixed,
      default: {},
    },

    // User tracking
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

  // Default indexes for common queries
  schema.index({ baseFolder: 1, createdAt: -1 });
  schema.index({ folder: 1, createdAt: -1 });
  schema.index({ createdAt: -1, _id: -1 }); // For cursor pagination

  // Multi-tenancy compound indexes
  if (multiTenancy.enabled) {
    const field = multiTenancy.field || 'organizationId';
    schema.index({ [field]: 1, folder: 1, createdAt: -1 });
    schema.index({ [field]: 1, baseFolder: 1, createdAt: -1 });
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
export const MediaSchema = createMediaSchema();

export default createMediaSchema;
