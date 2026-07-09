/**
 * Integration tests — client-computed display hints + existsByHash dedup handshake
 *
 * The client-processed flow (@classytic/media-transform → presigned PUT →
 * confirm with `process` absent) skips server processing, so the client's
 * width/height/thumbhash/dominantColor are the only source of placeholder
 * metadata. Covers:
 *   - confirmUpload persists the hints + derives aspectRatio (width/height)
 *   - confirm without hints → fields absent (unchanged behavior)
 *   - process: true → server-computed values OVERWRITE client hints
 *   - completeMultipartUpload persists the same hints
 *   - upload() honors hints only when processing is skipped/disabled
 *   - existsByHash: tenant-scoped hit / cross-tenant miss (existence-oracle
 *     test) / plain miss
 */

import { describe, it, expect, afterAll, beforeEach, afterEach } from 'vitest';
import {
  createTestEngine,
  createTestImageBuffer,
  teardownTestMongo,
  type TestEngineHandle,
} from '../helpers/create-test-engine.js';

const BUF = (s: string) => Buffer.from(s, 'utf-8');
const ORG_A = '507f1f77bcf86cd799439011';
const ORG_B = '507f1f77bcf86cd799439012';

/** Typical @classytic/media-transform compress() output metadata. */
const CLIENT_HINTS = {
  width: 1280,
  height: 960,
  thumbhash: '3OcRJYB4d3h/iIeHeEh3eIhw+j2w',
  dominantColor: '#8a6f4b',
};

async function loadSharp(): Promise<typeof import('sharp') | null> {
  try {
    return (await import('sharp')).default as unknown as typeof import('sharp');
  } catch {
    return null;
  }
}

afterAll(async () => {
  await teardownTestMongo();
});

