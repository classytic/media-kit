/**
 * Unit tests — Zod v4 schemas
 */

import { describe, it, expect } from 'vitest';
import {
  mediaConfigSchema,
  uploadInputSchema,
  confirmUploadSchema,
  initiateMultipartSchema,
  completeMultipartSchema,
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
      expect(() => mediaConfigSchema.parse({ tenant: { fieldType: 'wrong' } as any })).toThrow();
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

    it('defaults softDelete.ttlIndex to false (TTL index is opt-in)', () => {
      const parsed = mediaConfigSchema.parse({
        softDelete: { enabled: true, ttlDays: 30 },
      });
      expect(parsed.softDelete?.ttlIndex).toBe(false);
    });

    it('accepts softDelete.ttlIndex: true', () => {
      const parsed = mediaConfigSchema.parse({
        softDelete: { enabled: true, ttlDays: 30, ttlIndex: true },
      });
      expect(parsed.softDelete?.ttlIndex).toBe(true);
    });

    it('rejects negative ttlDays', () => {
      expect(() => mediaConfigSchema.parse({ softDelete: { enabled: true, ttlDays: -1 } })).toThrow();
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
      expect(() => uploadInputSchema.parse({ filename: '', mimeType: 'image/jpeg' })).toThrow();
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

  describe('client-computed metadata (width/height/thumbhash/dominantColor)', () => {
    const base = { key: 'x', filename: 'x', mimeType: 'image/jpeg', size: 100 };

    it('accepts valid client metadata on confirmUploadSchema', () => {
      const parsed = confirmUploadSchema.parse({
        ...base,
        width: 1280,
        height: 960,
        thumbhash: '3OcRJYB4d3h/iIeHeEh3eIhw+j2w',
        dominantColor: '#AaBbCc',
      });
      expect(parsed.width).toBe(1280);
      expect(parsed.dominantColor).toBe('#AaBbCc');
    });

    it('all four fields are optional', () => {
      const parsed = confirmUploadSchema.parse(base);
      expect(parsed.width).toBeUndefined();
      expect(parsed.thumbhash).toBeUndefined();
    });

    it('rejects non-hex dominantColor values', () => {
      for (const dominantColor of ['red', '#12345', '#12345g', 'aabbcc', '#aabbccdd']) {
        expect(() => confirmUploadSchema.parse({ ...base, dominantColor })).toThrow();
      }
    });

    it('rejects an oversize thumbhash (>128 chars)', () => {
      expect(() => confirmUploadSchema.parse({ ...base, thumbhash: 'a'.repeat(129) })).toThrow();
      expect(confirmUploadSchema.parse({ ...base, thumbhash: 'a'.repeat(128) }).thumbhash).toHaveLength(128);
    });

    it('rejects non-positive, non-integer, and oversized dimensions', () => {
      for (const width of [0, -1, 1.5, 65536]) {
        expect(() => confirmUploadSchema.parse({ ...base, width })).toThrow();
      }
      for (const height of [0, -100, 70000]) {
        expect(() => confirmUploadSchema.parse({ ...base, height })).toThrow();
      }
    });

    it('completeMultipartSchema accepts and validates the same fields', () => {
      const multipartBase = {
        key: 'x',
        uploadId: 'u1',
        parts: [{ partNumber: 1, etag: 'e1' }],
        filename: 'x',
        mimeType: 'image/jpeg',
        size: 100,
      };
      const parsed = completeMultipartSchema.parse({ ...multipartBase, width: 640, height: 480 });
      expect(parsed.width).toBe(640);
      expect(() => completeMultipartSchema.parse({ ...multipartBase, dominantColor: 'red' })).toThrow();
      expect(() => completeMultipartSchema.parse({ ...multipartBase, width: -1 })).toThrow();
    });

    it('uploadInputSchema accepts and validates the same fields', () => {
      const uploadBase = { filename: 'x.jpg', mimeType: 'image/jpeg' };
      const parsed = uploadInputSchema.parse({ ...uploadBase, width: 640, height: 480, dominantColor: '#001122' });
      expect(parsed.height).toBe(480);
      expect(() => uploadInputSchema.parse({ ...uploadBase, dominantColor: '#12345' })).toThrow();
      expect(() => uploadInputSchema.parse({ ...uploadBase, thumbhash: 'a'.repeat(129) })).toThrow();
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
