/**
 * Integration tests — tags + focal point domain verbs
 */

import { describe, it, expect, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { createTestEngine, teardownTestMongo, type TestEngineHandle } from '../helpers/create-test-engine.js';
import { MEDIA_EVENTS } from '../../src/events/event-constants.js';

const BUF = (s: string) => Buffer.from(s, 'utf-8');

describe('MediaRepository — tags + focalPoint', () => {
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

  describe('addTags()', () => {
    it('adds tags to a document', async () => {
      const media = await handle.engine.repositories.media.upload({
        buffer: BUF('x'), filename: 'x.jpg', mimeType: 'image/jpeg',
      });
      const updated = await handle.engine.repositories.media.addTags(String(media._id), ['hero', 'featured']);
      expect(updated.tags).toContain('hero');
      expect(updated.tags).toContain('featured');
    });

    it('does not duplicate existing tags ($addToSet)', async () => {
      const media = await handle.engine.repositories.media.upload({
        buffer: BUF('x'), filename: 'x.jpg', mimeType: 'image/jpeg', tags: ['hero'],
      });
      const updated = await handle.engine.repositories.media.addTags(String(media._id), ['hero', 'new']);
      expect(updated.tags.filter((t) => t === 'hero')).toHaveLength(1);
      expect(updated.tags).toContain('new');
    });

    it('publishes media:asset.tagged event', async () => {
      const handler = vi.fn();
      await handle.engine.events.subscribe(MEDIA_EVENTS.ASSET_TAGGED, handler);
      const media = await handle.engine.repositories.media.upload({
        buffer: BUF('x'), filename: 'x.jpg', mimeType: 'image/jpeg',
      });
      await handle.engine.repositories.media.addTags(String(media._id), ['t1']);
      expect(handler).toHaveBeenCalledTimes(1);
    });
  });

  describe('removeTags()', () => {
    it('removes specified tags', async () => {
      const media = await handle.engine.repositories.media.upload({
        buffer: BUF('x'), filename: 'x.jpg', mimeType: 'image/jpeg',
        tags: ['a', 'b', 'c'],
      });
      const updated = await handle.engine.repositories.media.removeTags(String(media._id), ['b']);
      expect(updated.tags).toEqual(['a', 'c']);
    });
  });

  describe('setFocalPoint()', () => {
    it('sets focal point coordinates', async () => {
      const media = await handle.engine.repositories.media.upload({
        buffer: BUF('x'), filename: 'x.jpg', mimeType: 'image/jpeg',
      });
      const updated = await handle.engine.repositories.media.setFocalPoint(
        String(media._id),
        { x: 0.3, y: 0.7 },
      );
      expect(updated.focalPoint).toEqual({ x: 0.3, y: 0.7 });
    });

    it('rejects out-of-range coordinates', async () => {
      const media = await handle.engine.repositories.media.upload({
        buffer: BUF('x'), filename: 'x.jpg', mimeType: 'image/jpeg',
      });
      await expect(
        handle.engine.repositories.media.setFocalPoint(String(media._id), { x: 1.5, y: 0.5 }),
      ).rejects.toThrow();
    });

    it('publishes media:asset.focalPointSet event', async () => {
      const handler = vi.fn();
      await handle.engine.events.subscribe(MEDIA_EVENTS.FOCAL_POINT_SET, handler);
      const media = await handle.engine.repositories.media.upload({
        buffer: BUF('x'), filename: 'x.jpg', mimeType: 'image/jpeg',
      });
      await handle.engine.repositories.media.setFocalPoint(String(media._id), { x: 0.5, y: 0.5 });
      expect(handler).toHaveBeenCalledTimes(1);
    });
  });
});