describe('client-computed display hints', () => {
  describe('confirmUpload (processing disabled — the chat profile)', () => {
    let handle: TestEngineHandle;

    beforeEach(async () => {
      handle = await createTestEngine();
    });

    afterEach(async () => {
      await handle.cleanup();
    });

    /** Presign + simulate the external PUT, returning the server-generated key. */
    async function presignAndUpload(buffer = BUF('png-bytes')): Promise<string> {
      const repo = handle.engine.repositories.media;
      const presigned = await repo.getSignedUploadUrl('photo.png', 'image/png');
      handle.driver.simulateExternalUpload(presigned.key, buffer, 'image/png');
      return presigned.key;
    }

    it('persists client metadata and derives aspectRatio (width / height)', async () => {
      const repo = handle.engine.repositories.media;
      const key = await presignAndUpload();

      const media = await repo.confirmUpload({
        key,
        filename: 'photo.png',
        mimeType: 'image/png',
        size: 9,
        ...CLIENT_HINTS,
      });

      expect(media.status).toBe('ready');
      expect(media.width).toBe(1280);
      expect(media.height).toBe(960);
      expect(media.aspectRatio).toBe(1280 / 960); // same convention as processImage
      expect(media.thumbhash).toBe(CLIENT_HINTS.thumbhash);
      expect(media.dominantColor).toBe('#8a6f4b');
    });

    it('does not derive aspectRatio when only one dimension is provided', async () => {
      const repo = handle.engine.repositories.media;
      const key = await presignAndUpload();

      const media = await repo.confirmUpload({
        key,
        filename: 'photo.png',
        mimeType: 'image/png',
        size: 9,
        width: 1280,
      });

      expect(media.width).toBe(1280);
      expect(media.height).toBeUndefined();
      expect(media.aspectRatio).toBeUndefined();
    });

    it('confirm WITHOUT hints leaves the fields absent (unchanged behavior)', async () => {
      const repo = handle.engine.repositories.media;
      const key = await presignAndUpload();

      const media = await repo.confirmUpload({
        key,
        filename: 'photo.png',
        mimeType: 'image/png',
        size: 9,
      });

      expect(media.width).toBeUndefined();
      expect(media.height).toBeUndefined();
      expect(media.aspectRatio).toBeUndefined();
      expect(media.thumbhash).toBeUndefined();
      expect(media.dominantColor).toBeUndefined();
    });
  });

  describe('confirmUpload with process: true (server values win)', () => {
    let handle: TestEngineHandle;

    beforeEach(async () => {
      handle = await createTestEngine({ processing: { enabled: true } });
    });

    afterEach(async () => {
      await handle.cleanup();
    });

    it('server-computed dimensions OVERWRITE lying client hints after reprocess', async () => {
      const sharp = await loadSharp();
      if (!sharp) return; // sharp unavailable — reprocess path untestable here

      const repo = handle.engine.repositories.media;
      const presigned = await repo.getSignedUploadUrl('tiny.png', 'image/png');
      // The real file is a 1x1 PNG — the client claims 1280x960
      handle.driver.simulateExternalUpload(presigned.key, createTestImageBuffer(), 'image/png');

      const media = await repo.confirmUpload({
        key: presigned.key,
        filename: 'tiny.png',
        mimeType: 'image/png',
        size: createTestImageBuffer().length,
        process: true,
        ...CLIENT_HINTS,
      });

      expect(media.status).toBe('ready');
      expect(media.width).toBe(1);
      expect(media.height).toBe(1);
      expect(media.aspectRatio).toBe(1);
    });
  });

  describe('completeMultipartUpload', () => {
    let handle: TestEngineHandle;

    beforeEach(async () => {
      handle = await createTestEngine();
    });

    afterEach(async () => {
      await handle.cleanup();
    });

    it('persists client metadata + derived aspectRatio', async () => {
      const repo = handle.engine.repositories.media;

      const session = await repo.initiateMultipartUpload({ filename: 'chat.png', contentType: 'image/png' });
      expect(session.type).toBe('multipart');
      handle.driver.simulatePartUpload(session.uploadId!, 1, BUF('part-1-bytes'));

      const media = await repo.completeMultipartUpload({
        key: session.key,
        uploadId: session.uploadId!,
        parts: [{ partNumber: 1, etag: 'e1' }],
        filename: 'chat.png',
        mimeType: 'image/png',
        size: 12,
        ...CLIENT_HINTS,
      });

      expect(media.status).toBe('ready');
      expect(media.width).toBe(1280);
      expect(media.height).toBe(960);
      expect(media.aspectRatio).toBe(1280 / 960);
      expect(media.thumbhash).toBe(CLIENT_HINTS.thumbhash);
      expect(media.dominantColor).toBe('#8a6f4b');
    });

    it('complete WITHOUT hints leaves the fields absent', async () => {
      const repo = handle.engine.repositories.media;

      const session = await repo.initiateMultipartUpload({ filename: 'chat.png', contentType: 'image/png' });
      handle.driver.simulatePartUpload(session.uploadId!, 1, BUF('part-1-bytes'));

      const media = await repo.completeMultipartUpload({
        key: session.key,
        uploadId: session.uploadId!,
        parts: [{ partNumber: 1, etag: 'e1' }],
        filename: 'chat.png',
        mimeType: 'image/png',
        size: 12,
      });

      expect(media.width).toBeUndefined();
      expect(media.thumbhash).toBeUndefined();
      expect(media.dominantColor).toBeUndefined();
    });
  });

  describe('upload() buffer path', () => {
    let handle: TestEngineHandle;

    afterEach(async () => {
      await handle.cleanup();
    });

    it('honors client hints when processing is disabled', async () => {
      handle = await createTestEngine(); // processing: { enabled: false }
      const repo = handle.engine.repositories.media;

      const media = await repo.upload({
        buffer: createTestImageBuffer(),
        filename: 'client-processed.png',
        mimeType: 'image/png',
        ...CLIENT_HINTS,
      });

      expect(media.status).toBe('ready');
      expect(media.width).toBe(1280);
      expect(media.height).toBe(960);
      expect(media.aspectRatio).toBe(1280 / 960);
      expect(media.thumbhash).toBe(CLIENT_HINTS.thumbhash);
      expect(media.dominantColor).toBe('#8a6f4b');
    });

    it('server-computed values win when processImage runs', async () => {
      const sharp = await loadSharp();
      if (!sharp) return; // sharp unavailable — processing path untestable here

      handle = await createTestEngine({ processing: { enabled: true } });
      const repo = handle.engine.repositories.media;

      // Real file is 1x1 — the client claims 1280x960
      const media = await repo.upload({
        buffer: createTestImageBuffer(),
        filename: 'tiny.png',
        mimeType: 'image/png',
        ...CLIENT_HINTS,
      });

      expect(media.width).toBe(1);
      expect(media.height).toBe(1);
      expect(media.aspectRatio).toBe(1);
    });
  });
});

describe('existsByHash — pre-upload dedup handshake', () => {
  let handle: TestEngineHandle;

  beforeEach(async () => {
    handle = await createTestEngine({
      tenant: { enabled: true, fieldType: 'string', tenantField: 'organizationId', required: true },
    });
  });

  afterEach(async () => {
    await handle.cleanup();
  });

  it('returns the existing doc on a hit within the same tenant', async () => {
    const repo = handle.engine.repositories.media;
    const uploaded = await repo.upload(
      { buffer: BUF('dedup-content'), filename: 'a.bin', mimeType: 'application/octet-stream' },
      { organizationId: ORG_A },
    );

    const result = await repo.existsByHash(uploaded.hash, { organizationId: ORG_A });

    expect(result.exists).toBe(true);
    expect(result.media).toBeDefined();
    expect(String(result.media!._id)).toBe(String(uploaded._id));
  });

  it('NEVER answers across tenants — same hash, other tenant → exists: false (oracle test)', async () => {
    const repo = handle.engine.repositories.media;
    const uploaded = await repo.upload(
      { buffer: BUF('dedup-content'), filename: 'a.bin', mimeType: 'application/octet-stream' },
      { organizationId: ORG_A },
    );

    const result = await repo.existsByHash(uploaded.hash, { organizationId: ORG_B });

    expect(result.exists).toBe(false);
    expect(result.media).toBeUndefined();
  });

  it('returns exists: false on a miss', async () => {
    const repo = handle.engine.repositories.media;

    const result = await repo.existsByHash('0'.repeat(64), { organizationId: ORG_A });

    expect(result.exists).toBe(false);
    expect(result.media).toBeUndefined();
  });
});
