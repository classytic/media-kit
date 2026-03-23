/**
 * Delete & Cleanup Integration Tests
 *
 * Verifies that every delete pathway properly cleans up files from storage:
 *   1. Hard delete — main file + all variants removed from storage + DB
 *   2. Hard delete with processing — __original + size variants cleaned
 *   3. deleteMany — concurrent bulk delete with mixed results
 *   4. Soft-delete → purge — storage files survive soft-delete, removed on purge
 *   5. Purge with variants — variant files also removed during purge
 *   6. Replace — old main + old variants deleted, new files survive
 *   7. Replace failure — new orphan variants cleaned up, old files intact
 *   8. Upload failure — orphan variants cleaned up
 *   9. Delete nonexistent — returns false, no crash
 *  10. Storage failure resilience — delete continues even if driver.delete throws
 *  11. Real image processing — Sharp processes test-img.jpg, then delete cleans all
 *
 * Requires MongoDB at localhost:27017.
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import fs from 'fs';
import path from 'path';
import { createMedia } from '../src/media';
import { MemoryStorageDriver } from './helpers/memory-driver';
import type { MediaKit, GeneratedVariant } from '../src/types';

const MONGO_URI = 'mongodb://localhost:27017/mediakit-delete-cleanup-test';

/** Helper: upload a text file */
async function uploadText(
  media: MediaKit,
  filename = 'test.txt',
  content = 'hello',
  folder = 'general',
) {
  return media.upload({
    buffer: Buffer.from(content),
    filename,
    mimeType: 'text/plain',
    folder,
  });
}

/** Helper: inject fake variants into a document via direct Mongoose update */
async function injectVariants(
  modelName: string,
  docId: string,
  variants: Array<{ name: string; key: string }>,
  driver: MemoryStorageDriver,
) {
  const Model = mongoose.models[modelName]!;
  const variantDocs = variants.map((v) => ({
    name: v.name,
    key: v.key,
    url: `https://cdn.example.com/${v.key}`,
    filename: v.key.split('/').pop()!,
    mimeType: 'image/jpeg',
    size: 100,
    width: 200,
    height: 200,
  }));

  // Write variant files to storage
  for (const v of variants) {
    await driver.write(v.key, Buffer.from(`variant-data-${v.name}`), 'image/jpeg');
  }

  await Model.findByIdAndUpdate(docId, { variants: variantDocs });
}

