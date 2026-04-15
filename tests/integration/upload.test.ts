/**
 * Integration tests — upload domain verbs
 *
 * Covers: upload, uploadMany, replace, dedup
 */

import { describe, it, expect, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { createTestEngine, teardownTestMongo, type TestEngineHandle } from '../helpers/create-test-engine.js';
import { MEDIA_EVENTS } from '../../src/events/event-constants.js';

const BUF = (s: string) => Buffer.from(s, 'utf-8');

describe('MediaRepository — upload domain verbs', () => {
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

  describe('upload()', () => {
    it('uploads a file and persists record with status "ready"', async () => {
      const media = await handle.engine.repositories.media.upload({
        buffer: BUF('hello'),
        filename: 'hello.txt',
        mimeType: 'text/plain',
        folder: 'docs',
      });

      expect(media).toBeDefined();
      expect(media.filename).toBe('hello.txt');
      expect(media.originalFilename).toBe('hello.txt');
      expect(media.mimeType).toBe('text/plain');
      expect(media.size).toBe(5);
      expect(media.folder).toBe('docs');
      expect(media.status).toBe('ready');
      expect(media.hash).toBeTruthy();
      expect(media.key).toBeTruthy();
    });

    it('writes file to storage driver', async () => {
      const media = await handle.engine.repositories.media.upload({
        buffer: BUF('data'),
        filename: 'x.txt',
        mimeType: 'text/plain',
      });
      expect(await handle.driver.exists(media.key)).toBe(true);
    });

    it('auto-generates title from filename when not provided', async () => {
      const media = await handle.engine.repositories.media.upload({
        buffer: BUF('a'),
        filename: 'my-cool-photo.jpg',
        mimeType: 'image/jpeg',
      });
      expect(media.title).toContain('my cool photo');
    });

    it('uses provided title when given', async () => {
      const media = await handle.engine.repositories.media.upload({
        buffer: BUF('a'),
        filename: 'x.jpg',
        mimeType: 'image/jpeg',
        title: 'Custom Title',
      });
      expect(media.title).toBe('Custom Title');
    });

    it('uses provided tags', async () => {
      const media = await handle.engine.repositories.media.upload({
        buffer: BUF('a'),
        filename: 'x.jpg',
        mimeType: 'image/jpeg',
        tags: ['featured', 'hero'],
      });
      expect(media.tags).toEqual(['featured', 'hero']);
    });

    it('publishes media:asset.uploaded event', async () => {
      const handler = vi.fn();
      await handle.engine.events.subscribe(MEDIA_EVENTS.ASSET_UPLOADED, handler);

      const media = await handle.engine.repositories.media.upload({
        buffer: BUF('x'),
        filename: 'x.txt',
        mimeType: 'text/plain',
      });

      expect(handler).toHaveBeenCalledTimes(1);
      const event = handler.mock.calls[0]?.[0];
      expect(event.type).toBe(MEDIA_EVENTS.ASSET_UPLOADED);
      expect(event.payload.assetId).toBe(String(media._id));
      expect(event.payload.filename).toBe('x.txt');
      expect(event.payload.hash).toBe(media.hash);
    });

    it('rejects file type not in allowlist', async () => {
      const { engine, cleanup } = await createTestEngine({
        fileTypes: { allowed: ['image/jpeg'], maxSize: 10_000 },
      });
      try {
        await expect(
          engine.repositories.media.upload({
            buffer: BUF('x'),
            filename: 'x.exe',
            mimeType: 'application/x-msdownload',
          }),
        ).rejects.toThrow(/not allowed/i);
      } finally {
        await cleanup();
      }
    });

    it('rejects file exceeding maxSize', async () => {
      const { engine, cleanup } = await createTestEngine({
        fileTypes: { allowed: ['text/plain'], maxSize: 3 },
      });
      try {
        await expect(
          engine.repositories.media.upload({
            buffer: BUF('too-long'),
            filename: 'x.txt',
            mimeType: 'text/plain',
          }),
        ).rejects.toThrow(/exceeds limit/i);
      } finally {
        await cleanup();
      }
    });
  });

  describe('uploadMany()', () => {
    it('uploads multiple files', async () => {
      const results = await handle.engine.repositories.media.uploadMany([
        { buffer: BUF('a'), filename: 'a.txt', mimeType: 'text/plain' },
        { buffer: BUF('b'), filename: 'b.txt', mimeType: 'text/plain' },
        { buffer: BUF('c'), filename: 'c.txt', mimeType: 'text/plain' },
      ]);
      expect(results).toHaveLength(3);
      expect(results.every((m) => m.status === 'ready')).toBe(true);
    });

    it('continues on partial failures', async () => {
      const results = await handle.engine.repositories.media.uploadMany([
        { buffer: BUF('a'), filename: 'a.txt', mimeType: 'text/plain' },
        { buffer: Buffer.alloc(0), filename: 'empty.txt', mimeType: 'text/plain' }, // empty — fails
        { buffer: BUF('c'), filename: 'c.txt', mimeType: 'text/plain' },
      ]);
      expect(results).toHaveLength(2);
    });
  });

  describe('deduplication', () => {
    it('returns existing doc when dedup is enabled and hash matches', async () => {
      const { engine, cleanup } = await createTestEngine({
        deduplication: { enabled: true, returnExisting: true, algorithm: 'sha256' },
      });
      try {
        const first = await engine.repositories.media.upload({
          buffer: BUF('content'),
          filename: 'first.txt',
          mimeType: 'text/plain',
        });
        const second = await engine.repositories.media.upload({
          buffer: BUF('content'),
          filename: 'second.txt',
          mimeType: 'text/plain',
        });
        expect(String(first._id)).toBe(String(second._id));
      } finally {
        await cleanup();
      }
    });

    it('does not dedup when disabled', async () => {
      const first = await handle.engine.repositories.media.upload({
        buffer: BUF('content'),
        filename: 'first.txt',
        mimeType: 'text/plain',
      });
      const second = await handle.engine.repositories.media.upload({
        buffer: BUF('content'),
        filename: 'second.txt',
        mimeType: 'text/plain',
      });
      expect(String(first._id)).not.toBe(String(second._id));
    });
  });

  describe('replace()', () => {
    it('replaces file content while keeping the same _id', async () => {
      const original = await handle.engine.repositories.media.upload({
        buffer: BUF('original'),
        filename: 'file.txt',
        mimeType: 'text/plain',
      });
      const originalKey = original.key;

      const replaced = await handle.engine.repositories.media.replace(String(original._id), {
        buffer: BUF('replaced-content'),
        filename: 'file.txt',
        mimeType: 'text/plain',
      });

      expect(String(replaced._id)).toBe(String(original._id));
      expect(replaced.size).toBe('replaced-content'.length);
      expect(replaced.key).not.toBe(originalKey);
      // Old file should be deleted from storage
      expect(await handle.driver.exists(originalKey)).toBe(false);
    });

    it('publishes media:asset.replaced event', async () => {
      const handler = vi.fn();
      await handle.engine.events.subscribe(MEDIA_EVENTS.ASSET_REPLACED, handler);

      const original = await handle.engine.repositories.media.upload({
        buffer: BUF('x'),
        filename: 'f.txt',
        mimeType: 'text/plain',
      });
      await handle.engine.repositories.media.replace(String(original._id), {
        buffer: BUF('y'),
        filename: 'f.txt',
        mimeType: 'text/plain',
      });
      expect(handler).toHaveBeenCalledTimes(1);
    });
  });
});
