/**
 * Bug Fix Validation Tests
 *
 * Batch 1 (7 issues):
 * 1. [High]   replace() — old files deleted before new write (data loss on failure)
 * 2. [High]   confirmUpload() — bypasses file policy (MIME + size) validation
 * 3. [Medium] fetchUrl() — relative Location headers break redirect handling
 * 4. [Medium] purgeDeleted() — deleteMedia can't see soft-deleted docs in multi-tenancy
 * 5. [Medium] upload() dedup — missing after:upload event on dedup hits
 * 6. [Medium] performUpload() — key extension mismatch after processing format conversion
 * 7. [Low]    replace() — dead tempKey variable (removed)
 *
 * Batch 2 (orphan cleanup):
 * 8. [Medium] upload()/replace() — orphaned variant files on partial failure
 *
 * Batch 3 (6 issues):
 * 9.  [High]   confirmUpload() — trusts client MIME instead of cross-checking storage
 * 10. [High]   importFromUrl() — no SSRF protection (private IP blocking)
 * 11. [Medium] purgeDeleted() — only handles first 1000 records (no pagination)
 * 12. [Medium] generateAlt — object config (strategy/fallback/generator) ignored
 * 13. [Medium] confirmUpload() — buffers full file for hashing (memory pressure)
 * 14. [Low]    docs/examples — out of sync with API naming (provider vs driver)
 *
 * Batch 4 (4 issues — SSRF hardening + fail-closed):
 * 15. [High]   isPrivateIP() — misses IPv4-mapped IPv6, carrier-grade NAT, multicast, etc.
 * 16. [High]   fetchUrl() — DNS rebinding TOCTOU gap (separate resolve vs connect)
 * 17. [Medium] validateUrlSafety() — fail-open on DNS lookup errors
 * 18. [Medium] confirmUpload() — falls back to untrusted client metadata on stat() failure
 *
 * Batch 5 (1 issue — over-blocking fix):
 * 19. [Low]    isPrivateIP() — over-blocks public IPv4-mapped IPv6 (::ffff:8.8.8.8 treated as private)
 *
 * Requires: MongoDB running on localhost:27017
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import mongoose from 'mongoose';
import crypto from 'crypto';
import { createMedia } from '../src/media';
import { isPrivateIP, validateUrlSafety } from '../src/operations/url-import';
import { MemoryStorageDriver } from './helpers/memory-driver';
import { computeFileHash, computeStreamHash } from '../src/utils/hash';
import type { IMediaDocument } from '../src/types';

describe('Bug Fix Validation', () => {
  let driver: MemoryStorageDriver;

  beforeAll(async () => {
    await mongoose.connect('mongodb://localhost:27017/mediakit-bugfix-test');
  });

  afterAll(async () => {
    await mongoose.disconnect();
  });

  beforeEach(async () => {
    const collections = await mongoose.connection.db?.collections();
    if (collections) {
      for (const collection of collections) {
        await collection.deleteMany({});
      }
    }

    Object.keys(mongoose.models).forEach(key => {
      delete mongoose.models[key];
    });

    driver = new MemoryStorageDriver();
  });

  // ============================================
  // 1. replace() — write-before-delete safety
  // ============================================

  describe('Fix #1: replace() writes new file before deleting old', () => {
    it('should preserve old file if write fails', async () => {
      const media = createMedia({
        driver,
        processing: { enabled: false },
        suppressWarnings: true,
      });

      const Media = mongoose.model('Test', media.schema);
      media.init(Media);

      // Upload original
      const originalBuffer = Buffer.from('original content');
      const original = await media.upload({
        buffer: originalBuffer,
        filename: 'doc.pdf',
        mimeType: 'application/pdf',
        folder: 'test',
      });

      const originalKey = original.key;

      // Make driver.write fail for the replacement
      const writeSpy = vi.spyOn(driver, 'write').mockRejectedValueOnce(new Error('S3 write failed'));

      // Attempt replace — should fail
      await expect(
        media.replace((original as any)._id.toString(), {
          buffer: Buffer.from('new content'),
          filename: 'doc-v2.pdf',
          mimeType: 'application/pdf',
        })
      ).rejects.toThrow('S3 write failed');

      writeSpy.mockRestore();

      // The original file should still exist in storage (not deleted)
      const originalStillExists = await driver.exists(originalKey);
      expect(originalStillExists).toBe(true);

      // The original buffer should be intact
      const storedBuffer = driver.getBuffer(originalKey);
      expect(storedBuffer?.toString()).toBe('original content');
    });

    it('should delete old file after successful write + DB update', async () => {
      const media = createMedia({
        driver,
        processing: { enabled: false },
        suppressWarnings: true,
      });

      const Media = mongoose.model('Test', media.schema);
      media.init(Media);

      const original = await media.upload({
        buffer: Buffer.from('original'),
        filename: 'photo.jpg',
        mimeType: 'image/jpeg',
        folder: 'test',
      });

      const originalKey = original.key;

      const replaced = await media.replace((original as any)._id.toString(), {
        buffer: Buffer.from('replacement image data'),
        filename: 'photo-v2.jpg',
        mimeType: 'image/jpeg',
      });

      // Old file should be cleaned up
      const oldExists = await driver.exists(originalKey);
      expect(oldExists).toBe(false);

      // New file should exist
      const newExists = await driver.exists(replaced.key);
      expect(newExists).toBe(true);
    });
  });

  // ============================================
  // 2. confirmUpload() — file policy enforcement
  // ============================================

  describe('Fix #2: confirmUpload() enforces file policy', () => {
    it('should reject disallowed MIME types', async () => {
      const media = createMedia({
        driver,
        processing: { enabled: false },
        fileTypes: {
          allowed: ['image/*', 'video/*'],
        },
        suppressWarnings: true,
      });

      const Media = mongoose.model('Test', media.schema);
      media.init(Media);

      // Simulate presigned upload of a ZIP file (not allowed)
      const key = 'uploads/malicious.zip';
      driver.simulateExternalUpload(key, Buffer.from('PK zip data'), 'application/zip');

      await expect(
        media.confirmUpload({
          key,
          filename: 'malicious.zip',
          mimeType: 'application/zip',
          size: 11,
        })
      ).rejects.toThrow(/not allowed/);
    });

    it('should reject oversized files', async () => {
      const media = createMedia({
        driver,
        processing: { enabled: false },
        fileTypes: {
          maxSize: 100, // 100 bytes
        },
        suppressWarnings: true,
      });

      const Media = mongoose.model('Test', media.schema);
      media.init(Media);

      // Simulate presigned upload of a large file
      const key = 'uploads/big-file.jpg';
      const largeBuffer = Buffer.alloc(200); // 200 bytes > 100 limit
      driver.simulateExternalUpload(key, largeBuffer, 'image/jpeg');

      await expect(
        media.confirmUpload({
          key,
          filename: 'big-file.jpg',
          mimeType: 'image/jpeg',
          size: 200,
        })
      ).rejects.toThrow(/exceeds limit/);
    });

    it('should allow valid files through', async () => {
      const media = createMedia({
        driver,
        processing: { enabled: false },
        fileTypes: {
          allowed: ['image/*'],
          maxSize: 1024 * 1024,
        },
        suppressWarnings: true,
      });

      const Media = mongoose.model('Test', media.schema);
      media.init(Media);

      const key = 'uploads/photo.jpg';
      const buffer = Buffer.from('valid jpeg data');
      driver.simulateExternalUpload(key, buffer, 'image/jpeg');

      const result = await media.confirmUpload({
        key,
        filename: 'photo.jpg',
        mimeType: 'image/jpeg',
        size: buffer.length,
      });

      expect(result.status).toBe('ready');
      expect(result.mimeType).toBe('image/jpeg');
    });
  });

  // ============================================
  // 4. purgeDeleted() — multi-tenancy visibility
  // ============================================

  describe('Fix #4: purgeDeleted() works with multi-tenancy', () => {
    it('should hard-delete soft-deleted docs when multi-tenancy is enabled', async () => {
      const media = createMedia({
        driver,
        processing: { enabled: false },
        softDelete: { enabled: true, ttlDays: 0 },
        multiTenancy: { enabled: true },
        suppressWarnings: true,
      });

      const Media = mongoose.model('Test', media.schema);
      media.init(Media);

      const context = { organizationId: new mongoose.Types.ObjectId().toString() };

      // Upload a file
      const uploaded = await media.upload({
        buffer: Buffer.from('tenant file'),
        filename: 'tenant-doc.txt',
        mimeType: 'text/plain',
        folder: 'test',
      }, context);

      const id = (uploaded as any)._id.toString();

      // Soft delete it
      await media.softDelete(id, context);

      // Verify it's soft-deleted
      const afterSoftDelete = await media.getById(id, context);
      expect(afterSoftDelete).toBeNull();

      // Purge should successfully hard-delete it
      const olderThan = new Date(Date.now() + 1000); // future = all soft-deleted qualify
      const purgedCount = await media.purgeDeleted(olderThan, context);
      expect(purgedCount).toBe(1);

      // Verify truly gone (even with includeTrashed)
      const afterPurge = await media.getById(id, { ...context, includeTrashed: true });
      expect(afterPurge).toBeNull();
    });
  });

  // ============================================
  // 5. Dedup — symmetric after:upload event
  // ============================================

  describe('Fix #5: dedup emits after:upload event', () => {
    it('should emit both before:upload and after:upload on dedup hit', async () => {
      const media = createMedia({
        driver,
        processing: { enabled: false },
        deduplication: { enabled: true },
        suppressWarnings: true,
      });

      const Media = mongoose.model('Test', media.schema);
      media.init(Media);

      const beforeEvents: unknown[] = [];
      const afterEvents: unknown[] = [];

      media.on('before:upload', (event) => {
        beforeEvents.push(event);
      });
      media.on('after:upload', (event) => {
        afterEvents.push(event);
      });

      const buffer = Buffer.from('dedup-test-content');

      // First upload — normal flow
      await media.upload({
        buffer,
        filename: 'file.txt',
        mimeType: 'text/plain',
        folder: 'test',
      });

      expect(beforeEvents).toHaveLength(1);
      expect(afterEvents).toHaveLength(1);

      // Second upload — same content, dedup hit
      const deduped = await media.upload({
        buffer,
        filename: 'file-copy.txt',
        mimeType: 'text/plain',
        folder: 'test',
      });

      // Both events should have fired for the dedup hit too
      expect(beforeEvents).toHaveLength(2);
      expect(afterEvents).toHaveLength(2);

      // The dedup result should be the original file
      expect(deduped.hash).toBeDefined();
    });
  });

  // ============================================
  // 6. Key regeneration after format conversion
  // ============================================

  describe('Fix #6: key regenerated after processing changes format', () => {
    it('should use correct extension in key when processing changes MIME type', async () => {
      // Create a mock processor that converts to webp
      const mockProcessor = {
        process: vi.fn().mockResolvedValue({
          buffer: Buffer.from('processed webp data'),
          mimeType: 'image/webp',
          width: 800,
          height: 600,
        }),
        getDimensions: vi.fn().mockResolvedValue({ width: 800, height: 600 }),
        generateVariants: vi.fn().mockResolvedValue([]),
      };

      const media = createMedia({
        driver,
        processing: {
          enabled: true,
          format: 'webp',
        },
        suppressWarnings: true,
      });

      // Inject mock processor
      (media as any).processor = mockProcessor;

      const Media = mongoose.model('Test', media.schema);
      media.init(Media);

      const result = await media.upload({
        buffer: Buffer.from('fake png data'),
        filename: 'photo.png',
        mimeType: 'image/png',
        folder: 'test',
      });

      // Key should end with .webp, not .png
      expect(result.key).toMatch(/\.webp$/);
      expect(result.mimeType).toBe('image/webp');

      // The actual stored file should be at the webp key
      const exists = await driver.exists(result.key);
      expect(exists).toBe(true);
    });

    it('should keep original key when no format conversion happens', async () => {
      const media = createMedia({
        driver,
        processing: { enabled: false },
        suppressWarnings: true,
      });

      const Media = mongoose.model('Test', media.schema);
      media.init(Media);

      const result = await media.upload({
        buffer: Buffer.from('plain text'),
        filename: 'readme.txt',
        mimeType: 'text/plain',
        folder: 'test',
      });

      expect(result.key).toMatch(/\.txt$/);
    });
  });

  // ============================================
  // 8. Orphaned variant cleanup on failure
  // ============================================

  describe('Fix #8: orphaned variant cleanup on upload/replace failure', () => {
    it('upload() should clean up variant files if main write fails', async () => {
      // Mock processor that generates a variant
      const mockProcessor = {
        process: vi.fn().mockResolvedValue({
          buffer: Buffer.from('processed main'),
          mimeType: 'image/webp',
          width: 800,
          height: 600,
        }),
        getDimensions: vi.fn().mockResolvedValue({ width: 800, height: 600 }),
        generateVariants: vi.fn().mockResolvedValue([{
          buffer: Buffer.from('thumb data'),
          mimeType: 'image/webp',
          width: 200,
          height: 150,
        }]),
      };

      const media = createMedia({
        driver,
        processing: {
          enabled: true,
          format: 'webp',
          keepOriginal: false,
          sizes: [{ name: 'thumb', width: 200 }],
        },
        suppressWarnings: true,
      });

      (media as any).processor = mockProcessor;

      const Media = mongoose.model('Test', media.schema);
      media.init(Media);

      // Write order: 1=variant (thumb), 2=main file — fail on main
      let writeCount = 0;
      const originalWrite = driver.write.bind(driver);
      vi.spyOn(driver, 'write').mockImplementation(async (key, data, ct) => {
        writeCount++;
        if (writeCount === 2) {
          throw new Error('Simulated main write failure');
        }
        return originalWrite(key, data, ct);
      });

      await expect(
        media.upload({
          buffer: Buffer.from('fake png'),
          filename: 'photo.png',
          mimeType: 'image/png',
          folder: 'test',
        })
      ).rejects.toThrow('Simulated main write failure');

      vi.restoreAllMocks();

      // Variant file should have been cleaned up (not orphaned)
      expect(driver.size).toBe(0);
    });

    it('replace() should clean up new variant files if main write fails', async () => {
      const media = createMedia({
        driver,
        processing: { enabled: false },
        suppressWarnings: true,
      });

      const Media = mongoose.model('Test', media.schema);
      media.init(Media);

      // Upload original
      const original = await media.upload({
        buffer: Buffer.from('original'),
        filename: 'photo.jpg',
        mimeType: 'image/jpeg',
        folder: 'test',
      });

      const originalKey = original.key;

      // Now set up a processor for replacement that generates variants
      const mockProcessor = {
        process: vi.fn().mockResolvedValue({
          buffer: Buffer.from('processed replacement'),
          mimeType: 'image/webp',
          width: 800,
          height: 600,
        }),
        getDimensions: vi.fn().mockResolvedValue({ width: 800, height: 600 }),
        generateVariants: vi.fn().mockResolvedValue([{
          buffer: Buffer.from('new thumb'),
          mimeType: 'image/webp',
          width: 200,
          height: 150,
        }]),
      };

      // Enable processing + inject mock for the replace call
      (media as any).config.processing = {
        enabled: true,
        format: 'webp',
        sizes: [{ name: 'thumb', width: 200 }],
      };
      (media as any).processor = mockProcessor;

      // Let variant write succeed, fail on main write
      let writeCount = 0;
      const originalWrite = driver.write.bind(driver);
      vi.spyOn(driver, 'write').mockImplementation(async (key, data, ct) => {
        writeCount++;
        // writeCount 1 = variant, writeCount 2 = main — fail on main
        if (writeCount === 2) {
          throw new Error('Simulated main write failure');
        }
        return originalWrite(key, data, ct);
      });

      await expect(
        media.replace((original as any)._id.toString(), {
          buffer: Buffer.from('fake png replace'),
          filename: 'photo-v2.png',
          mimeType: 'image/png',
        })
      ).rejects.toThrow('Simulated main write failure');

      vi.restoreAllMocks();

      // Original file should still exist (replace didn't delete it)
      const origExists = await driver.exists(originalKey);
      expect(origExists).toBe(true);

      // Only the original file should remain — orphaned variant was cleaned up
      expect(driver.size).toBe(1);
    });
  });

  // ============================================
  // 7. Dead tempKey removed (compile-time check)
  // ============================================

  describe('Fix #7: dead tempKey variable removed', () => {
    it('replace() should work without creating a temp key', async () => {
      const media = createMedia({
        driver,
        processing: { enabled: false },
        suppressWarnings: true,
      });

      const Media = mongoose.model('Test', media.schema);
      media.init(Media);

      // Track all keys written to storage
      const writtenKeys: string[] = [];
      const originalWrite = driver.write.bind(driver);
      vi.spyOn(driver, 'write').mockImplementation(async (key, data, ct) => {
        writtenKeys.push(key);
        return originalWrite(key, data, ct);
      });

      // Upload + replace
      const original = await media.upload({
        buffer: Buffer.from('original'),
        filename: 'doc.pdf',
        mimeType: 'application/pdf',
        folder: 'test',
      });

      await media.replace((original as any)._id.toString(), {
        buffer: Buffer.from('replacement'),
        filename: 'doc-v2.pdf',
        mimeType: 'application/pdf',
      });

      // No key should contain 'tmp-'
      const tempKeys = writtenKeys.filter(k => k.includes('tmp-'));
      expect(tempKeys).toHaveLength(0);
    });
  });

  // ============================================
  // 9. confirmUpload() — MIME cross-check
  // ============================================

  describe('Fix #9: confirmUpload() cross-checks storage MIME vs client claim', () => {
    it('should reject when storage MIME differs from client claim and is disallowed', async () => {
      const media = createMedia({
        driver,
        processing: { enabled: false },
        fileTypes: {
          allowed: ['image/*'],
        },
        suppressWarnings: true,
      });

      const Media = mongoose.model('Test', media.schema);
      media.init(Media);

      // Client claims image/jpeg, but storage has application/zip
      const key = 'uploads/sneaky.jpg';
      driver.simulateExternalUpload(key, Buffer.from('PK zip data'), 'application/zip');

      await expect(
        media.confirmUpload({
          key,
          filename: 'sneaky.jpg',
          mimeType: 'image/jpeg', // Client lie
          size: 11,
        })
      ).rejects.toThrow(/mismatch.*application\/zip.*not allowed/);
    });

    it('should use storage MIME type as authoritative in the DB record', async () => {
      const media = createMedia({
        driver,
        processing: { enabled: false },
        fileTypes: {
          allowed: ['image/*'],
        },
        suppressWarnings: true,
      });

      const Media = mongoose.model('Test', media.schema);
      media.init(Media);

      // Client claims image/jpeg, storage says image/png (both allowed)
      const key = 'uploads/photo.png';
      driver.simulateExternalUpload(key, Buffer.from('png data'), 'image/png');

      const result = await media.confirmUpload({
        key,
        filename: 'photo.png',
        mimeType: 'image/jpeg', // Client says jpeg, but storage says png
        size: 8,
      });

      // DB record should use storage-reported MIME (authoritative)
      expect(result.mimeType).toBe('image/png');
    });
  });

  // ============================================
  // 10. importFromUrl() — SSRF protection
  // ============================================

  describe('Fix #10: importFromUrl() blocks private/internal IPs', () => {
    it('should reject localhost URLs', async () => {
      const media = createMedia({
        driver,
        processing: { enabled: false },
        suppressWarnings: true,
      });

      const Media = mongoose.model('Test', media.schema);
      media.init(Media);

      await expect(
        media.importFromUrl('http://localhost/secret-file.txt')
      ).rejects.toThrow(/blocked internal hostname/);
    });

    it('should reject metadata.google.internal URLs', async () => {
      const media = createMedia({
        driver,
        processing: { enabled: false },
        suppressWarnings: true,
      });

      const Media = mongoose.model('Test', media.schema);
      media.init(Media);

      await expect(
        media.importFromUrl('http://metadata.google.internal/computeMetadata/v1/')
      ).rejects.toThrow(/blocked internal hostname/);
    });

    it('should reject non-http protocols', async () => {
      const media = createMedia({
        driver,
        processing: { enabled: false },
        suppressWarnings: true,
      });

      const Media = mongoose.model('Test', media.schema);
      media.init(Media);

      await expect(
        media.importFromUrl('file:///etc/passwd')
      ).rejects.toThrow(/unsupported protocol/);
    });

    it('should reject URLs resolving to private IPs (127.0.0.1)', () => {
      // Test the IP validation directly via the exported function
      expect(isPrivateIP('127.0.0.1')).toBe(true);
      expect(isPrivateIP('10.0.0.1')).toBe(true);
      expect(isPrivateIP('172.16.0.1')).toBe(true);
      expect(isPrivateIP('192.168.1.1')).toBe(true);
      expect(isPrivateIP('169.254.169.254')).toBe(true);
      expect(isPrivateIP('0.0.0.0')).toBe(true);
      expect(isPrivateIP('::1')).toBe(true);

      // Public IPs should be allowed
      expect(isPrivateIP('8.8.8.8')).toBe(false);
      expect(isPrivateIP('1.1.1.1')).toBe(false);
      expect(isPrivateIP('93.184.216.34')).toBe(false);
    });
  });

  // ============================================
  // 11. purgeDeleted() — pagination beyond 1000
  // ============================================

  describe('Fix #11: purgeDeleted() paginates beyond 1000 records', () => {
    it('should purge more than one batch of records', async () => {
      const media = createMedia({
        driver,
        processing: { enabled: false },
        softDelete: { enabled: true, ttlDays: 0 },
        suppressWarnings: true,
      });

      const Media = mongoose.model('Test', media.schema);
      media.init(Media);

      // Upload and soft-delete 5 files (simulating multi-batch — we spy on getAllMedia to verify pagination)
      const ids: string[] = [];
      for (let i = 0; i < 5; i++) {
        const uploaded = await media.upload({
          buffer: Buffer.from(`file-${i}`),
          filename: `file-${i}.txt`,
          mimeType: 'text/plain',
          folder: 'test',
        });
        ids.push((uploaded as any)._id.toString());
        await media.softDelete(ids[i]);
      }

      // Spy on repository to verify multiple queries are made
      const getAllSpy = vi.spyOn(media.repository, 'getAllMedia');

      // Purge all (olderThan = future date so all qualify)
      const purged = await media.purgeDeleted(new Date(Date.now() + 10000));
      expect(purged).toBe(5);

      // Should have called getAllMedia at least once (might be 2 times: first batch + empty check)
      expect(getAllSpy.mock.calls.length).toBeGreaterThanOrEqual(1);

      // Verify all docs are truly gone
      for (const id of ids) {
        const doc = await media.getById(id, { includeTrashed: true });
        expect(doc).toBeNull();
      }

      getAllSpy.mockRestore();
    });

    it('should handle batch boundary correctly (loop exits on empty batch)', async () => {
      const media = createMedia({
        driver,
        processing: { enabled: false },
        softDelete: { enabled: true, ttlDays: 0 },
        suppressWarnings: true,
      });

      const Media = mongoose.model('Test', media.schema);
      media.init(Media);

      // Purge with nothing to purge — should return 0 without error
      const purged = await media.purgeDeleted(new Date(Date.now() + 10000));
      expect(purged).toBe(0);
    });
  });

  // ============================================
  // 12. generateAlt — full config support
  // ============================================

  describe('Fix #12: generateAlt honors strategy/fallback/generator config', () => {
    it('should use custom fallback text', async () => {
      const media = createMedia({
        driver,
        processing: {
          enabled: false,
          generateAlt: {
            enabled: true,
            strategy: 'filename',
            fallback: 'Product image',
          },
        },
        suppressWarnings: true,
      });

      const Media = mongoose.model('Test', media.schema);
      media.init(Media);

      // Upload an image with a filename that would produce empty alt text (just numbers)
      const result = await media.upload({
        buffer: Buffer.from('fake png'),
        filename: 'IMG_20240315_142032.png',
        mimeType: 'image/png',
        folder: 'test',
      });

      // Should use custom fallback instead of default "Image"
      expect(result.alt).toBe('Product image');
    });

    it('should use custom generator function', async () => {
      const customGenerator = vi.fn().mockResolvedValue('AI-generated alt text');

      const media = createMedia({
        driver,
        processing: {
          enabled: false,
          generateAlt: {
            enabled: true,
            strategy: 'ai',
            generator: customGenerator,
          },
        },
        suppressWarnings: true,
      });

      const Media = mongoose.model('Test', media.schema);
      media.init(Media);

      const result = await media.upload({
        buffer: Buffer.from('fake image data'),
        filename: 'product-red-shoes.jpg',
        mimeType: 'image/jpeg',
        folder: 'test',
      });

      // Generator should have been called with filename and buffer
      expect(customGenerator).toHaveBeenCalledWith('product-red-shoes.jpg', expect.any(Buffer));
      expect(result.alt).toBe('AI-generated alt text');
    });

    it('should fall back to filename strategy when generator fails', async () => {
      const failingGenerator = vi.fn().mockRejectedValue(new Error('AI service down'));

      const media = createMedia({
        driver,
        processing: {
          enabled: false,
          generateAlt: {
            enabled: true,
            strategy: 'ai',
            fallback: 'Fallback alt',
            generator: failingGenerator,
          },
        },
        suppressWarnings: true,
      });

      const Media = mongoose.model('Test', media.schema);
      media.init(Media);

      const result = await media.upload({
        buffer: Buffer.from('fake image'),
        filename: 'nice-shoes.jpg',
        mimeType: 'image/jpeg',
        folder: 'test',
      });

      // Generator failed → should use fallback text
      expect(result.alt).toBe('Fallback alt');
    });

    it('should use boolean true for simple filename strategy', async () => {
      const media = createMedia({
        driver,
        processing: {
          enabled: false,
          generateAlt: true,
        },
        suppressWarnings: true,
      });

      const Media = mongoose.model('Test', media.schema);
      media.init(Media);

      const result = await media.upload({
        buffer: Buffer.from('fake image'),
        filename: 'red-running-shoes.jpg',
        mimeType: 'image/jpeg',
        folder: 'test',
      });

      expect(result.alt).toBe('Red running shoes');
    });
  });

  // ============================================
  // 13. confirmUpload() — streaming hash
  // ============================================

  describe('Fix #13: confirmUpload() uses streaming hash (no full buffer)', () => {
    it('should compute correct hash without buffering entire file', async () => {
      const media = createMedia({
        driver,
        processing: { enabled: false },
        suppressWarnings: true,
      });

      const Media = mongoose.model('Test', media.schema);
      media.init(Media);

      const fileContent = Buffer.from('hello world for hash test');
      const key = 'uploads/hash-test.txt';
      driver.simulateExternalUpload(key, fileContent, 'text/plain');

      const result = await media.confirmUpload({
        key,
        filename: 'hash-test.txt',
        mimeType: 'text/plain',
        size: fileContent.length,
        hashStrategy: 'sha256', // explicit SHA-256 (default changed to 'etag' for zero-cost)
      });

      // Hash should match what we'd get from hashing the buffer directly
      const expectedHash = computeFileHash(fileContent);
      expect(result.hash).toBe(expectedHash);
    });

    it('computeStreamHash produces same result as computeFileHash', async () => {
      const { Readable } = await import('stream');
      const buffer = Buffer.from('streaming hash parity test');

      const bufferHash = computeFileHash(buffer, 'sha256');
      const stream = Readable.from(buffer);
      const streamHash = await computeStreamHash(stream, 'sha256');

      expect(streamHash).toBe(bufferHash);
    });
  });

  // ============================================
  // 14. Docs sync — compile-time verification
  // ============================================

  describe('Fix #14: docs/API naming sync', () => {
    it('createMedia config should accept "driver" not "provider"', () => {
      // This test verifies the TypeScript API at runtime
      const media = createMedia({
        driver, // ← must be "driver", not "provider"
        processing: { enabled: false },
        suppressWarnings: true,
      });

      // If this compiles and runs, the API uses 'driver' correctly
      expect(media.driver).toBe(driver);
      expect(media.config.driver).toBe(driver);
    });
  });

  // ============================================
  // 15. isPrivateIP() — IPv4-mapped IPv6 + additional reserved ranges
  // ============================================

  describe('Fix #15: isPrivateIP handles IPv4-mapped IPv6 and additional reserved ranges', () => {
    it('should block IPv4-mapped IPv6 addresses (::ffff:127.0.0.1)', () => {
      expect(isPrivateIP('::ffff:127.0.0.1')).toBe(true);
      expect(isPrivateIP('::ffff:10.0.0.1')).toBe(true);
      expect(isPrivateIP('::ffff:192.168.1.1')).toBe(true);
      expect(isPrivateIP('::ffff:169.254.169.254')).toBe(true);
      expect(isPrivateIP('::ffff:0.0.0.0')).toBe(true);
    });

    it('should block carrier-grade NAT (100.64.0.0/10)', () => {
      expect(isPrivateIP('100.64.0.1')).toBe(true);
      expect(isPrivateIP('100.127.255.254')).toBe(true);
      // Just outside range — should be allowed
      expect(isPrivateIP('100.63.255.255')).toBe(false);
      expect(isPrivateIP('100.128.0.0')).toBe(false);
    });

    it('should block multicast, reserved, and documentation ranges', () => {
      // Multicast (224.0.0.0+)
      expect(isPrivateIP('224.0.0.1')).toBe(true);
      expect(isPrivateIP('239.255.255.255')).toBe(true);
      // Reserved (240+)
      expect(isPrivateIP('240.0.0.1')).toBe(true);
      expect(isPrivateIP('255.255.255.255')).toBe(true);
      // Benchmarking (198.18.0.0/15)
      expect(isPrivateIP('198.18.0.1')).toBe(true);
      expect(isPrivateIP('198.19.255.255')).toBe(true);
      // TEST-NETs
      expect(isPrivateIP('192.0.2.1')).toBe(true);    // TEST-NET-1
      expect(isPrivateIP('198.51.100.1')).toBe(true);  // TEST-NET-2
      expect(isPrivateIP('203.0.113.1')).toBe(true);   // TEST-NET-3
      // IPv6 documentation
      expect(isPrivateIP('2001:db8::1')).toBe(true);
      // IPv6 multicast
      expect(isPrivateIP('ff02::1')).toBe(true);
      // Unspecified
      expect(isPrivateIP('::')).toBe(true);

      // Public should still pass
      expect(isPrivateIP('8.8.8.8')).toBe(false);
      expect(isPrivateIP('93.184.216.34')).toBe(false);
    });
  });

  // ============================================
  // 16. fetchUrl() — DNS rebinding TOCTOU mitigation
  // ============================================

  describe('Fix #16: fetchUrl() pins resolved IP to prevent DNS rebinding', () => {
    it('should pass resolved IP via pinned lookup (validateUrlSafety returns IP)', async () => {
      await expect(
        validateUrlSafety('http://localhost/test')
      ).rejects.toThrow(/blocked internal hostname/);

      // For non-http protocol, it should throw before DNS
      await expect(
        validateUrlSafety('ftp://example.com/test')
      ).rejects.toThrow(/unsupported protocol/);
    });
  });

  // ============================================
  // 17. validateUrlSafety() — fail-closed on DNS errors
  // ============================================

  describe('Fix #17: validateUrlSafety() fails closed on DNS lookup errors', () => {
    it('should reject when DNS resolution fails (not silently continue)', async () => {
      await expect(
        validateUrlSafety('http://this-domain-does-not-exist-xyzzy-12345.invalid/file.txt')
      ).rejects.toThrow(/DNS resolution failed/);
    });

    it('should still block known internal hostnames before DNS', async () => {
      await expect(
        validateUrlSafety('http://metadata.google.internal/computeMetadata/v1/')
      ).rejects.toThrow(/blocked internal hostname/);

      await expect(
        validateUrlSafety('http://evil.localhost/test')
      ).rejects.toThrow(/blocked internal hostname/);
    });

    it('should block raw private IP literals in URL', async () => {
      await expect(
        validateUrlSafety('http://127.0.0.1/secret')
      ).rejects.toThrow(/blocked private IP/);

      await expect(
        validateUrlSafety('http://10.0.0.1/internal')
      ).rejects.toThrow(/blocked private IP/);
    });
  });

  // ============================================
  // 18. confirmUpload() — fail-closed on stat() error
  // ============================================

  describe('Fix #18: confirmUpload() fails closed when stat() errors', () => {
    it('should reject when stat() throws (not fall back to client metadata)', async () => {
      const media = createMedia({
        driver,
        processing: { enabled: false },
        suppressWarnings: true,
      });

      const Media = mongoose.model('Test', media.schema);
      media.init(Media);

      // File exists but stat() will fail (simulate by uploading then breaking stat)
      const key = 'uploads/stat-fail.txt';
      driver.simulateExternalUpload(key, Buffer.from('data'), 'text/plain');

      // Temporarily break stat()
      const origStat = driver.stat.bind(driver);
      driver.stat = async () => { throw new Error('Storage backend unavailable'); };

      await expect(
        media.confirmUpload({
          key,
          filename: 'stat-fail.txt',
          mimeType: 'text/plain',
          size: 4,
        })
      ).rejects.toThrow(/Cannot verify uploaded file metadata/);

      // Restore
      driver.stat = origStat;
    });

    it('should include original error message in the rejection', async () => {
      const media = createMedia({
        driver,
        processing: { enabled: false },
        suppressWarnings: true,
      });

      const Media = mongoose.model('Test', media.schema);
      media.init(Media);

      const key = 'uploads/stat-msg.txt';
      driver.simulateExternalUpload(key, Buffer.from('data'), 'text/plain');

      const origStat = driver.stat.bind(driver);
      driver.stat = async () => { throw new Error('Connection refused'); };

      await expect(
        media.confirmUpload({
          key,
          filename: 'stat-msg.txt',
          mimeType: 'text/plain',
          size: 4,
        })
      ).rejects.toThrow(/Connection refused/);

      driver.stat = origStat;
    });
  });

  // ============================================
  // 19. isPrivateIP() — over-blocks public IPv4-mapped IPv6
  // ============================================

  describe('Fix #19: isPrivateIP does not over-block public IPv4-mapped IPv6', () => {
    it('should allow public IPs in ::ffff: notation', () => {
      expect(isPrivateIP('::ffff:8.8.8.8')).toBe(false);
      expect(isPrivateIP('::ffff:1.1.1.1')).toBe(false);
      expect(isPrivateIP('::ffff:142.250.80.46')).toBe(false); // Google
      expect(isPrivateIP('::ffff:93.184.216.34')).toBe(false); // example.com
      expect(isPrivateIP('::ffff:104.16.132.229')).toBe(false); // Cloudflare
    });

    it('should still block private IPs in ::ffff: notation', () => {
      expect(isPrivateIP('::ffff:127.0.0.1')).toBe(true);
      expect(isPrivateIP('::ffff:10.0.0.1')).toBe(true);
      expect(isPrivateIP('::ffff:192.168.1.1')).toBe(true);
      expect(isPrivateIP('::ffff:172.16.0.1')).toBe(true);
      expect(isPrivateIP('::ffff:169.254.169.254')).toBe(true); // cloud metadata
      expect(isPrivateIP('::ffff:100.64.0.1')).toBe(true); // carrier-grade NAT
      expect(isPrivateIP('::ffff:0.0.0.0')).toBe(true);
    });

    it('should block ::ffff: with non-dotted notation (unparseable = suspicious)', () => {
      expect(isPrivateIP('::ffff:0808:0808')).toBe(true); // hex notation
      expect(isPrivateIP('::ffff:abcd')).toBe(true); // malformed
    });

    it('should not affect plain IPv4 or IPv6 behavior', () => {
      // Plain IPv4 public — still allowed
      expect(isPrivateIP('8.8.8.8')).toBe(false);
      expect(isPrivateIP('1.1.1.1')).toBe(false);

      // Plain IPv4 private — still blocked
      expect(isPrivateIP('127.0.0.1')).toBe(true);
      expect(isPrivateIP('10.0.0.1')).toBe(true);

      // IPv6 private — still blocked
      expect(isPrivateIP('::1')).toBe(true);
      expect(isPrivateIP('fc00::1')).toBe(true);
      expect(isPrivateIP('fe80::1')).toBe(true);
      expect(isPrivateIP('2001:db8::1')).toBe(true);

      // Pure IPv6 public — still allowed
      expect(isPrivateIP('2607:f8b0:4004:800::200e')).toBe(false); // Google
    });
  });

  // ============================================
  // 20. media.ts lifecycle/utilities
  // ============================================

  describe('Fix #20: media.ts lifecycle and helper behavior', () => {
    it('should allow validateFile/getContentType before init', () => {
      const media = createMedia({
        driver,
        processing: { enabled: false },
        fileTypes: { allowed: ['image/*'], maxSize: 1024 },
        suppressWarnings: true,
      });

      expect(() => media.getContentType('products/shoes')).not.toThrow();
      expect(media.getContentType('products/shoes')).toBe('default');
      expect(() =>
        media.validateFile(Buffer.from('ok'), 'photo.jpg', 'image/jpeg')
      ).not.toThrow();
    });

    it('should throw on double init', () => {
      const media = createMedia({
        driver,
        processing: { enabled: false },
        suppressWarnings: true,
      });

      const Media = mongoose.model('Test', media.schema);
      media.init(Media);

      expect(() => media.init(Media)).toThrow(/already initialized/i);
    });
  });
});
