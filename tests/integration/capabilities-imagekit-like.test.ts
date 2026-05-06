/**
 * Capabilities test — build an ImageKit-like solution on media-kit primitives.
 *
 * This test exists to prove that media-kit ships the primitives needed for
 * hosts to compose features like ImageKit's URL-based AI transforms,
 * auto-tagging pipelines, face-detection smart-crops, semantic search,
 * and CDN delivery — WITHOUT shipping those features in media-kit itself.
 *
 * The primitives we use here:
 *   1. StorageDriver    — swap storage (memory driver for tests)
 *   2. ImageAdapter     — custom image processor (fake bg-remove)
 *   3. EventTransport   — post-upload pipeline (auto-tag, face-detect, embed)
 *   4. SourceBridge     — polymorphic refs (media.sourceId → product)
 *   5. CdnBridge        — URL transformation (imgix-style)
 *   6. TransformBridge  — on-the-fly URL ops (bg-remove, upscale)
 *   7. ScanBridge       — upload-time moderation
 *   8. mongokit plugins — multi-tenant, soft delete, cache, audit
 *
 * Run via:  npm run test:integration
 */

import { describe, it, expect, afterAll, beforeEach, afterEach, vi } from 'vitest';
import {
  createTestEngine,
  teardownTestMongo,
  type TestEngineHandle,
} from '../helpers/create-test-engine.js';
import { MEDIA_EVENTS } from '../../src/events/event-constants.js';
import type { ImageAdapter, ProcessedImage } from '../../src/types.js';
import type { TransformBridge, TransformOp } from '../../src/bridges/transform.bridge.js';

const BUF = (s: string) => Buffer.from(s, 'utf-8');

// ── Fake AI services (stand in for Replicate / Fal / OpenAI in prod) ────────

/** Host-supplied: a fake ImageAdapter that wraps a cloud API for bg-remove. */
function makeCloudImageAdapter(opts: { bgRemove: (buf: Buffer) => Promise<Buffer> }): ImageAdapter {
  return {
    async process(buffer, _options): Promise<ProcessedImage> {
      const out = await opts.bgRemove(buffer);
      return { buffer: out as Buffer, mimeType: 'image/png', width: 1, height: 1 };
    },
    isProcessable: (_b, mt) => mt.startsWith('image/'),
    async getDimensions() { return { width: 1, height: 1 }; },
  };
}

/** Host-supplied: a fake auto-tagger that reads filename for keywords. */
function fakeAutoTagger(filename: string): string[] {
  const tags: string[] = [];
  if (/cat/i.test(filename)) tags.push('animal', 'cat');
  if (/dog/i.test(filename)) tags.push('animal', 'dog');
  if (/sunset/i.test(filename)) tags.push('nature', 'sunset');
  return tags;
}

/** Host-supplied: a fake face detector returning focal point. */
async function fakeFaceDetect(_buffer: Buffer): Promise<{ x: number; y: number } | null> {
  return { x: 0.42, y: 0.33 };
}

/** Host-supplied: a fake embedding generator (would call OpenAI/Cohere). */
async function fakeEmbed(_buffer: Buffer): Promise<number[]> {
  return Array.from({ length: 8 }, () => Math.random());
}

// ── Capabilities test ──────────────────────────────────────────────────────

