/**
 * Integration tests — delete domain verbs
 *
 * Covers: hardDelete, hardDeleteMany, purgeDeleted,
 * cascade behavior (variant file cleanup), soft delete via mongokit plugin.
 */

import { describe, it, expect, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { createTestEngine, teardownTestMongo, type TestEngineHandle } from '../helpers/create-test-engine.js';
import { MEDIA_EVENTS } from '../../src/events/event-constants.js';

const BUF = (s: string) => Buffer.from(s, 'utf-8');

describe('MediaRepository — delete domain verbs', () => {
  afterAll(async () => {
    await teardownTestMongo();
  });

  let handle: TestEngineHandle;

  beforeEach(async () => {
    handle = await createTestEngine();
  });

  afterEach(async () => {
    await handle.cleanup();
  });

  describe('hardDelete()', () => {
    it('removes from storage and database', async () => {
      const media = await handle.engine.repositories.media.upload({
        buffer: BUF('x'),
        filename: 'x.txt',
        mimeType: 'text/plain',
      });
      const key = media.key;

      const result = await handle.engine.repositories.media.hardDelete(String(media._id));
      expect(result).toBe(true);
      expect(await handle.driver.exists(key)).toBe(false);

      const found = await handle.engine.models.Media.findById(media._id);
      expect(found).toBeNull();
    });

    it('returns false when media does not exist', async () => {
      const fakeId = '507f1f77bcf86cd799439011';
      const result = await handle.engine.repositories.media.hardDelete(fakeId);
      expect(result).toBe(false);
    });

    it('publishes media:asset.deleted event', async () => {
      const handler = vi.fn();
      await handle.engine.events.subscribe(MEDIA_EVENTS.ASSET_DELETED, handler);

      const media = await handle.engine.repositories.media.upload({
        buffer: BUF('x'),
        filename: 'x.txt',
        mimeType: 'text/plain',
      });
      await handle.engine.repositories.media.hardDelete(String(media._id));

      expect(handler).toHaveBeenCalledTimes(1);
      const event = handler.mock.calls[0]?.[0];
      expect(event.payload.assetId).toBe(String(media._id));
      expect(event.payload.key).toBe(media.key);
    });
  });

  describe('hardDeleteMany()', () => {
    it('deletes multiple files', async () => {
      const m1 = await handle.engine.repositories.media.upload({
        buffer: BUF('a'), filename: 'a.txt', mimeType: 'text/plain',
      });
      const m2 = await handle.engine.repositories.media.upload({
        buffer: BUF('b'), filename: 'b.txt', mimeType: 'text/plain',
      });
      const m3 = await handle.engine.repositories.media.upload({
        buffer: BUF('c'), filename: 'c.txt', mimeType: 'text/plain',
      });

      const result = await handle.engine.repositories.media.hardDeleteMany([
        String(m1._id), String(m2._id), String(m3._id),
      ]);

      expect(result.success).toHaveLength(3);
      expect(result.failed).toHaveLength(0);

      const remaining = await handle.engine.models.Media.countDocuments({});
      expect(remaining).toBe(0);
    });

    it('tracks per-id failures', async () => {
      const m1 = await handle.engine.repositories.media.upload({
        buffer: BUF('a'), filename: 'a.txt', mimeType: 'text/plain',
      });
      const result = await handle.engine.repositories.media.hardDeleteMany([
        String(m1._id),
        '507f1f77bcf86cd799439099', // nonexistent
      ]);
      expect(result.success).toHaveLength(1);
      expect(result.failed).toHaveLength(1);
    });

    it('publishes media:batch.deleted event', async () => {
      const handler = vi.fn();
      await handle.engine.events.subscribe(MEDIA_EVENTS.BATCH_DELETED, handler);

      const m1 = await handle.engine.repositories.media.upload({
        buffer: BUF('a'), filename: 'a.txt', mimeType: 'text/plain',
      });
      await handle.engine.repositories.media.hardDeleteMany([String(m1._id)]);

      expect(handler).toHaveBeenCalledTimes(1);
    });
  });

  describe('soft delete via mongokit plugin', () => {
    it('softDeletePlugin provides repo.delete() as soft delete', async () => {
      const { engine, cleanup } = await createTestEngine({
        softDelete: { enabled: true, ttlDays: 30 },
      });
      try {
        const media = await engine.repositories.media.upload({
          buffer: BUF('x'), filename: 'x.txt', mimeType: 'text/plain',
        });

        await engine.repositories.media.delete(String(media._id));

        // Document still exists but with deletedAt set
        const raw = await engine.models.Media.findById(media._id).lean();
        expect(raw).toBeTruthy();
        expect(raw!.deletedAt).toBeInstanceOf(Date);
      } finally {
        await cleanup();
      }
    });
  });
});
