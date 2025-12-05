/**
 * Schema Factory Tests
 */

import { describe, it, expect } from 'vitest';
import mongoose from 'mongoose';
import { createMediaSchema, DEFAULT_BASE_FOLDERS } from '../src/schema/media.schema';

describe('Media Schema Factory', () => {
  describe('createMediaSchema', () => {
    it('should create schema with default options', () => {
      const schema = createMediaSchema();

      expect(schema).toBeInstanceOf(mongoose.Schema);
      expect(schema.path('filename')).toBeDefined();
      expect(schema.path('url')).toBeDefined();
      expect(schema.path('folder')).toBeDefined();
      expect(schema.path('baseFolder')).toBeDefined();
    });

    it('should use custom base folders', () => {
      const baseFolders = ['products', 'users'];
      const schema = createMediaSchema({ baseFolders });

      const baseFolderPath = schema.path('baseFolder');
      expect(baseFolderPath).toBeDefined();
      // Check enum values
      expect((baseFolderPath as any).enumValues).toEqual(baseFolders);
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

      // Check for expected indexes
      expect(indexes.some(i => i[0].baseFolder)).toBe(true);
      expect(indexes.some(i => i[0].folder)).toBe(true);
      expect(indexes.some(i => i[0].createdAt)).toBe(true);
    });

    it('should add multi-tenancy indexes', () => {
      const schema = createMediaSchema({
        multiTenancy: { enabled: true, field: 'organizationId' },
      });
      const indexes = schema.indexes();

      // Should have compound indexes with organizationId
      expect(indexes.some(i => i[0].organizationId)).toBe(true);
    });

    it('should add custom indexes', () => {
      const schema = createMediaSchema({
        indexes: [{ customField: 1 }, { title: 'text' }],
      });
      const indexes = schema.indexes();

      expect(indexes.some(i => i[0].customField)).toBe(true);
      expect(indexes.some(i => i[0].title === 'text')).toBe(true);
    });
  });

  describe('DEFAULT_BASE_FOLDERS', () => {
    it('should have default folders', () => {
      expect(DEFAULT_BASE_FOLDERS).toContain('general');
      expect(DEFAULT_BASE_FOLDERS).toContain('images');
      expect(DEFAULT_BASE_FOLDERS).toContain('documents');
    });
  });
});
