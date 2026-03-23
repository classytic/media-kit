/**
 * Schema Factory Tests
 */

import { describe, it, expect } from 'vitest';
import mongoose from 'mongoose';
import { createMediaSchema } from '../src/schema/media.schema';

describe('Media Schema Factory', () => {
  describe('createMediaSchema', () => {
    it('should create schema with default options', () => {
      const schema = createMediaSchema();

      expect(schema).toBeInstanceOf(mongoose.Schema);
      expect(schema.path('filename')).toBeDefined();
      expect(schema.path('originalFilename')).toBeDefined();
      expect(schema.path('title')).toBeDefined();
      expect(schema.path('url')).toBeDefined();
      expect(schema.path('key')).toBeDefined();
      expect(schema.path('hash')).toBeDefined();
      expect(schema.path('folder')).toBeDefined();
      expect(schema.path('mimeType')).toBeDefined();
      expect(schema.path('size')).toBeDefined();
    });

    it('should have status lifecycle field', () => {
      const schema = createMediaSchema();
      const statusPath = schema.path('status') as any;

      expect(statusPath).toBeDefined();
      expect(statusPath.enumValues).toEqual(['pending', 'processing', 'ready', 'error']);
    });

    it('should have tags field as array of strings', () => {
      const schema = createMediaSchema();
      const tagsPath = schema.path('tags');

      expect(tagsPath).toBeDefined();
    });

    it('should have focalPoint subdocument', () => {
      const schema = createMediaSchema();
      const fpX = schema.path('focalPoint.x') as any;
      const fpY = schema.path('focalPoint.y') as any;

      expect(fpX).toBeDefined();
      expect(fpY).toBeDefined();
      expect(fpX.options.min).toBe(0);
      expect(fpX.options.max).toBe(1);
      expect(fpY.options.min).toBe(0);
      expect(fpY.options.max).toBe(1);
    });

    it('should have soft delete field', () => {
      const schema = createMediaSchema();
      const deletedAt = schema.path('deletedAt');

      expect(deletedAt).toBeDefined();
    });

    it('should have variants with independent metadata per variant', () => {
      const schema = createMediaSchema();
      const variants = schema.path('variants') as any;

      expect(variants).toBeDefined();
      // Variant subdocument schema should have name, key, url, filename, mimeType, size
      const variantSchema = variants.schema;
      expect(variantSchema.path('name')).toBeDefined();
      expect(variantSchema.path('key')).toBeDefined();
      expect(variantSchema.path('url')).toBeDefined();
      expect(variantSchema.path('filename')).toBeDefined();
      expect(variantSchema.path('mimeType')).toBeDefined();
      expect(variantSchema.path('size')).toBeDefined();
      expect(variantSchema.path('width')).toBeDefined();
      expect(variantSchema.path('height')).toBeDefined();
    });

    it('should have image metadata fields', () => {
      const schema = createMediaSchema();

      expect(schema.path('width')).toBeDefined();
      expect(schema.path('height')).toBeDefined();
      expect(schema.path('aspectRatio')).toBeDefined();
      expect(schema.path('duration')).toBeDefined();
    });

    it('should have extensible metadata and exif fields', () => {
      const schema = createMediaSchema();

      expect(schema.path('metadata')).toBeDefined();
      expect(schema.path('exif')).toBeDefined();
    });

    it('should have errorMessage field', () => {
      const schema = createMediaSchema();
      expect(schema.path('errorMessage')).toBeDefined();
    });

    it('should NOT have baseFolder field', () => {
      const schema = createMediaSchema();
      expect(schema.path('baseFolder')).toBeUndefined();
    });

    it('should NOT have caption field (use description instead)', () => {
      const schema = createMediaSchema();
      expect(schema.path('caption')).toBeUndefined();
    });

    it('should add multi-tenancy field', () => {
      const schema = createMediaSchema({
        multiTenancy: { enabled: true, field: 'organizationId', required: true },
      });

      const orgField = schema.path('organizationId');
      expect(orgField).toBeDefined();
      expect((orgField as any).isRequired).toBe(true);
    });

    it('should add custom multi-tenancy field name', () => {
      const schema = createMediaSchema({
        multiTenancy: { enabled: true, field: 'tenantId' },
      });

      expect(schema.path('tenantId')).toBeDefined();
      expect(schema.path('organizationId')).toBeUndefined();
    });

    it('should not add multi-tenancy field when disabled', () => {
      const schema = createMediaSchema({
        multiTenancy: { enabled: false },
      });

      expect(schema.path('organizationId')).toBeUndefined();
    });

    it('should add additional fields', () => {
      const schema = createMediaSchema({
        additionalFields: {
          customField: { type: String },
          priority: { type: Number, default: 0 },
        },
      });

      expect(schema.path('customField')).toBeDefined();
      expect(schema.path('priority')).toBeDefined();
    });

    it('should have default indexes', () => {
      const schema = createMediaSchema();
      const indexes = schema.indexes();

      // Status + createdAt
      expect(indexes.some(i => i[0].status && i[0].createdAt)).toBe(true);
      // Folder + createdAt
      expect(indexes.some(i => i[0].folder && i[0].createdAt)).toBe(true);
      // Hash index
      expect(indexes.some(i => i[0].hash)).toBe(true);
      // DeletedAt index
      expect(indexes.some(i => i[0].deletedAt)).toBe(true);
      // Text search index
      expect(indexes.some(i => i[0].title === 'text')).toBe(true);
    });

    it('should add multi-tenancy compound indexes', () => {
      const schema = createMediaSchema({
        multiTenancy: { enabled: true, field: 'organizationId' },
      });
      const indexes = schema.indexes();

      expect(indexes.some(i => i[0].organizationId)).toBe(true);
    });

    it('should add custom indexes', () => {
      const schema = createMediaSchema({
        indexes: [{ customField: 1 }],
      });
      const indexes = schema.indexes();

      expect(indexes.some(i => i[0].customField)).toBe(true);
    });
  });
});
