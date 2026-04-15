/**
 * Integration tests — folder domain verbs
 *
 * Covers: getFolderTree, getFolderStats, getBreadcrumb,
 * deleteFolder, renameFolder, getSubfolders, move.
 */

import { describe, it, expect, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { createTestEngine, teardownTestMongo, type TestEngineHandle } from '../helpers/create-test-engine.js';
import { MEDIA_EVENTS } from '../../src/events/event-constants.js';

const BUF = (s: string) => Buffer.from(s, 'utf-8');

describe('MediaRepository — folder operations', () => {
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

  async function seed(): Promise<void> {
    for (const f of [
      { folder: 'products', name: 'p1.jpg' },
      { folder: 'products', name: 'p2.jpg' },
      { folder: 'products/featured', name: 'f1.jpg' },
      { folder: 'avatars', name: 'a1.jpg' },
    ]) {
      await handle.engine.repositories.media.upload({
        buffer: BUF(f.name),
        filename: f.name,
        mimeType: 'image/jpeg',
        folder: f.folder,
      });
    }
  }

  describe('getFolderTree()', () => {
    it('returns tree with file counts and sizes', async () => {
      await seed();
      const tree = await handle.engine.repositories.media.getFolderTree();
      expect(tree.folders.length).toBeGreaterThan(0);
      expect(tree.meta.totalFiles).toBe(4);
      expect(tree.meta.totalSize).toBeGreaterThan(0);
    });
  });

  describe('getFolderStats()', () => {
    it('returns stats for a specific folder', async () => {
      await seed();
      const stats = await handle.engine.repositories.media.getFolderStats('products');
      expect(stats.totalFiles).toBe(3); // products + products/featured
      expect(stats.totalSize).toBeGreaterThan(0);
      expect(stats.mimeTypes).toContain('image/jpeg');
    });

    it('returns zeros for empty folder', async () => {
      const stats = await handle.engine.repositories.media.getFolderStats('empty');
      expect(stats.totalFiles).toBe(0);
      expect(stats.totalSize).toBe(0);
    });
  });

  describe('getBreadcrumb()', () => {
    it('returns path breakdown', () => {
      const crumbs = handle.engine.repositories.media.getBreadcrumb('products/featured/hero');
      expect(crumbs).toHaveLength(3);
      expect(crumbs[0]).toEqual({ name: 'products', path: 'products' });
      expect(crumbs[1]).toEqual({ name: 'featured', path: 'products/featured' });
      expect(crumbs[2]).toEqual({ name: 'hero', path: 'products/featured/hero' });
    });
  });

  describe('move()', () => {
    it('moves files to a new folder with key rewrite', async () => {
      const media = await handle.engine.repositories.media.upload({
        buffer: BUF('x'), filename: 'x.txt', mimeType: 'text/plain', folder: 'source',
      });
      const originalKey = media.key;

      const result = await handle.engine.repositories.media.move([String(media._id)], 'dest');
      expect(result.modifiedCount).toBe(1);

      const updated = await handle.engine.models.Media.findById(media._id);
      expect(updated!.folder).toBe('dest');
      expect(updated!.key).toContain('dest/');
      expect(await handle.driver.exists(originalKey)).toBe(false);
      expect(await handle.driver.exists(updated!.key)).toBe(true);
    });

    it('publishes media:asset.moved event', async () => {
      const handler = vi.fn();
      await handle.engine.events.subscribe(MEDIA_EVENTS.ASSET_MOVED, handler);
      const media = await handle.engine.repositories.media.upload({
        buffer: BUF('x'), filename: 'x.txt', mimeType: 'text/plain', folder: 'a',
      });
      await handle.engine.repositories.media.move([String(media._id)], 'b');
      expect(handler).toHaveBeenCalledTimes(1);
    });
  });

  describe('deleteFolder()', () => {
    it('deletes all files in a folder', async () => {
      await seed();
      const result = await handle.engine.repositories.media.deleteFolder('products');
      // products + products/featured = 3 files
      expect(result.success).toHaveLength(3);

      const remaining = await handle.engine.models.Media.countDocuments({});
      expect(remaining).toBe(1); // only 'avatars' left
    });

    it('publishes media:folder.deleted event', async () => {
      await seed();
      const handler = vi.fn();
      await handle.engine.events.subscribe(MEDIA_EVENTS.FOLDER_DELETED, handler);
      await handle.engine.repositories.media.deleteFolder('products');
      expect(handler).toHaveBeenCalledTimes(1);
    });
  });
});