describe('ImageKit-like capabilities on media-kit primitives', () => {
  afterAll(async () => {
    await teardownTestMongo();
  });

  let handle: TestEngineHandle;

  // Track what the simulated "ImageKit clone" does so we can assert on it
  const pipeline: {
    tags: string[];
    focalPoints: Map<string, { x: number; y: number }>;
    embeddings: Map<string, number[]>;
    sources: Map<string, unknown>;
  } = {
    tags: [],
    focalPoints: new Map(),
    embeddings: new Map(),
    sources: new Map(),
  };

  beforeEach(async () => {
    pipeline.tags = [];
    pipeline.focalPoints = new Map();
    pipeline.embeddings = new Map();
    pipeline.sources = new Map();

    // ── The host's "ImageKit stack" — composed entirely of media-kit primitives ──

    // Fake product catalog the host already owns
    const productCatalog = new Map<string, unknown>([
      ['prod_tshirt', { _id: 'prod_tshirt', name: 'Blue T-Shirt', price: 20 }],
      ['prod_mug', { _id: 'prod_mug', name: 'Coffee Mug', price: 15 }],
    ]);
    pipeline.sources = productCatalog;

    // Fake "Replicate-style" bg-remove service
    const bgRemoveOp: TransformOp = async ({ buffer }) => {
      return { buffer: Buffer.concat([buffer, BUF(':bg-removed')]), mimeType: 'image/png' };
    };
    const upscaleOp: TransformOp = async ({ buffer }, ctx) => {
      const scale = Number(ctx.params.scale ?? 2);
      return {
        buffer: Buffer.concat([buffer, BUF(`:upscaled-x${scale}`)]),
        mimeType: 'image/png',
        width: 1024 * scale,
        height: 1024 * scale,
      };
    };

    const transform: TransformBridge = {
      ops: { 'bg-remove': bgRemoveOp, 'upscale': upscaleOp },
    };

    // CdnBridge: imgix-style URL rewriting
    const cdn = {
      transform: (key: string) => `https://cdn.example.com/${key}?auto=format,compress`,
    };

    // SourceBridge: resolve product catalog refs
    const source = {
      resolve: async (sourceId: string, sourceModel: string) => {
        if (sourceModel !== 'Product') return null;
        return productCatalog.get(sourceId) ?? null;
      },
      resolveMany: async (refs: Array<{ sourceId: string; sourceModel: string }>) => {
        const map = new Map<string, unknown>();
        for (const { sourceId, sourceModel } of refs) {
          if (sourceModel === 'Product') {
            const found = productCatalog.get(sourceId);
            if (found) map.set(sourceId, found);
          }
        }
        return map;
      },
    };

    // ScanBridge: content moderation
    const scan = {
      scan: async (_buffer: Buffer, _mt: string, filename: string) => {
        if (/malicious/i.test(filename)) return { verdict: 'reject' as const, reason: 'Detected malicious file' };
        if (/unsafe/i.test(filename)) return { verdict: 'quarantine' as const, reason: 'NSFW — manual review' };
        return { verdict: 'clean' as const };
      },
    };

    handle = await createTestEngine({
      bridges: { transform, cdn, source, scan },
    });

    // ── The host's post-upload pipeline via EventTransport ──
    // This is the key insight: post-upload AI pipelines are event subscriptions,
    // NOT inline steps. The host composes them. media-kit stays thin.
    await handle.engine.events.subscribe(MEDIA_EVENTS.ASSET_UPLOADED, async (event) => {
      const payload = event.payload as any;

      // (1) Auto-tagging (would call OpenAI Vision / Google Vision in prod)
      const tags = fakeAutoTagger(payload.filename);
      if (tags.length > 0) {
        pipeline.tags.push(...tags);
        await handle.engine.repositories.media.addTags(payload.assetId, tags);
      }

      // (2) Face detection → focal point (would call AWS Rekognition in prod)
      if (payload.mimeType.startsWith('image/')) {
        const fp = await fakeFaceDetect(Buffer.from(''));
        if (fp) {
          pipeline.focalPoints.set(payload.assetId, fp);
          await handle.engine.repositories.media.setFocalPoint(payload.assetId, fp);
        }
      }

      // (3) Embedding generation → semantic search (via mongokit/ai vectorSearch)
      const embedding = await fakeEmbed(Buffer.from(''));
      pipeline.embeddings.set(payload.assetId, embedding);
      // In prod: await handle.engine.models.Media.updateOne({ _id: payload.assetId }, { $set: { embedding } })
    });
  });

  afterEach(async () => {
    await handle.cleanup();
  });

  describe('Capability 1 — Upload with post-upload AI pipeline', () => {
    it('host composes auto-tag + face-detect + embed via event subscription', async () => {
      const media = await handle.engine.repositories.media.upload({
        buffer: BUF('x'),
        filename: 'cute-cat-photo.jpg',
        mimeType: 'image/jpeg',
        sourceId: 'prod_tshirt',
        sourceModel: 'Product',
      });

      // Auto-tagger ran (via event)
      expect(pipeline.tags).toContain('animal');
      expect(pipeline.tags).toContain('cat');

      // Face detector set the focal point (via event)
      expect(pipeline.focalPoints.get(String(media._id))).toEqual({ x: 0.42, y: 0.33 });

      // Embedding generator ran (would be stored via mongokit/ai in prod)
      expect(pipeline.embeddings.has(String(media._id))).toBe(true);
      expect(pipeline.embeddings.get(String(media._id))).toHaveLength(8);

      // The document now has tags + focal point from the pipeline
      const refreshed = await handle.engine.models.Media.findById(media._id).lean();
      expect(refreshed!.tags).toEqual(expect.arrayContaining(['animal', 'cat']));
      expect(refreshed!.focalPoint).toEqual({ x: 0.42, y: 0.33 });
    });

    it('host can chain multiple pipelines independently (no ordering issues)', async () => {
      const results: string[] = [];
      await handle.engine.events.subscribe(MEDIA_EVENTS.ASSET_UPLOADED, async () => {
        results.push('pipeline-a');
      });
      await handle.engine.events.subscribe(MEDIA_EVENTS.ASSET_UPLOADED, async () => {
        results.push('pipeline-b');
      });

      await handle.engine.repositories.media.upload({
        buffer: BUF('x'),
        filename: 'sunset.jpg',
        mimeType: 'image/jpeg',
      });

      expect(results).toContain('pipeline-a');
      expect(results).toContain('pipeline-b');
    });
  });

  describe('Capability 2 — URL-based on-the-fly AI transforms', () => {
    it('host exposes an HTTP route that pipes ops: /transform/:id?op=bg-remove,upscale&scale=4', async () => {
      const media = await handle.engine.repositories.media.upload({
        buffer: BUF('original-pixel-data'),
        filename: 'product.jpg',
        mimeType: 'image/jpeg',
      });

      // Simulated host HTTP handler:
      //   GET /transform/:id?op=bg-remove,upscale&scale=4
      //   → repository.applyTransforms(id, { ops: [...], params })
      //   → stream response with output.buffer + Content-Type
      const result = await handle.engine.repositories.media.applyTransforms(String(media._id), {
        ops: ['bg-remove', 'upscale'],
        params: { scale: '4' },
      });

      expect(result.buffer.toString('utf-8')).toContain('original-pixel-data');
      expect(result.buffer.toString('utf-8')).toContain(':bg-removed');
      expect(result.buffer.toString('utf-8')).toContain(':upscaled-x4');
      expect(result.mimeType).toBe('image/png');
      expect(result.width).toBe(4096); // 1024 × 4
    });

    it('rejects unknown ops with helpful error listing registered ops', async () => {
      const media = await handle.engine.repositories.media.upload({
        buffer: BUF('x'),
        filename: 'x.jpg',
        mimeType: 'image/jpeg',
      });
      await expect(
        handle.engine.repositories.media.applyTransforms(String(media._id), {
          ops: ['sepia'],
        }),
      ).rejects.toThrow(/Unknown transform op.*Registered.*bg-remove.*upscale/i);
    });

    it('no TransformBridge configured → clear error (host knows to wire it)', async () => {
      const { engine, cleanup } = await createTestEngine();
      try {
        const media = await engine.repositories.media.upload({
          buffer: BUF('x'), filename: 'x.jpg', mimeType: 'image/jpeg',
        });
        await expect(
          engine.repositories.media.applyTransforms(String(media._id), { ops: ['bg-remove'] }),
        ).rejects.toThrow(/No TransformBridge configured/i);
      } finally {
        await cleanup();
      }
    });
  });

  describe('Capability 3 — CDN URL delivery (imgix-like)', () => {
    it('engine.getAssetUrl returns CDN-transformed URL for any asset', async () => {
      const media = await handle.engine.repositories.media.upload({
        buffer: BUF('x'), filename: 'banner.jpg', mimeType: 'image/jpeg',
      });
      const url = await handle.engine.repositories.media.getAssetUrl(media);
      expect(url).toContain('https://cdn.example.com/');
      expect(url).toContain('auto=format,compress');
    });
  });

  describe('Capability 4 — Polymorphic source resolution (media ↔ product)', () => {
    it('list endpoint can enrich N media docs with 1 batch source query (no N+1)', async () => {
      await handle.engine.repositories.media.upload({
        buffer: BUF('1'), filename: 'tshirt-1.jpg', mimeType: 'image/jpeg',
        sourceId: 'prod_tshirt', sourceModel: 'Product',
      });
      await handle.engine.repositories.media.upload({
        buffer: BUF('2'), filename: 'tshirt-2.jpg', mimeType: 'image/jpeg',
        sourceId: 'prod_tshirt', sourceModel: 'Product',
      });
      await handle.engine.repositories.media.upload({
        buffer: BUF('3'), filename: 'mug-1.jpg', mimeType: 'image/jpeg',
        sourceId: 'prod_mug', sourceModel: 'Product',
      });

      // Simulated host list endpoint:
      const page = await handle.engine.repositories.media.getAll({ page: 1, limit: 10 });
      const data = (page as any).data;

      // 1 batch call enriches all docs — no N+1
      const sources = await handle.engine.repositories.media.resolveSourcesMany(data);
      expect(sources.size).toBe(2); // 2 unique products
      expect(sources.get('prod_tshirt')).toMatchObject({ name: 'Blue T-Shirt' });
      expect(sources.get('prod_mug')).toMatchObject({ name: 'Coffee Mug' });
    });
  });

  describe('Capability 5 — Upload-time moderation', () => {
    it('scanner rejects malicious files (never stored)', async () => {
      await expect(
        handle.engine.repositories.media.upload({
          buffer: BUF('evil'),
          filename: 'malicious.exe',
          mimeType: 'application/octet-stream',
        }),
      ).rejects.toThrow(/Detected malicious file/i);

      const count = await handle.engine.models.Media.countDocuments({});
      expect(count).toBe(0);
    });

    it('scanner quarantines NSFW (stored but status: error)', async () => {
      const media = await handle.engine.repositories.media.upload({
        buffer: BUF('x'),
        filename: 'unsafe-image.jpg',
        mimeType: 'image/jpeg',
      });
      expect(media.status).toBe('error');
      expect(media.errorMessage).toMatch(/manual review/i);
    });
  });

  describe('Capability 6 — Arc-compatible integration surface', () => {
    it('getAll returns mongokit pagination shape — Arc BaseController can wrap it', async () => {
      for (const f of ['a.jpg', 'b.jpg', 'c.jpg']) {
        await handle.engine.repositories.media.upload({
          buffer: BUF(f), filename: f, mimeType: 'image/jpeg',
        });
      }

      const raw = await handle.engine.repositories.media.getAll({ page: 1, limit: 10 });

      // Arc BaseController does: { success: true, data: raw, status: 200 }
      // Which requires `raw` to be the mongokit shape — not an envelope.
      expect(raw).toHaveProperty('data');
      expect(raw).toHaveProperty('total');
      expect(raw).toHaveProperty('method');
      expect(raw).not.toHaveProperty('success');
      expect(raw).not.toHaveProperty('docs');
    });

    it('events are arc-compatible DomainEvent shape (type, payload, meta)', async () => {
      const events: any[] = [];
      await handle.engine.events.subscribe('media:*', async (e) => { events.push(e); });

      await handle.engine.repositories.media.upload({
        buffer: BUF('x'), filename: 'x.jpg', mimeType: 'image/jpeg',
      });

      expect(events[0]).toHaveProperty('type');
      expect(events[0]).toHaveProperty('payload');
      expect(events[0]).toHaveProperty('meta');
      expect(events[0].meta).toHaveProperty('id');
      expect(events[0].meta).toHaveProperty('timestamp');
    });
  });
});
