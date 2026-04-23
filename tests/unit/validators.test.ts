/**
 * Unit tests — Zod v4 schemas
 */

import { describe, it, expect } from 'vitest';
import {
  mediaConfigSchema,
  uploadInputSchema,
  confirmUploadSchema,
  initiateMultipartSchema,
  importFromUrlSchema,
} from '../../src/validators/index.js';

describe('Zod schemas', () => {
  describe('mediaConfigSchema', () => {
    it('accepts an empty config and applies defaults', () => {
      const parsed = mediaConfigSchema.parse({});
      expect(parsed.suppressWarnings).toBe(false);
    });

    it('accepts tenant config with fieldType: objectId', () => {
      const parsed = mediaConfigSchema.parse({
        tenant: { fieldType: 'objectId', enabled: true },
      });
      expect(parsed.tenant).toMatchObject({ fieldType: 'objectId', enabled: true });
    });

    it('rejects invalid fieldType on tenant config', () => {
      expect(() =>
        mediaConfigSchema.parse({ tenant: { fieldType: 'wrong' } as any }),
      ).toThrow();
    });

    it('accepts tenant as a boolean shorthand', () => {
      const parsed = mediaConfigSchema.parse({ tenant: true });
      expect(parsed.tenant).toBe(true);
    });

    it('validates nested tenant config', () => {
      const parsed = mediaConfigSchema.parse({
        tenant: { enabled: true, tenantField: 'orgId', required: true },
      });
      expect(parsed.tenant).toMatchObject({
        enabled: true,
        tenantField: 'orgId',
        required: true,
      });
    });

    it('validates softDelete config', () => {
      const parsed = mediaConfigSchema.parse({
        softDelete: { enabled: true, ttlDays: 60 },
      });
      expect(parsed.softDelete?.enabled).toBe(true);
      expect(parsed.softDelete?.ttlDays).toBe(60);
    });

    it('rejects negative ttlDays', () => {
      expect(() =>
        mediaConfigSchema.parse({ softDelete: { enabled: true, ttlDays: -1 } }),
      ).toThrow();
    });
  });

  describe('uploadInputSchema', () => {
    it('accepts minimal upload input', () => {
      const parsed = uploadInputSchema.parse({
        filename: 'photo.jpg',
        mimeType: 'image/jpeg',
      });
      expect(parsed.filename).toBe('photo.jpg');
    });

    it('rejects empty filename', () => {
      expect(() =>
        uploadInputSchema.parse({ filename: '', mimeType: 'image/jpeg' }),
      ).toThrow();
    });

    it('validates focalPoint range 0-1', () => {
      const parsed = uploadInputSchema.parse({
        filename: 'x.jpg',
        mimeType: 'image/jpeg',
        focalPoint: { x: 0.5, y: 0.5 },
      });
      expect(parsed.focalPoint).toEqual({ x: 0.5, y: 0.5 });
    });

    it('rejects focalPoint outside 0-1 range', () => {
      expect(() =>
        uploadInputSchema.parse({
          filename: 'x.jpg',
          mimeType: 'image/jpeg',
          focalPoint: { x: 1.5, y: 0.5 },
        }),
      ).toThrow();
    });
  });

  describe('confirmUploadSchema', () => {
    it('accepts valid confirm input', () => {
      const parsed = confirmUploadSchema.parse({
        key: 'folder/file.jpg',
        filename: 'file.jpg',
        mimeType: 'image/jpeg',
        size: 1024,
      });
      expect(parsed.key).toBe('folder/file.jpg');
    });

    it('rejects negative size', () => {
      expect(() =>
        confirmUploadSchema.parse({
          key: 'x',
          filename: 'x',
          mimeType: 'image/jpeg',
          size: -1,
        }),
      ).toThrow();
    });

    it('validates hashStrategy enum', () => {
      const parsed = confirmUploadSchema.parse({
        key: 'x',
        filename: 'x',
        mimeType: 'image/jpeg',
        size: 100,
        hashStrategy: 'etag',
      });
      expect(parsed.hashStrategy).toBe('etag');

      expect(() =>
        confirmUploadSchema.parse({
          key: 'x',
          filename: 'x',
          mimeType: 'image/jpeg',
          size: 100,
          hashStrategy: 'md5',
        }),
      ).toThrow();
    });
  });

  describe('initiateMultipartSchema', () => {
    it('accepts valid multipart initiate input', () => {
      const parsed = initiateMultipartSchema.parse({
        filename: 'big.mp4',
        contentType: 'video/mp4',
        partCount: 10,
      });
      expect(parsed.partCount).toBe(10);
    });

    it('rejects zero partCount', () => {
      expect(() =>
        initiateMultipartSchema.parse({
          filename: 'x',
          contentType: 'video/mp4',
          partCount: 0,
        }),
      ).toThrow();
    });
  });

  describe('importFromUrlSchema', () => {
    it('accepts valid URL', () => {
      const parsed = importFromUrlSchema.parse({
        url: 'https://example.com/image.jpg',
      });
      expect(parsed.url).toContain('https://');
    });

    it('rejects invalid URL', () => {
      expect(() => importFromUrlSchema.parse({ url: 'not-a-url' })).toThrow();
    });
  });
});
