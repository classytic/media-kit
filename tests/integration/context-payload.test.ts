/**
 * Integration tests — getContextPayload (LLM-context reads).
 *
 * Covers base64/dataUrl/buffer encodings, byte-stability, the maxBytes hard
 * cap (typed 413 error), maxDimension downscaling via sharp, and that the
 * read works regardless of visibility.
 */

import { describe, it, expect, afterAll } from 'vitest';
import { createTestEngine, teardownTestMongo, type TestEngineHandle } from '../helpers/create-test-engine.js';

const BUF = (s: string) => Buffer.from(s, 'utf-8');

async function withEngine(fn: (handle: TestEngineHandle) => Promise<void>): Promise<void> {
  const handle = await createTestEngine();
  try {
    await fn(handle);
  } finally {
    await handle.cleanup();
  }
}

describe('getContextPayload', () => {
  afterAll(async () => {
    await teardownTestMongo();
  });

  it('returns base64 by default, round-trips content exactly', async () => {
    await withEngine(async ({ engine }) => {
      const content = 'hello context payload';
      const media = await engine.repositories.media.upload({
        buffer: BUF(content),
        filename: 'note.txt',
        mimeType: 'text/plain',
      });

      const payload = await engine.repositories.media.getContextPayload(media);
      expect(payload.contentType).toBe('text/plain');
      expect(payload.bytes).toBe(content.length);
      expect(typeof payload.data).toBe('string');
      expect(Buffer.from(payload.data as string, 'base64').toString()).toBe(content);
    });
  });

  it('as: dataUrl prefixes the mime type', async () => {
    await withEngine(async ({ engine }) => {
      const media = await engine.repositories.media.upload({
        buffer: BUF('abc'),
        filename: 'a.txt',
        mimeType: 'text/plain',
      });
      const payload = await engine.repositories.media.getContextPayload(media, { as: 'dataUrl' });
      expect(payload.data).toBe(`data:text/plain;base64,${BUF('abc').toString('base64')}`);
    });
  });

  it('as: buffer returns the raw bytes (byte-stable across calls)', async () => {
    await withEngine(async ({ engine }) => {
      const content = 'stable-bytes';
      const media = await engine.repositories.media.upload({
        buffer: BUF(content),
        filename: 'b.bin',
        mimeType: 'application/octet-stream',
      });
      const a = await engine.repositories.media.getContextPayload(media, { as: 'buffer' });
      const b = await engine.repositories.media.getContextPayload(String(media._id), { as: 'buffer' });
      expect(Buffer.isBuffer(a.data)).toBe(true);
      expect((a.data as Buffer).equals(b.data as Buffer)).toBe(true);
      expect((a.data as Buffer).toString()).toBe(content);
    });
  });

  it('exceeding maxBytes throws a typed 413 error', async () => {
    await withEngine(async ({ engine }) => {
      const media = await engine.repositories.media.upload({
        buffer: Buffer.alloc(1024, 7),
        filename: 'big.bin',
        mimeType: 'application/octet-stream',
      });
      await expect(engine.repositories.media.getContextPayload(media, { maxBytes: 512 })).rejects.toMatchObject({
        status: 413,
        code: 'media.context.too_large',
      });
    });
  });

  it('works regardless of visibility — private docs are readable server-side', async () => {
    await withEngine(async ({ engine }) => {
      const media = await engine.repositories.media.upload({
        buffer: BUF('secret-bytes'),
        filename: 's.bin',
        mimeType: 'application/octet-stream',
        visibility: 'private',
      });
      const payload = await engine.repositories.media.getContextPayload(media);
      expect(Buffer.from(payload.data as string, 'base64').toString()).toBe('secret-bytes');
    });
  });

  it('unknown id throws not-found', async () => {
    await withEngine(async ({ engine }) => {
      await expect(engine.repositories.media.getContextPayload('64b000000000000000000000')).rejects.toThrow(
        /not found/i,
      );
    });
  });

  it('downscales images larger than maxDimension (default 1568, fit inside, no enlarge)', async () => {
    let sharp: typeof import('sharp') | null = null;
    try {
      sharp = (await import('sharp')).default;
    } catch {
      return; // sharp unavailable — resize path untestable here
    }

    await withEngine(async ({ engine }) => {
      const wide = await sharp!({
        create: { width: 3000, height: 1500, channels: 3, background: { r: 200, g: 10, b: 10 } },
      })
        .jpeg()
        .toBuffer();

      const media = await engine.repositories.media.upload({
        buffer: wide,
        filename: 'wide.jpg',
        mimeType: 'image/jpeg',
        skipProcessing: true,
      });

      // Default maxDimension 1568 → long edge shrinks to 1568, ratio kept.
      const payload = await engine.repositories.media.getContextPayload(media, { as: 'buffer' });
      const meta = await sharp!(payload.data as Buffer).metadata();
      expect(meta.width).toBe(1568);
      expect(meta.height).toBe(784);
      expect(payload.bytes).toBe((payload.data as Buffer).length);

      // maxDimension larger than the source → bytes untouched (byte-stable).
      const untouched = await engine.repositories.media.getContextPayload(media, {
        as: 'buffer',
        maxDimension: 4000,
      });
      expect((untouched.data as Buffer).equals(wide)).toBe(true);

      // Custom maxDimension applies.
      const small = await engine.repositories.media.getContextPayload(media, { as: 'buffer', maxDimension: 512 });
      const smallMeta = await sharp!(small.data as Buffer).metadata();
      expect(smallMeta.width).toBe(512);
      expect(smallMeta.height).toBe(256);
    });
  });

  it('non-image content is never resized', async () => {
    await withEngine(async ({ engine }) => {
      const content = Buffer.alloc(2048, 3);
      const media = await engine.repositories.media.upload({
        buffer: content,
        filename: 'blob.bin',
        mimeType: 'application/octet-stream',
      });
      const payload = await engine.repositories.media.getContextPayload(media, { as: 'buffer', maxDimension: 10 });
      expect((payload.data as Buffer).equals(content)).toBe(true);
    });
  });
});
