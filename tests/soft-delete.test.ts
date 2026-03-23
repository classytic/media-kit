/**
 * Soft Delete Integration Tests
 *
 * Tests the soft delete feature: softDelete, restore, query exclusion,
 * purgeDeleted, and related events.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { createMedia } from '../src/media';
import { MemoryStorageDriver } from './helpers/memory-driver';
import type { MediaKit } from '../src/types';

const MONGO_URI = 'mongodb://localhost:27017/mediakit-soft-delete-test';

/** Helper: upload a simple text file and return the document */
async function uploadFile(
  media: MediaKit,
  filename = 'test-file.txt',
  content = 'file content'
) {
  return media.upload({
    buffer: Buffer.from(content),
    filename,
    mimeType: 'text/plain',
    folder: 'general',
  });
}

describe('Soft Delete', () => {
  beforeAll(async () => {
    await mongoose.connect(MONGO_URI);
  });

  afterAll(async () => {
    await mongoose.disconnect();
  });

  beforeEach(async () => {
    // Drop all documents for test isolation
    const collections = await mongoose.connection.db?.collections();
    if (collections) {
      for (const collection of collections) {
        await collection.deleteMany({});
      }
    }

    // Remove all registered models to avoid Mongoose recompilation errors
    Object.keys(mongoose.models).forEach((key) => {
      delete mongoose.models[key];
    });
  });

  // =================================================================
  // 1. softDelete(id)
  // =================================================================

  describe('softDelete(id)', () => {
    it('should set deletedAt to a Date after soft-deleting a file', async () => {
      const driver = new MemoryStorageDriver();
      const media = createMedia({
        driver,
        processing: { enabled: false },
        suppressWarnings: true,
      });
      const Media = mongoose.model('Test', media.schema);
      media.init(Media);

      const uploaded = await uploadFile(media);
      const id = (uploaded as any)._id.toString();

      const softDeleted = await media.softDelete(id);

      expect(softDeleted.deletedAt).toBeInstanceOf(Date);
      expect(softDeleted.deletedAt).not.toBeNull();
    });

    it('should exclude a soft-deleted file from getById results', async () => {
      const driver = new MemoryStorageDriver();
      const media = createMedia({
        driver,
        processing: { enabled: false },
        suppressWarnings: true,
      });
      const Media = mongoose.model('Test', media.schema);
      media.init(Media);

      const uploaded = await uploadFile(media);
      const id = (uploaded as any)._id.toString();

      await media.softDelete(id);

      const result = await media.getById(id);
      expect(result).toBeNull();
    });

    it('should leave the file in storage after soft-deleting', async () => {
      const driver = new MemoryStorageDriver();
      const media = createMedia({
        driver,
        processing: { enabled: false },
        suppressWarnings: true,
      });
      const Media = mongoose.model('Test', media.schema);
      media.init(Media);

      const uploaded = await uploadFile(media);
      const id = (uploaded as any)._id.toString();
      const storageKey = uploaded.key;

      await media.softDelete(id);

      // Storage should still contain the file
      const existsInStorage = await driver.exists(storageKey);
      expect(existsInStorage).toBe(true);
    });

    it('should throw when soft-deleting a nonexistent ID', async () => {
      const driver = new MemoryStorageDriver();
      const media = createMedia({
        driver,
        processing: { enabled: false },
        suppressWarnings: true,
      });
      const Media = mongoose.model('Test', media.schema);
      media.init(Media);

      const fakeId = new mongoose.Types.ObjectId().toString();

      await expect(media.softDelete(fakeId)).rejects.toThrow(/not found/i);
    });
  });

  // =================================================================
  // 2. restore(id)
  // =================================================================

  describe('restore(id)', () => {
    it('should clear deletedAt after restoring a soft-deleted file', async () => {
      const driver = new MemoryStorageDriver();
      const media = createMedia({
        driver,
        processing: { enabled: false },
        suppressWarnings: true,
      });
      const Media = mongoose.model('Test', media.schema);
      media.init(Media);

      const uploaded = await uploadFile(media);
      const id = (uploaded as any)._id.toString();

      await media.softDelete(id);
      const restored = await media.restore(id);

      expect(restored.deletedAt).toBeNull();
    });

    it('should make the file visible to getById again after restoring', async () => {
      const driver = new MemoryStorageDriver();
      const media = createMedia({
        driver,
        processing: { enabled: false },
        suppressWarnings: true,
      });
      const Media = mongoose.model('Test', media.schema);
      media.init(Media);

      const uploaded = await uploadFile(media);
      const id = (uploaded as any)._id.toString();

      await media.softDelete(id);

      // Verify it is hidden
      const hidden = await media.getById(id);
      expect(hidden).toBeNull();

      // Restore
      await media.restore(id);

      // Verify it is visible again
      const visible = await media.getById(id);
      expect(visible).not.toBeNull();
      expect((visible as any)._id.toString()).toBe(id);
    });

    it('should throw when restoring a nonexistent ID', async () => {
      const driver = new MemoryStorageDriver();
      const media = createMedia({
        driver,
        processing: { enabled: false },
        suppressWarnings: true,
      });
      const Media = mongoose.model('Test', media.schema);
      media.init(Media);

      const fakeId = new mongoose.Types.ObjectId().toString();

      await expect(media.restore(fakeId)).rejects.toThrow(/not found/i);
    });
  });

  // =================================================================
  // 3. Query exclusion
  // =================================================================

  describe('query exclusion', () => {
    it('should exclude soft-deleted files from getAll by default', async () => {
      const driver = new MemoryStorageDriver();
      const media = createMedia({
        driver,
        processing: { enabled: false },
        suppressWarnings: true,
      });
      const Media = mongoose.model('Test', media.schema);
      media.init(Media);

      const file1 = await uploadFile(media, 'file1.txt', 'content1');
      const file2 = await uploadFile(media, 'file2.txt', 'content2');
      const file3 = await uploadFile(media, 'file3.txt', 'content3');

      // Soft-delete the second file
      await media.softDelete((file2 as any)._id.toString());

      const result = await media.getAll({ page: 1, limit: 10 });

      expect(result.docs).toHaveLength(2);
      const returnedIds = result.docs.map((d: any) => d._id.toString());
      expect(returnedIds).toContain((file1 as any)._id.toString());
      expect(returnedIds).toContain((file3 as any)._id.toString());
      expect(returnedIds).not.toContain((file2 as any)._id.toString());
    });

    it('should include soft-deleted files when context.includeTrashed is true', async () => {
      const driver = new MemoryStorageDriver();
      const media = createMedia({
        driver,
        processing: { enabled: false },
        suppressWarnings: true,
      });
      const Media = mongoose.model('Test', media.schema);
      media.init(Media);

      await uploadFile(media, 'file1.txt', 'content1');
      const file2 = await uploadFile(media, 'file2.txt', 'content2');
      await uploadFile(media, 'file3.txt', 'content3');

      // Soft-delete the second file
      await media.softDelete((file2 as any)._id.toString());

      const result = await media.getAll(
        { page: 1, limit: 10 },
        { includeTrashed: true }
      );

      expect(result.docs).toHaveLength(3);
    });
  });

  // =================================================================
  // 4. purgeDeleted(olderThan?)
  // =================================================================

  describe('purgeDeleted(olderThan?)', () => {
    it('should permanently remove soft-deleted files from DB and storage', async () => {
      const driver = new MemoryStorageDriver();
      const media = createMedia({
        driver,
        processing: { enabled: false },
        suppressWarnings: true,
        softDelete: { enabled: true, ttlDays: 0 },
      });
      const Media = mongoose.model('Test', media.schema);
      media.init(Media);

      const file1 = await uploadFile(media, 'purge1.txt', 'purge-content-1');
      const file2 = await uploadFile(media, 'purge2.txt', 'purge-content-2');

      const key1 = file1.key;
      const key2 = file2.key;
      const id1 = (file1 as any)._id.toString();
      const id2 = (file2 as any)._id.toString();

      // Soft-delete both
      await media.softDelete(id1);
      await media.softDelete(id2);

      // Purge all deleted — pass a future cutoff so both are "older than"
      const futureDate = new Date(Date.now() + 60_000);
      const purgedCount = await media.purgeDeleted(futureDate);

      expect(purgedCount).toBe(2);

      // Verify gone from DB (even with includeTrashed)
      const allRemaining = await media.getAll(
        { page: 1, limit: 10 },
        { includeTrashed: true }
      );
      expect(allRemaining.docs).toHaveLength(0);

      // Verify gone from storage
      expect(await driver.exists(key1)).toBe(false);
      expect(await driver.exists(key2)).toBe(false);
    });

    it('should return the count of purged records', async () => {
      const driver = new MemoryStorageDriver();
      const media = createMedia({
        driver,
        processing: { enabled: false },
        suppressWarnings: true,
        softDelete: { enabled: true, ttlDays: 0 },
      });
      const Media = mongoose.model('Test', media.schema);
      media.init(Media);

      await uploadFile(media, 'keep.txt', 'keep-content');
      const toDelete = await uploadFile(media, 'delete-me.txt', 'delete-content');

      await media.softDelete((toDelete as any)._id.toString());

      const futureDate = new Date(Date.now() + 60_000);
      const purgedCount = await media.purgeDeleted(futureDate);

      expect(purgedCount).toBe(1);

      // The non-deleted file should remain
      const remaining = await media.getAll({ page: 1, limit: 10 });
      expect(remaining.docs).toHaveLength(1);
    });
  });

  // =================================================================
  // 5. Events
  // =================================================================

  describe('events', () => {
    it('should fire before:softDelete and after:softDelete events', async () => {
      const driver = new MemoryStorageDriver();
      const media = createMedia({
        driver,
        processing: { enabled: false },
        suppressWarnings: true,
      });
      const Media = mongoose.model('Test', media.schema);
      media.init(Media);

      const beforePayloads: unknown[] = [];
      const afterPayloads: unknown[] = [];

      media.on('before:softDelete', (payload: unknown) => {
        beforePayloads.push(payload);
      });
      media.on('after:softDelete', (payload: unknown) => {
        afterPayloads.push(payload);
      });

      const uploaded = await uploadFile(media);
      const id = (uploaded as any)._id.toString();

      await media.softDelete(id);

      expect(beforePayloads).toHaveLength(1);
      expect(afterPayloads).toHaveLength(1);

      // before event should contain the target ID
      const beforeEvent = beforePayloads[0] as any;
      expect(beforeEvent.data.id).toBe(id);
      expect(beforeEvent.timestamp).toBeInstanceOf(Date);

      // after event should contain the result document
      const afterEvent = afterPayloads[0] as any;
      expect(afterEvent.result).toBeDefined();
      expect(afterEvent.result.deletedAt).toBeInstanceOf(Date);
    });

    it('should fire before:restore and after:restore events', async () => {
      const driver = new MemoryStorageDriver();
      const media = createMedia({
        driver,
        processing: { enabled: false },
        suppressWarnings: true,
      });
      const Media = mongoose.model('Test', media.schema);
      media.init(Media);

      const beforePayloads: unknown[] = [];
      const afterPayloads: unknown[] = [];

      media.on('before:restore', (payload: unknown) => {
        beforePayloads.push(payload);
      });
      media.on('after:restore', (payload: unknown) => {
        afterPayloads.push(payload);
      });

      const uploaded = await uploadFile(media);
      const id = (uploaded as any)._id.toString();

      await media.softDelete(id);
      await media.restore(id);

      expect(beforePayloads).toHaveLength(1);
      expect(afterPayloads).toHaveLength(1);

      // before event should contain the target ID
      const beforeEvent = beforePayloads[0] as any;
      expect(beforeEvent.data.id).toBe(id);
      expect(beforeEvent.timestamp).toBeInstanceOf(Date);

      // after event should contain the restored document
      const afterEvent = afterPayloads[0] as any;
      expect(afterEvent.result).toBeDefined();
      expect(afterEvent.result.deletedAt).toBeNull();
    });
  });
});
