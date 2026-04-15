/**
 * Integration tests — SourceBridge
 *
 * Covers polymorphic source resolution (product/order/external ref)
 * via resolve() and resolveMany() (N+1 avoidance).
 */

import { describe, it, expect, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { createTestEngine, teardownTestMongo, type TestEngineHandle } from '../helpers/create-test-engine.js';
import type { SourceBridge, SourceRef } from '../../src/bridges/source.bridge.js';

const BUF = (s: string) => Buffer.from(s, 'utf-8');

describe('SourceBridge integration', () => {
  afterAll(async () => {
    await teardownTestMongo();
  });

  describe('resolve() — single ref', () => {
    let handle: TestEngineHandle;
    const resolve = vi.fn();

    beforeEach(async () => {
      resolve.mockReset();
      const bridge: SourceBridge = { resolve };
      handle = await createTestEngine({ bridges: { source: bridge } });
    });

    afterEach(async () => {
      await handle.cleanup();
    });

    it('resolves the source for media with sourceId + sourceModel', async () => {
      resolve.mockResolvedValueOnce({ _id: 'prod_1', name: 'T-Shirt', price: 20 });

      const media = await handle.engine.repositories.media.upload({
        buffer: BUF('x'),
        filename: 'x.jpg',
        mimeType: 'image/jpeg',
        sourceId: 'prod_1',
        sourceModel: 'Product',
      });

      const source = await handle.engine.repositories.media.resolveSource(media);

      expect(source).toEqual({ _id: 'prod_1', name: 'T-Shirt', price: 20 });
      expect(resolve).toHaveBeenCalledWith('prod_1', 'Product', expect.any(Object));
    });

    it('returns null when media has no sourceId', async () => {
      const media = await handle.engine.repositories.media.upload({
        buffer: BUF('x'), filename: 'x.jpg', mimeType: 'image/jpeg',
      });
      const source = await handle.engine.repositories.media.resolveSource(media);
      expect(source).toBeNull();
      expect(resolve).not.toHaveBeenCalled();
    });

    it('passes ctx to resolver (organizationId, userId)', async () => {
      resolve.mockResolvedValueOnce({ _id: 'x' });

      const media = await handle.engine.repositories.media.upload({
        buffer: BUF('x'),
        filename: 'x.jpg',
        mimeType: 'image/jpeg',
        sourceId: 'prod_1',
        sourceModel: 'Product',
      });

      await handle.engine.repositories.media.resolveSource(media, {
        organizationId: 'org_42',
        userId: 'user_1',
      });

      expect(resolve).toHaveBeenCalledWith(
        'prod_1',
        'Product',
        expect.objectContaining({ organizationId: 'org_42', userId: 'user_1' }),
      );
    });
  });

  describe('no bridge configured', () => {
    let handle: TestEngineHandle;

    beforeEach(async () => {
      handle = await createTestEngine();
    });

    afterEach(async () => {
      await handle.cleanup();
    });

    it('resolveSource returns null when no bridge provided', async () => {
      const media = await handle.engine.repositories.media.upload({
        buffer: BUF('x'),
        filename: 'x.jpg',
        mimeType: 'image/jpeg',
        sourceId: 'prod_1',
        sourceModel: 'Product',
      });
      const source = await handle.engine.repositories.media.resolveSource(media);
      expect(source).toBeNull();
    });

    it('resolveSourcesMany returns empty Map when no bridge', async () => {
      const media = await handle.engine.repositories.media.upload({
        buffer: BUF('x'),
        filename: 'x.jpg',
        mimeType: 'image/jpeg',
        sourceId: 'p1',
        sourceModel: 'Product',
      });
      const map = await handle.engine.repositories.media.resolveSourcesMany([media]);
      expect(map.size).toBe(0);
    });
  });

  describe('resolveMany() — batch (N+1 avoidance)', () => {
    let handle: TestEngineHandle;
    const resolveMany = vi.fn();

    beforeEach(async () => {
      resolveMany.mockReset();
      const bridge: SourceBridge = { resolveMany };
      handle = await createTestEngine({ bridges: { source: bridge } });
    });

    afterEach(async () => {
      await handle.cleanup();
    });

    it('batches refs into a single resolver call', async () => {
      const m1 = await handle.engine.repositories.media.upload({
        buffer: BUF('1'), filename: '1.jpg', mimeType: 'image/jpeg',
        sourceId: 'p1', sourceModel: 'Product',
      });
      const m2 = await handle.engine.repositories.media.upload({
        buffer: BUF('2'), filename: '2.jpg', mimeType: 'image/jpeg',
        sourceId: 'p2', sourceModel: 'Product',
      });
      const m3 = await handle.engine.repositories.media.upload({
        buffer: BUF('3'), filename: '3.jpg', mimeType: 'image/jpeg',
        sourceId: 'o1', sourceModel: 'Order',
      });

      resolveMany.mockResolvedValueOnce(
        new Map<string, unknown>([
          ['p1', { _id: 'p1', name: 'Product 1' }],
          ['p2', { _id: 'p2', name: 'Product 2' }],
          ['o1', { _id: 'o1', total: 100 }],
        ]),
      );

      const map = await handle.engine.repositories.media.resolveSourcesMany([m1, m2, m3]);

      expect(resolveMany).toHaveBeenCalledTimes(1);
      const refs = resolveMany.mock.calls[0]?.[0] as SourceRef[];
      expect(refs).toHaveLength(3);
      expect(refs).toEqual(
        expect.arrayContaining([
          { sourceId: 'p1', sourceModel: 'Product' },
          { sourceId: 'p2', sourceModel: 'Product' },
          { sourceId: 'o1', sourceModel: 'Order' },
        ]),
      );

      expect(map.size).toBe(3);
      expect(map.get('p1')).toMatchObject({ name: 'Product 1' });
      expect(map.get('o1')).toMatchObject({ total: 100 });
    });

    it('skips media without sourceId/sourceModel', async () => {
      const m1 = await handle.engine.repositories.media.upload({
        buffer: BUF('1'), filename: '1.jpg', mimeType: 'image/jpeg',
        sourceId: 'p1', sourceModel: 'Product',
      });
      const m2 = await handle.engine.repositories.media.upload({
        buffer: BUF('2'), filename: '2.jpg', mimeType: 'image/jpeg',
        // no source
      });

      resolveMany.mockResolvedValueOnce(new Map([['p1', { ok: true }]]));

      await handle.engine.repositories.media.resolveSourcesMany([m1, m2]);

      const refs = resolveMany.mock.calls[0]?.[0] as SourceRef[];
      expect(refs).toHaveLength(1);
      expect(refs[0]!.sourceId).toBe('p1');
    });

    it('does not call resolveMany when no media has source refs', async () => {
      const m1 = await handle.engine.repositories.media.upload({
        buffer: BUF('1'), filename: '1.jpg', mimeType: 'image/jpeg',
      });
      const map = await handle.engine.repositories.media.resolveSourcesMany([m1]);
      expect(resolveMany).not.toHaveBeenCalled();
      expect(map.size).toBe(0);
    });
  });

  describe('schema fields', () => {
    let handle: TestEngineHandle;

    beforeEach(async () => {
      handle = await createTestEngine();
    });

    afterEach(async () => {
      await handle.cleanup();
    });

    it('persists sourceId and sourceModel from upload input', async () => {
      const media = await handle.engine.repositories.media.upload({
        buffer: BUF('x'),
        filename: 'cover.jpg',
        mimeType: 'image/jpeg',
        sourceId: 'article_123',
        sourceModel: 'Article',
      });

      const raw = await handle.engine.models.Media.findById(media._id).lean();
      expect((raw as any).sourceId).toBe('article_123');
      expect((raw as any).sourceModel).toBe('Article');
    });

    it('schema declares String type (polymorphic — accepts UUID/hex/any string)', () => {
      const schema = handle.engine.models.Media.schema;
      const sourceIdPath = schema.path('sourceId') as any;
      const sourceModelPath = schema.path('sourceModel') as any;
      expect(sourceIdPath?.instance).toBe('String');
      expect(sourceModelPath?.instance).toBe('String');
    });
  });
});