describe('Delete & Cleanup', () => {
  beforeAll(async () => {
    await mongoose.connect(MONGO_URI);
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
    Object.keys(mongoose.models).forEach((key) => {
      delete mongoose.models[key];
    });
  });

  // =================================================================
  // 1. Hard delete — main file removed from storage + DB
  // =================================================================

  describe('hard delete', () => {
    it('should remove main file from storage and DB', async () => {
      const driver = new MemoryStorageDriver();
      const media = createMedia({
        driver,
        processing: { enabled: false },
        suppressWarnings: true,
      });
      const Media = mongoose.model('Test', media.schema);
      media.init(Media);

      const file = await uploadText(media, 'clean-me.txt', 'data');
      const id = (file as any)._id.toString();
      const key = file.key;

      expect(await driver.exists(key)).toBe(true);
      expect(driver.size).toBe(1);

      const deleted = await media.delete(id);

      expect(deleted).toBe(true);
      expect(await driver.exists(key)).toBe(false);
      expect(driver.size).toBe(0);

      // DB record gone
      const found = await media.getById(id);
      expect(found).toBeNull();
    });

    it('should remove main file + all variants from storage', async () => {
      const driver = new MemoryStorageDriver();
      const media = createMedia({
        driver,
        processing: { enabled: false },
        suppressWarnings: true,
      });
      const Media = mongoose.model('Test', media.schema);
      media.init(Media);

      const file = await uploadText(media, 'with-variants.txt', 'data', 'photos');
      const id = (file as any)._id.toString();

      // Inject 3 fake variants
      await injectVariants('Test', id, [
        { name: '__original', key: 'photos/original.jpg' },
        { name: 'thumb', key: 'photos/thumb.jpg' },
        { name: 'medium', key: 'photos/medium.jpg' },
      ], driver);

      // 1 main + 3 variants = 4 files in storage
      expect(driver.size).toBe(4);

      await media.delete(id);

      // ALL files gone
      expect(driver.size).toBe(0);
      expect(await driver.exists(file.key)).toBe(false);
      expect(await driver.exists('photos/original.jpg')).toBe(false);
      expect(await driver.exists('photos/thumb.jpg')).toBe(false);
      expect(await driver.exists('photos/medium.jpg')).toBe(false);
    });

    it('should return false for nonexistent ID without throwing', async () => {
      const driver = new MemoryStorageDriver();
      const media = createMedia({
        driver,
        processing: { enabled: false },
        suppressWarnings: true,
      });
      const Media = mongoose.model('Test', media.schema);
      media.init(Media);

      const fakeId = new mongoose.Types.ObjectId().toString();
      const result = await media.delete(fakeId);

      expect(result).toBe(false);
    });

    it('should fire before:delete and after:delete events', async () => {
      const driver = new MemoryStorageDriver();
      const media = createMedia({
        driver,
        processing: { enabled: false },
        suppressWarnings: true,
      });
      const Media = mongoose.model('Test', media.schema);
      media.init(Media);

      const beforeEvents: unknown[] = [];
      const afterEvents: unknown[] = [];
      media.on('before:delete', (e: unknown) => beforeEvents.push(e));
      media.on('after:delete', (e: unknown) => afterEvents.push(e));

      const file = await uploadText(media);
      const id = (file as any)._id.toString();
      await media.delete(id);

      expect(beforeEvents).toHaveLength(1);
      expect(afterEvents).toHaveLength(1);
      expect((beforeEvents[0] as any).data.id).toBe(id);
      expect((afterEvents[0] as any).result.deleted).toBe(true);
    });
  });

  // =================================================================
  // 2. Storage failure resilience
  // =================================================================

  describe('storage failure resilience', () => {
    it('should still delete DB record even if storage delete fails for main file', async () => {
      const driver = new MemoryStorageDriver();
      const media = createMedia({
        driver,
        processing: { enabled: false },
        suppressWarnings: true,
      });
      const Media = mongoose.model('Test', media.schema);
      media.init(Media);

      const file = await uploadText(media, 'storage-fail.txt');
      const id = (file as any)._id.toString();

      // Make storage.delete throw
      vi.spyOn(driver, 'delete').mockRejectedValue(new Error('Storage unavailable'));

      const deleted = await media.delete(id);

      expect(deleted).toBe(true);
      // DB record is gone even though storage delete failed
      const found = await media.getById(id);
      expect(found).toBeNull();

      vi.restoreAllMocks();
    });

    it('should continue deleting remaining variants if one variant delete fails', async () => {
      const driver = new MemoryStorageDriver();
      const media = createMedia({
        driver,
        processing: { enabled: false },
        suppressWarnings: true,
      });
      const Media = mongoose.model('Test', media.schema);
      media.init(Media);

      const file = await uploadText(media, 'partial-fail.txt', 'data', 'test');
      const id = (file as any)._id.toString();

      await injectVariants('Test', id, [
        { name: 'v1', key: 'test/v1.jpg' },
        { name: 'v2', key: 'test/v2.jpg' },
        { name: 'v3', key: 'test/v3.jpg' },
      ], driver);

      let callCount = 0;
      const originalDelete = driver.delete.bind(driver);
      vi.spyOn(driver, 'delete').mockImplementation(async (key: string) => {
        callCount++;
        // Fail on v2 variant (3rd delete call: main, v1, v2)
        if (key === 'test/v2.jpg') {
          throw new Error('Network timeout');
        }
        return originalDelete(key);
      });

      await media.delete(id);

      // main + v1 + v3 deleted, v2 failed but operation continued
      expect(await driver.exists(file.key)).toBe(false);
      expect(await driver.exists('test/v1.jpg')).toBe(false);
      expect(await driver.exists('test/v2.jpg')).toBe(true); // failed, still there
      expect(await driver.exists('test/v3.jpg')).toBe(false);

      // DB still cleaned up
      expect(await media.getById(id)).toBeNull();

      vi.restoreAllMocks();
    });
  });

  // =================================================================
  // 3. deleteMany — bulk delete
  // =================================================================

  describe('deleteMany', () => {
    it('should delete multiple files and clean up all storage', async () => {
      const driver = new MemoryStorageDriver();
      const media = createMedia({
        driver,
        processing: { enabled: false },
        suppressWarnings: true,
      });
      const Media = mongoose.model('Test', media.schema);
      media.init(Media);

      const f1 = await uploadText(media, 'bulk1.txt', 'a');
      const f2 = await uploadText(media, 'bulk2.txt', 'b');
      const f3 = await uploadText(media, 'bulk3.txt', 'c');

      expect(driver.size).toBe(3);

      const ids = [(f1 as any)._id.toString(), (f2 as any)._id.toString(), (f3 as any)._id.toString()];
      const result = await media.deleteMany(ids);

      expect(result.success).toHaveLength(3);
      expect(result.failed).toHaveLength(0);
      expect(driver.size).toBe(0);
    });

    it('should report not-found IDs in failed array without blocking others', async () => {
      const driver = new MemoryStorageDriver();
      const media = createMedia({
        driver,
        processing: { enabled: false },
        suppressWarnings: true,
      });
      const Media = mongoose.model('Test', media.schema);
      media.init(Media);

      const f1 = await uploadText(media, 'real.txt', 'data');
      const fakeId = new mongoose.Types.ObjectId().toString();

      const result = await media.deleteMany([
        (f1 as any)._id.toString(),
        fakeId,
      ]);

      expect(result.success).toHaveLength(1);
      expect(result.failed).toHaveLength(1);
      expect(result.failed[0]!.reason).toMatch(/not found/i);

      // Real file cleaned up
      expect(await driver.exists(f1.key)).toBe(false);
    });

    it('should delete variants from storage for each file in bulk delete', async () => {
      const driver = new MemoryStorageDriver();
      const media = createMedia({
        driver,
        processing: { enabled: false },
        suppressWarnings: true,
      });
      const Media = mongoose.model('Test', media.schema);
      media.init(Media);

      const f1 = await uploadText(media, 'a.txt', 'a', 'folder');
      const f2 = await uploadText(media, 'b.txt', 'b', 'folder');

      await injectVariants('Test', (f1 as any)._id.toString(), [
        { name: 'thumb', key: 'folder/a-thumb.jpg' },
      ], driver);
      await injectVariants('Test', (f2 as any)._id.toString(), [
        { name: 'thumb', key: 'folder/b-thumb.jpg' },
        { name: 'medium', key: 'folder/b-medium.jpg' },
      ], driver);

      // 2 main + 3 variants = 5
      expect(driver.size).toBe(5);

      await media.deleteMany([
        (f1 as any)._id.toString(),
        (f2 as any)._id.toString(),
      ]);

      expect(driver.size).toBe(0);
    });
  });

  // =================================================================
  // 4. Soft-delete → purge lifecycle with variants
  // =================================================================

  describe('soft-delete → purge with variants', () => {
    it('should keep storage files during soft-delete, remove on purge', async () => {
      const driver = new MemoryStorageDriver();
      const media = createMedia({
        driver,
        processing: { enabled: false },
        softDelete: { enabled: true, ttlDays: 0 },
        suppressWarnings: true,
      });
      const Media = mongoose.model('Test', media.schema);
      media.init(Media);

      const file = await uploadText(media, 'soft.txt', 'data');
      const id = (file as any)._id.toString();

      await injectVariants('Test', id, [
        { name: 'thumb', key: 'general/soft-thumb.jpg' },
      ], driver);

      // 1 main + 1 variant = 2
      expect(driver.size).toBe(2);

      // Soft-delete: files stay
      await media.softDelete(id);
      expect(driver.size).toBe(2);
      expect(await driver.exists(file.key)).toBe(true);
      expect(await driver.exists('general/soft-thumb.jpg')).toBe(true);

      // Purge: everything gone
      const futureDate = new Date(Date.now() + 60_000);
      const purged = await media.purgeDeleted(futureDate);

      expect(purged).toBe(1);
      expect(driver.size).toBe(0);
      expect(await driver.exists(file.key)).toBe(false);
      expect(await driver.exists('general/soft-thumb.jpg')).toBe(false);
    });

    it('should only purge files older than cutoff, leave recent soft-deletes', async () => {
      const driver = new MemoryStorageDriver();
      const media = createMedia({
        driver,
        processing: { enabled: false },
        softDelete: { enabled: true, ttlDays: 30 },
        suppressWarnings: true,
      });
      const Media = mongoose.model('Test', media.schema);
      media.init(Media);

      const f1 = await uploadText(media, 'old.txt', 'old');
      const f2 = await uploadText(media, 'new.txt', 'new');

      await media.softDelete((f1 as any)._id.toString());
      await media.softDelete((f2 as any)._id.toString());

      // Purge with a cutoff far in the past — both were just soft-deleted
      // so neither qualifies (deletedAt is NOT less than cutoff)
      const longAgo = new Date('2020-01-01');
      const purged = await media.purgeDeleted(longAgo);

      expect(purged).toBe(0);
      // Both still in storage
      expect(driver.size).toBe(2);
    });

    it('should purge with storage failure resilience — DB still cleaned', async () => {
      const driver = new MemoryStorageDriver();
      const media = createMedia({
        driver,
        processing: { enabled: false },
        softDelete: { enabled: true, ttlDays: 0 },
        suppressWarnings: true,
      });
      const Media = mongoose.model('Test', media.schema);
      media.init(Media);

      const file = await uploadText(media, 'purge-fail.txt');
      const id = (file as any)._id.toString();

      await media.softDelete(id);

      // Make storage delete fail
      vi.spyOn(driver, 'delete').mockRejectedValue(new Error('S3 down'));

      const futureDate = new Date(Date.now() + 60_000);
      const purged = await media.purgeDeleted(futureDate);

      expect(purged).toBe(1);

      // DB record is gone even though storage failed
      const allDocs = await media.getAll(
        { page: 1, limit: 10 },
        { includeTrashed: true },
      );
      expect(allDocs.docs).toHaveLength(0);

      vi.restoreAllMocks();
    });
  });

  // =================================================================
  // 5. Replace cleanup
  // =================================================================

  describe('replace cleanup', () => {
    it('should delete old main file + old variants after successful replace', async () => {
      const driver = new MemoryStorageDriver();
      const media = createMedia({
        driver,
        processing: { enabled: false },
        suppressWarnings: true,
      });
      const Media = mongoose.model('Test', media.schema);
      media.init(Media);

      const original = await uploadText(media, 'original.txt', 'v1', 'docs');
      const id = (original as any)._id.toString();
      const oldKey = original.key;

      await injectVariants('Test', id, [
        { name: 'thumb', key: 'docs/original-thumb.jpg' },
        { name: '__original', key: 'docs/original-orig.jpg' },
      ], driver);

      // 1 main + 2 variants = 3
      expect(driver.size).toBe(3);

      const replaced = await media.replace(id, {
        buffer: Buffer.from('v2 content'),
        filename: 'replaced.txt',
        mimeType: 'text/plain',
      });

      // Old files all gone
      expect(await driver.exists(oldKey)).toBe(false);
      expect(await driver.exists('docs/original-thumb.jpg')).toBe(false);
      expect(await driver.exists('docs/original-orig.jpg')).toBe(false);

      // New file exists
      expect(await driver.exists(replaced.key)).toBe(true);

      // Only 1 file left (new main, no variants since processing disabled)
      expect(driver.size).toBe(1);
    });

    it('should preserve old files if new write fails (write-before-delete safety)', async () => {
      const driver = new MemoryStorageDriver();
      const media = createMedia({
        driver,
        processing: { enabled: false },
        suppressWarnings: true,
      });
      const Media = mongoose.model('Test', media.schema);
      media.init(Media);

      const original = await uploadText(media, 'safe.txt', 'original data');
      const id = (original as any)._id.toString();
      const oldKey = original.key;

      // Make write fail (new file can't be stored)
      vi.spyOn(driver, 'write').mockRejectedValue(new Error('Disk full'));

      await expect(
        media.replace(id, {
          buffer: Buffer.from('new data'),
          filename: 'new.txt',
          mimeType: 'text/plain',
        }),
      ).rejects.toThrow('Disk full');

      // Old file is still intact
      expect(await driver.exists(oldKey)).toBe(true);

      vi.restoreAllMocks();
    });

    it('should clean up new orphan variants if replace DB update fails', async () => {
      const driver = new MemoryStorageDriver();
      const media = createMedia({
        driver,
        processing: { enabled: false },
        suppressWarnings: true,
      });
      const Media = mongoose.model('Test', media.schema);
      media.init(Media);

      // Inject mock processor that produces a variant
      const mockProcessor = {
        process: vi.fn().mockImplementation(async (buf: Buffer) => ({
          buffer: buf,
          mimeType: 'image/png',
          width: 100,
          height: 100,
        })),
        generateVariants: vi.fn().mockImplementation(async (buf: Buffer) => [{
          buffer: Buffer.from('thumb-data'),
          mimeType: 'image/png',
          width: 50,
          height: 50,
        }]),
        getDimensions: vi.fn().mockResolvedValue({ width: 100, height: 100 }),
      };

      const original = await media.upload({
        buffer: Buffer.from('original image'),
        filename: 'photo.png',
        mimeType: 'image/png',
        folder: 'test',
      });

      const id = (original as any)._id.toString();

      // Set up processor + sizes for replacement
      (media as any).processor = mockProcessor;
      (media as any).config.processing = {
        enabled: true,
        keepOriginal: false,
        sizes: [{ name: 'thumb', width: 50 }],
      };

      // Spy on write to track what gets written
      const writtenKeys: string[] = [];
      const originalWrite = driver.write.bind(driver);
      let writeCallCount = 0;
      vi.spyOn(driver, 'write').mockImplementation(async (key, data, ct) => {
        writeCallCount++;
        writtenKeys.push(key);
        // Fail on the 2nd write (main file write after variant)
        if (writeCallCount === 2) {
          throw new Error('Write failed during replace');
        }
        return originalWrite(key, data, ct);
      });

      await expect(
        media.replace(id, {
          buffer: Buffer.from('new image'),
          filename: 'photo-v2.png',
          mimeType: 'image/png',
        }),
      ).rejects.toThrow('Write failed during replace');

      // The variant that was written before the failure should be cleaned up
      // (orphan cleanup in the catch block)
      for (const key of writtenKeys.slice(0, 1)) {
        // First written key (variant) should have been cleaned up
        expect(await driver.exists(key)).toBe(false);
      }

      vi.restoreAllMocks();
    });
  });

  // =================================================================
  // 6. Upload failure cleanup
  // =================================================================

  describe('upload failure cleanup', () => {
    it('should clean up variant files if main write fails', async () => {
      const driver = new MemoryStorageDriver();
      const media = createMedia({
        driver,
        processing: { enabled: false },
        suppressWarnings: true,
      });
      const Media = mongoose.model('Test', media.schema);
      media.init(Media);

      const mockProcessor = {
        process: vi.fn().mockImplementation(async (buf: Buffer) => ({
          buffer: buf,
          mimeType: 'image/png',
          width: 800,
          height: 600,
        })),
        generateVariants: vi.fn().mockImplementation(async () => [{
          buffer: Buffer.from('thumb'),
          mimeType: 'image/png',
          width: 100,
          height: 75,
        }]),
        getDimensions: vi.fn().mockResolvedValue({ width: 800, height: 600 }),
      };

      (media as any).processor = mockProcessor;
      (media as any).config.processing = {
        enabled: true,
        keepOriginal: false,
        sizes: [{ name: 'thumb', width: 100 }],
      };

      let writeCount = 0;
      const originalWrite = driver.write.bind(driver);
      vi.spyOn(driver, 'write').mockImplementation(async (key, data, ct) => {
        writeCount++;
        if (writeCount === 2) {
          // Fail on main file write (after variant)
          throw new Error('Simulated write failure');
        }
        return originalWrite(key, data, ct);
      });

      await expect(
        media.upload({
          buffer: Buffer.from('fake png'),
          filename: 'photo.png',
          mimeType: 'image/png',
          folder: 'test',
        }),
      ).rejects.toThrow('Simulated write failure');

      // Variant should have been cleaned up (not orphaned)
      expect(driver.size).toBe(0);

      vi.restoreAllMocks();
    });

    it('should set media status to error on upload failure', async () => {
      const driver = new MemoryStorageDriver();
      const media = createMedia({
        driver,
        processing: { enabled: false },
        suppressWarnings: true,
      });
      const Media = mongoose.model('Test', media.schema);
      media.init(Media);

      // Fail on the storage write
      vi.spyOn(driver, 'write').mockRejectedValue(new Error('Storage down'));

      await expect(
        media.upload({
          buffer: Buffer.from('data'),
          filename: 'fail.txt',
          mimeType: 'text/plain',
          folder: 'test',
        }),
      ).rejects.toThrow('Storage down');

      // The pending record should be updated to 'error' status
      const allDocs = await Media.find({}).lean();
      expect(allDocs).toHaveLength(1);
      expect(allDocs[0]!.status).toBe('error');
      expect(allDocs[0]!.errorMessage).toBe('Storage down');

      vi.restoreAllMocks();
    });
  });

  // =================================================================
  // 7. Real Sharp processing + delete cleanup
  // =================================================================

  describe('real image processing + delete', () => {
    let testImageBuffer: Buffer;

    beforeAll(() => {
      testImageBuffer = fs.readFileSync(path.join(__dirname, 'test-img.jpg'));
    });

    it('should delete processed main file from storage on hard delete', async () => {
      const driver = new MemoryStorageDriver();
      const media = createMedia({
        driver,
        processing: {
          enabled: true,
          format: 'webp',
          maxWidth: 200,
          keepOriginal: false,
        },
        suppressWarnings: true,
      });
      const Media = mongoose.model('Test', media.schema);
      media.init(Media);

      const uploaded = await media.upload({
        buffer: testImageBuffer,
        filename: 'photo.jpg',
        mimeType: 'image/jpeg',
        folder: 'gallery',
      });

      const id = (uploaded as any)._id.toString();
      expect(uploaded.status).toBe('ready');
      expect(await driver.exists(uploaded.key)).toBe(true);

      await media.delete(id);

      expect(await driver.exists(uploaded.key)).toBe(false);
      expect(driver.size).toBe(0);
    });

    it('should delete __original variant + processed file on hard delete (keepOriginal)', async () => {
      const driver = new MemoryStorageDriver();
      const media = createMedia({
        driver,
        processing: {
          enabled: true,
          format: 'webp',
          maxWidth: 200,
          keepOriginal: true,
        },
        suppressWarnings: true,
      });
      const Media = mongoose.model('Test', media.schema);
      media.init(Media);

      const uploaded = await media.upload({
        buffer: testImageBuffer,
        filename: 'photo.jpg',
        mimeType: 'image/jpeg',
        folder: 'gallery',
      });

      const id = (uploaded as any)._id.toString();

      // Should have __original variant
      expect(uploaded.variants.length).toBeGreaterThanOrEqual(1);
      const originalVariant = uploaded.variants.find((v: any) => v.name === '__original');
      expect(originalVariant).toBeDefined();

      // Both main + __original exist in storage
      expect(await driver.exists(uploaded.key)).toBe(true);
      expect(await driver.exists(originalVariant!.key)).toBe(true);

      await media.delete(id);

      // Both gone
      expect(await driver.exists(uploaded.key)).toBe(false);
      expect(await driver.exists(originalVariant!.key)).toBe(false);
      expect(driver.size).toBe(0);
    });

    it('should delete processed file + size variants on hard delete', async () => {
      const driver = new MemoryStorageDriver();
      const media = createMedia({
        driver,
        processing: {
          enabled: true,
          format: 'webp',
          maxWidth: 400,
          keepOriginal: false,
          sizes: [
            { name: 'thumb', width: 50 },
            { name: 'small', width: 100 },
          ],
        },
        suppressWarnings: true,
      });
      const Media = mongoose.model('Test', media.schema);
      media.init(Media);

      const uploaded = await media.upload({
        buffer: testImageBuffer,
        filename: 'photo.jpg',
        mimeType: 'image/jpeg',
        folder: 'gallery',
      });

      const id = (uploaded as any)._id.toString();

      // Should have 2 size variants
      expect(uploaded.variants.length).toBe(2);
      const allKeys = [uploaded.key, ...uploaded.variants.map((v: any) => v.key)];

      // All 3 files (main + 2 variants) exist
      for (const key of allKeys) {
        expect(await driver.exists(key)).toBe(true);
      }

      await media.delete(id);

      // All gone
      for (const key of allKeys) {
        expect(await driver.exists(key)).toBe(false);
      }
      expect(driver.size).toBe(0);
    });

    it('should delete processed file + __original + size variants on hard delete', async () => {
      const driver = new MemoryStorageDriver();
      const media = createMedia({
        driver,
        processing: {
          enabled: true,
          format: 'webp',
          maxWidth: 400,
          keepOriginal: true,
          sizes: [
            { name: 'thumb', width: 50 },
          ],
        },
        suppressWarnings: true,
      });
      const Media = mongoose.model('Test', media.schema);
      media.init(Media);

      const uploaded = await media.upload({
        buffer: testImageBuffer,
        filename: 'photo.jpg',
        mimeType: 'image/jpeg',
        folder: 'gallery',
      });

      const id = (uploaded as any)._id.toString();

      // Should have __original + thumb = 2 variants
      expect(uploaded.variants.length).toBe(2);
      const variantNames = uploaded.variants.map((v: any) => v.name).sort();
      expect(variantNames).toEqual(['__original', 'thumb']);

      const totalFiles = 1 + uploaded.variants.length; // main + variants
      expect(driver.size).toBe(totalFiles);

      await media.delete(id);

      expect(driver.size).toBe(0);
    });

    it('should soft-delete then purge processed file with all variants', async () => {
      const driver = new MemoryStorageDriver();
      const media = createMedia({
        driver,
        processing: {
          enabled: true,
          format: 'webp',
          maxWidth: 300,
          keepOriginal: true,
          sizes: [{ name: 'thumb', width: 50 }],
        },
        softDelete: { enabled: true, ttlDays: 0 },
        suppressWarnings: true,
      });
      const Media = mongoose.model('Test', media.schema);
      media.init(Media);

      const uploaded = await media.upload({
        buffer: testImageBuffer,
        filename: 'photo.jpg',
        mimeType: 'image/jpeg',
        folder: 'gallery',
      });

      const id = (uploaded as any)._id.toString();
      const initialSize = driver.size; // main + __original + thumb

      // Soft-delete: all files stay
      await media.softDelete(id);
      expect(driver.size).toBe(initialSize);

      // Purge: everything cleaned
      const futureDate = new Date(Date.now() + 60_000);
      const purged = await media.purgeDeleted(futureDate);

      expect(purged).toBe(1);
      expect(driver.size).toBe(0);
    });

    it('should replace a processed image and clean old processed + variants', async () => {
      const driver = new MemoryStorageDriver();
      const media = createMedia({
        driver,
        processing: {
          enabled: true,
          format: 'webp',
          maxWidth: 200,
          keepOriginal: true,
          sizes: [{ name: 'thumb', width: 50 }],
        },
        suppressWarnings: true,
      });
      const Media = mongoose.model('Test', media.schema);
      media.init(Media);

      const original = await media.upload({
        buffer: testImageBuffer,
        filename: 'photo.jpg',
        mimeType: 'image/jpeg',
        folder: 'gallery',
      });

      const originalId = (original as any)._id.toString();
      const oldKeys = [original.key, ...original.variants.map((v: any) => v.key)];

      // Replace with a new image
      const replaced = await media.replace(originalId, {
        buffer: testImageBuffer,
        filename: 'photo-v2.jpg',
        mimeType: 'image/jpeg',
      });

      // Same document ID
      expect((replaced as any)._id.toString()).toBe(originalId);

      // Old keys are all gone
      for (const key of oldKeys) {
        expect(await driver.exists(key)).toBe(false);
      }

      // New keys exist
      expect(await driver.exists(replaced.key)).toBe(true);
      for (const v of replaced.variants) {
        expect(await driver.exists((v as any).key)).toBe(true);
      }
    });
  });

  // =================================================================
  // 8. originalHandling modes — cleanup verification
  // =================================================================

  describe('originalHandling modes + delete', () => {
    let testImageBuffer: Buffer;

    beforeAll(() => {
      testImageBuffer = fs.readFileSync(path.join(__dirname, 'test-img.jpg'));
    });

    it('originalHandling: keep-variant — __original variant cleaned on delete', async () => {
      const driver = new MemoryStorageDriver();
      const media = createMedia({
        driver,
        processing: {
          enabled: true,
          format: 'webp',
          maxWidth: 200,
          originalHandling: 'keep-variant',
        },
        suppressWarnings: true,
      });
      const Media = mongoose.model('Test', media.schema);
      media.init(Media);

      const uploaded = await media.upload({
        buffer: testImageBuffer,
        filename: 'photo.jpg',
        mimeType: 'image/jpeg',
        folder: 'test',
      });

      const id = (uploaded as any)._id.toString();
      const origVariant = uploaded.variants.find((v: any) => v.name === '__original');
      expect(origVariant).toBeDefined();

      await media.delete(id);
      expect(driver.size).toBe(0);
    });

    it('originalHandling: discard — no __original variant created, clean delete', async () => {
      const driver = new MemoryStorageDriver();
      const media = createMedia({
        driver,
        processing: {
          enabled: true,
          format: 'webp',
          maxWidth: 200,
          originalHandling: 'discard',
        },
        suppressWarnings: true,
      });
      const Media = mongoose.model('Test', media.schema);
      media.init(Media);

      const uploaded = await media.upload({
        buffer: testImageBuffer,
        filename: 'photo.jpg',
        mimeType: 'image/jpeg',
        folder: 'test',
      });

      const id = (uploaded as any)._id.toString();
      const origVariant = uploaded.variants.find((v: any) => v.name === '__original');
      expect(origVariant).toBeUndefined();

      // Only 1 file in storage (processed main)
      expect(driver.size).toBe(1);

      await media.delete(id);
      expect(driver.size).toBe(0);
    });

    it('originalHandling: replace — no __original variant, clean delete', async () => {
      const driver = new MemoryStorageDriver();
      const media = createMedia({
        driver,
        processing: {
          enabled: true,
          format: 'webp',
          maxWidth: 200,
          originalHandling: 'replace',
        },
        suppressWarnings: true,
      });
      const Media = mongoose.model('Test', media.schema);
      media.init(Media);

      const uploaded = await media.upload({
        buffer: testImageBuffer,
        filename: 'photo.jpg',
        mimeType: 'image/jpeg',
        folder: 'test',
      });

      const id = (uploaded as any)._id.toString();
      const origVariant = uploaded.variants.find((v: any) => v.name === '__original');
      expect(origVariant).toBeUndefined();

      expect(driver.size).toBe(1);
      await media.delete(id);
      expect(driver.size).toBe(0);
    });
  });

  // =================================================================
  // 9. Processing presets + delete
  // =================================================================

  describe('processing presets + delete cleanup', () => {
    let testImageBuffer: Buffer;

    beforeAll(() => {
      testImageBuffer = fs.readFileSync(path.join(__dirname, 'test-img.jpg'));
    });

    it('social-media preset — all generated variants cleaned on delete', async () => {
      const driver = new MemoryStorageDriver();
      const media = createMedia({
        driver,
        processing: {
          enabled: true,
          preset: 'social-media',
        },
        suppressWarnings: true,
      });
      const Media = mongoose.model('Test', media.schema);
      media.init(Media);

      const uploaded = await media.upload({
        buffer: testImageBuffer,
        filename: 'social.jpg',
        mimeType: 'image/jpeg',
        folder: 'posts',
      });

      const id = (uploaded as any)._id.toString();
      const totalFiles = 1 + uploaded.variants.length;

      // social-media preset generates thumb, small, medium variants
      expect(uploaded.variants.length).toBeGreaterThanOrEqual(1);
      expect(driver.size).toBe(totalFiles);

      await media.delete(id);
      expect(driver.size).toBe(0);
    });

    it('thumbnail preset — discard original, clean delete', async () => {
      const driver = new MemoryStorageDriver();
      const media = createMedia({
        driver,
        processing: {
          enabled: true,
          preset: 'thumbnail',
        },
        suppressWarnings: true,
      });
      const Media = mongoose.model('Test', media.schema);
      media.init(Media);

      const uploaded = await media.upload({
        buffer: testImageBuffer,
        filename: 'thumb.jpg',
        mimeType: 'image/jpeg',
        folder: 'thumbs',
      });

      const id = (uploaded as any)._id.toString();

      // thumbnail preset has keepOriginal: false
      const origVariant = uploaded.variants.find((v: any) => v.name === '__original');
      expect(origVariant).toBeUndefined();

      await media.delete(id);
      expect(driver.size).toBe(0);
    });
  });

  // =================================================================
  // 10. Delete idempotency and edge cases
  // =================================================================

  describe('edge cases', () => {
    it('should handle deleting the same ID twice gracefully', async () => {
      const driver = new MemoryStorageDriver();
      const media = createMedia({
        driver,
        processing: { enabled: false },
        suppressWarnings: true,
      });
      const Media = mongoose.model('Test', media.schema);
      media.init(Media);

      const file = await uploadText(media, 'once.txt');
      const id = (file as any)._id.toString();

      const first = await media.delete(id);
      expect(first).toBe(true);

      const second = await media.delete(id);
      expect(second).toBe(false);
    });

    it('should handle deleteMany with empty array', async () => {
      const driver = new MemoryStorageDriver();
      const media = createMedia({
        driver,
        processing: { enabled: false },
        suppressWarnings: true,
      });
      const Media = mongoose.model('Test', media.schema);
      media.init(Media);

      const result = await media.deleteMany([]);
      expect(result.success).toHaveLength(0);
      expect(result.failed).toHaveLength(0);
    });

    it('should handle delete of file with empty variants array', async () => {
      const driver = new MemoryStorageDriver();
      const media = createMedia({
        driver,
        processing: { enabled: false },
        suppressWarnings: true,
      });
      const Media = mongoose.model('Test', media.schema);
      media.init(Media);

      const file = await uploadText(media, 'no-variants.txt');
      expect(file.variants).toEqual([]);

      const deleted = await media.delete((file as any)._id.toString());
      expect(deleted).toBe(true);
      expect(driver.size).toBe(0);
    });

    it('should clean up storage even when file has many variants', async () => {
      const driver = new MemoryStorageDriver();
      const media = createMedia({
        driver,
        processing: { enabled: false },
        suppressWarnings: true,
      });
      const Media = mongoose.model('Test', media.schema);
      media.init(Media);

      const file = await uploadText(media, 'many.txt', 'data', 'multi');
      const id = (file as any)._id.toString();

      // Inject 10 variants
      const variants = Array.from({ length: 10 }, (_, i) => ({
        name: `variant-${i}`,
        key: `multi/v${i}.jpg`,
      }));
      await injectVariants('Test', id, variants, driver);

      // 1 main + 10 variants = 11
      expect(driver.size).toBe(11);

      await media.delete(id);
      expect(driver.size).toBe(0);
    });
  });
});
