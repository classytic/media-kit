/**
 * Integration tests — CdnBridge
 *
 * Covers URL transformation for main asset + variants.
 */

import { describe, it, expect, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { createTestEngine, teardownTestMongo, type TestEngineHandle } from '../helpers/create-test-engine.js';
import type { CdnBridge } from '../../src/bridges/cdn.bridge.js';

const BUF = (s: string) => Buffer.from(s, 'utf-8');

describe('CdnBridge integration', () => {
  afterAll(async () => {
    await teardownTestMongo();
  });

  describe('getAssetUrl()', () => {
    it('rewrites URL through CdnBridge when configured', async () => {
      const cdn: CdnBridge = {
        transform: vi.fn((key: string) => `https://cdn.example.com/${key}`),
      };
      const { engine, cleanup } = await createTestEngine({ bridges: { cdn } });

      try {
        const media = await engine.repositories.media.upload({
          buffer: BUF('x'),
          filename: 'x.jpg',
          mimeType: 'image/jpeg',
        });

        const url = await engine.repositories.media.getAssetUrl(media);
        expect(url).toBe(`https://cdn.example.com/${media.key}`);
        expect(cdn.transform).toHaveBeenCalledWith(media.key, media.url, undefined);
      } finally {
        await cleanup();
      }
    });

    it('falls back to default URL when no CdnBridge', async () => {
      const { engine, cleanup } = await createTestEngine();
      try {
        const media = await engine.repositories.media.upload({
          buffer: BUF('x'), filename: 'x.jpg', mimeType: 'image/jpeg',
        });
        const url = await engine.repositories.media.getAssetUrl(media);
        expect(url).toBe(media.url);
      } finally {
        await cleanup();
      }
    });

    it('passes signed/expiresIn context to transform', async () => {
      const transform = vi.fn().mockResolvedValue('https://signed.cdn.example.com/x?sig=abc');
      const { engine, cleanup } = await createTestEngine({
        bridges: { cdn: { transform } },
      });

      try {
        const media = await engine.repositories.media.upload({
          buffer: BUF('x'), filename: 'x.jpg', mimeType: 'image/jpeg',
        });

        const url = await engine.repositories.media.getAssetUrl(media, {
          signed: true,
          expiresIn: 3600,
        });

        expect(url).toBe('https://signed.cdn.example.com/x?sig=abc');
        expect(transform).toHaveBeenCalledWith(
          media.key,
          expect.any(String),
          { signed: true, expiresIn: 3600 },
        );
      } finally {
        await cleanup();
      }
    });

    it('supports async transform (e.g. signing with external KMS)', async () => {
      const transform = vi.fn(async (key: string) => {
        await new Promise((r) => setTimeout(r, 5));
        return `https://async.cdn.example.com/${key}`;
      });
      const { engine, cleanup } = await createTestEngine({
        bridges: { cdn: { transform } },
      });
      try {
        const media = await engine.repositories.media.upload({
          buffer: BUF('x'), filename: 'x.jpg', mimeType: 'image/jpeg',
        });
        const url = await engine.repositories.media.getAssetUrl(media);
        expect(url).toContain('https://async.cdn.example.com/');
      } finally {
        await cleanup();
      }
    });
  });

  describe('getVariantUrls()', () => {
    it('transforms each variant URL through CdnBridge', async () => {
      const cdn: CdnBridge = {
        transform: vi.fn((key: string) => `https://cdn.example.com/${key}`),
      };
      const { engine, cleanup } = await createTestEngine({ bridges: { cdn } });

      try {
        const media = await engine.repositories.media.upload({
          buffer: BUF('x'), filename: 'x.jpg', mimeType: 'image/jpeg',
        });

        // Inject variants manually (processing disabled in test engine)
        await engine.models.Media.updateOne(
          { _id: media._id },
          {
            $set: {
              variants: [
                {
                  name: 'thumbnail',
                  key: 'thumb/x.webp',
                  url: 's3://raw/thumb/x.webp',
                  filename: 'x.webp',
                  mimeType: 'image/webp',
                  size: 100,
                },
                {
                  name: 'large',
                  key: 'large/x.webp',
                  url: 's3://raw/large/x.webp',
                  filename: 'x.webp',
                  mimeType: 'image/webp',
                  size: 1000,
                },
              ],
            },
          },
        );

        const refreshed = await engine.models.Media.findById(media._id);
        const urls = await engine.repositories.media.getVariantUrls(refreshed!);

        expect(urls).toHaveLength(2);
        expect(urls[0]).toEqual({
          name: 'thumbnail',
          url: 'https://cdn.example.com/thumb/x.webp',
        });
        expect(urls[1]).toEqual({
          name: 'large',
          url: 'https://cdn.example.com/large/x.webp',
        });
      } finally {
        await cleanup();
      }
    });

    it('returns empty array when media has no variants', async () => {
      const cdn: CdnBridge = { transform: vi.fn() };
      const { engine, cleanup } = await createTestEngine({ bridges: { cdn } });
      try {
        const media = await engine.repositories.media.upload({
          buffer: BUF('x'), filename: 'x.txt', mimeType: 'text/plain',
        });
        const urls = await engine.repositories.media.getVariantUrls(media);
        expect(urls).toEqual([]);
      } finally {
        await cleanup();
      }
    });

    it('falls back to variant.url when no CdnBridge', async () => {
      const { engine, cleanup } = await createTestEngine();
      try {
        const media = await engine.repositories.media.upload({
          buffer: BUF('x'), filename: 'x.jpg', mimeType: 'image/jpeg',
        });
        await engine.models.Media.updateOne(
          { _id: media._id },
          {
            $set: {
              variants: [{
                name: 'thumbnail',
                key: 't/x.webp',
                url: 'https://default.example.com/t/x.webp',
                filename: 'x.webp',
                mimeType: 'image/webp',
                size: 100,
              }],
            },
          },
        );
        const refreshed = await engine.models.Media.findById(media._id);
        const urls = await engine.repositories.media.getVariantUrls(refreshed!);
        expect(urls[0]!.url).toBe('https://default.example.com/t/x.webp');
      } finally {
        await cleanup();
      }
    });
  });
});
