/**
 * Integration tests — Mongokit response passthrough.
 *
 * PACKAGE_RULES §4: "Return raw mongokit responses — no envelopes".
 * This test fixes that contract. Any future change that wraps
 * mongokit's output in `{ success, data }` or similar MUST fail this test.
 *
 * Arc's BaseController wraps responses in its own envelope — packages
 * must leave the raw shape intact so Arc can do its job.
 */

import { describe, it, expect, afterAll, beforeEach, afterEach } from 'vitest';
import { createTestEngine, teardownTestMongo, type TestEngineHandle } from '../helpers/create-test-engine.js';
import { Types } from 'mongoose';

const BUF = (s: string) => Buffer.from(s, 'utf-8');

describe('Mongokit passthrough — response shape contract', () => {
  afterAll(async () => {
    await teardownTestMongo();
  });

  let handle: TestEngineHandle;

  beforeEach(async () => {
    handle = await createTestEngine();
  });

  afterEach(async () => await handle.cleanup());

  describe('getById — raw document', () => {
    it('returns a plain Mongoose document, not an envelope', async () => {
      const { _id } = await handle.engine.repositories.media.upload({
        buffer: BUF('x'),
        filename: 'x.txt',
        mimeType: 'text/plain',
      });

      const doc = await handle.engine.repositories.media.getById(String(_id));

      expect(doc).not.toBeNull();
      // No envelope keys
      expect(doc).not.toHaveProperty('success');
      expect(doc).not.toHaveProperty('data');
      // Document keys
      expect(doc).toHaveProperty('_id');
      expect(doc).toHaveProperty('filename');
      expect(doc).toHaveProperty('key');
      expect(doc).toHaveProperty('status');
    });
  });

  describe('getAll — raw mongokit pagination shape', () => {
    it('offset pagination returns { docs, total, pages, hasNext, hasPrev, method: "offset" }', async () => {
      for (let i = 0; i < 3; i++) {
        await handle.engine.repositories.media.upload({
          buffer: BUF(`${i}`),
          filename: `${i}.txt`,
          mimeType: 'text/plain',
        });
      }

      const result = await handle.engine.repositories.media.getAll({
        page: 1,
        limit: 10,
      });

      // Mongokit offset-pagination shape (NOT an envelope)
      expect(result).toHaveProperty('docs');
      expect(result).toHaveProperty('total', 3);
      expect(result).toHaveProperty('pages');
      expect(result).toHaveProperty('hasNext');
      expect(result).toHaveProperty('hasPrev');
      expect(result).toHaveProperty('method', 'offset');
      // No envelope keys
      expect(result).not.toHaveProperty('success');
      expect(result).not.toHaveProperty('data');
      // docs is an array of documents (not `{ data: [...] }`)
      expect(Array.isArray((result as any).docs)).toBe(true);
    });

    it('keyset pagination returns { docs, hasMore, next, method: "keyset" }', async () => {
      for (let i = 0; i < 3; i++) {
        await handle.engine.repositories.media.upload({
          buffer: BUF(`${i}`),
          filename: `${i}.txt`,
          mimeType: 'text/plain',
        });
      }

      const result = await handle.engine.repositories.media.getAll({
        sort: { createdAt: -1 },
        limit: 2,
      });

      expect(result).toHaveProperty('docs');
      expect(result).toHaveProperty('hasMore');
      expect(result).toHaveProperty('method', 'keyset');
      expect(result).not.toHaveProperty('success');
      expect(result).not.toHaveProperty('data');
    });
  });

  describe('count — raw number', () => {
    it('returns a plain number, not an envelope', async () => {
      await handle.engine.repositories.media.upload({
        buffer: BUF('x'),
        filename: 'x.txt',
        mimeType: 'text/plain',
      });
      const n = await handle.engine.repositories.media.count({});
      expect(typeof n).toBe('number');
      expect(n).toBe(1);
    });
  });

  describe('exists — raw { _id } | null', () => {
    it('returns { _id } or null, not an envelope', async () => {
      await handle.engine.repositories.media.upload({
        buffer: BUF('x'),
        filename: 'x.txt',
        mimeType: 'text/plain',
      });
      const found = await handle.engine.repositories.media.exists({ filename: 'x.txt' });
      const notFound = await handle.engine.repositories.media.exists({ filename: 'nope.txt' });

      expect(found).not.toBeNull();
      expect(found).toHaveProperty('_id');
      expect(found).not.toHaveProperty('success');
      expect(notFound).toBeNull();
    });
  });

  describe('update — raw document', () => {
    it('returns the updated document directly', async () => {
      const { _id } = await handle.engine.repositories.media.upload({
        buffer: BUF('x'),
        filename: 'x.txt',
        mimeType: 'text/plain',
      });

      const updated = await handle.engine.repositories.media.update(
        String(_id),
        { alt: 'new alt' } as any,
      );

      expect(updated).toHaveProperty('_id');
      expect((updated as any).alt).toBe('new alt');
      expect(updated).not.toHaveProperty('success');
      expect(updated).not.toHaveProperty('data');
    });
  });

  describe('create — raw document (via upload flow)', () => {
    it('upload returns the media doc directly', async () => {
      const doc = await handle.engine.repositories.media.upload({
        buffer: BUF('x'),
        filename: 'x.txt',
        mimeType: 'text/plain',
      });
      expect(doc._id).toBeInstanceOf(Types.ObjectId);
      expect(doc).not.toHaveProperty('success');
      expect(doc).not.toHaveProperty('data');
      expect(doc).not.toHaveProperty('envelope');
    });
  });

  describe('domain verbs return raw documents (not envelopes)', () => {
    it('addTags returns the raw updated doc', async () => {
      const { _id } = await handle.engine.repositories.media.upload({
        buffer: BUF('x'),
        filename: 'x.txt',
        mimeType: 'text/plain',
      });
      const updated = await handle.engine.repositories.media.addTags(String(_id), ['a', 'b']);
      expect(updated).toHaveProperty('_id');
      expect(updated).toHaveProperty('tags');
      expect(updated).not.toHaveProperty('success');
    });

    it('setFocalPoint returns the raw updated doc', async () => {
      const { _id } = await handle.engine.repositories.media.upload({
        buffer: BUF('x'),
        filename: 'x.jpg',
        mimeType: 'image/jpeg',
      });
      const updated = await handle.engine.repositories.media.setFocalPoint(
        String(_id),
        { x: 0.5, y: 0.5 },
      );
      expect(updated).toHaveProperty('_id');
      expect(updated).toHaveProperty('focalPoint');
      expect(updated).not.toHaveProperty('success');
    });
  });

  describe('Arc compatibility — shape is compatible with BaseController', () => {
    it('Arc BaseController wraps raw docs in its envelope — package stays out of the way', async () => {
      // Arc's BaseController does:
      //   return { success: true, data: await repo.getById(id), status: 200 };
      // For this to work, repo.getById() must NOT already be an envelope.
      const { _id } = await handle.engine.repositories.media.upload({
        buffer: BUF('x'),
        filename: 'x.txt',
        mimeType: 'text/plain',
      });
      const doc = await handle.engine.repositories.media.getById(String(_id));

      // Simulate Arc wrapping — this should work cleanly
      const arcResponse = { success: true, data: doc, status: 200 };
      expect(arcResponse.data).toHaveProperty('_id');
      expect(arcResponse.data).toHaveProperty('filename');
    });

    it('Arc list endpoint can pass through mongokit pagination result', async () => {
      // Arc does:
      //   return { success: true, data: await repo.getAll({ page, limit }), status: 200 };
      for (let i = 0; i < 3; i++) {
        await handle.engine.repositories.media.upload({
          buffer: BUF(`${i}`),
          filename: `${i}.txt`,
          mimeType: 'text/plain',
        });
      }

      const paginated = await handle.engine.repositories.media.getAll({ page: 1, limit: 10 });
      const arcResponse = { success: true, data: paginated, status: 200 };
      expect(arcResponse.data).toHaveProperty('docs');
      expect(arcResponse.data).toHaveProperty('total');
    });
  });
});
