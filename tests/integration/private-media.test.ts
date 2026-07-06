/**
 * Integration tests — private media serving.
 *
 * Covers:
 *   - visibility stamping precedence (config default / byFolder / per-upload)
 *   - confirmUpload visibility stamping
 *   - the full serve matrix over LocalProvider (public unchanged, unsigned
 *     403, signed 200, wrong-variant binding, expiry, revocation, authorize
 *     true/false/throwing, Range/206)
 *   - getSignedAssetUrl end-to-end against the serve pipeline
 *   - cache-header assertions (no public/immutable on private responses)
 */

import { describe, it, expect, afterAll, beforeAll, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestEngine, teardownTestMongo } from '../helpers/create-test-engine.js';
import { createMedia } from '../../src/engine/create-media.js';
import type { MediaEngine } from '../../src/engine/engine-types.js';
import { LocalProvider } from '../../src/providers/local.provider.js';
import { createAssetTransform, type AssetTransformService } from '../../src/transforms/asset-transform.js';
import type { TransformResponse } from '../../src/types.js';

const BUF = (s: string) => Buffer.from(s, 'utf-8');

async function readBody(res: TransformResponse): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of res.stream as AsyncIterable<Buffer | string>) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/** Split a minted `servePath/id[/variant]?query` URL into handle() inputs. */
function parseServeUrl(url: string): { fileId: string; variant?: string; query: Record<string, string> } {
  const [path, queryString] = url.split('?');
  const segments = path!.replace('/media/content/', '').split('/');
  const fileId = segments[0]!;
  const result: { fileId: string; variant?: string; query: Record<string, string> } = {
    fileId,
    query: Object.fromEntries(new URLSearchParams(queryString ?? '')),
  };
  if (segments[1]) result.variant = decodeURIComponent(segments[1]);
  return result;
}

describe('visibility stamping precedence', () => {
  afterAll(async () => {
    await teardownTestMongo();
  });

  it('defaults to public with no visibility config (pre-3.4.0 behavior, tokenVersion 0)', async () => {
    const { engine, cleanup } = await createTestEngine();
    try {
      const media = await engine.repositories.media.upload({
        buffer: BUF('x'),
        filename: 'x.jpg',
        mimeType: 'image/jpeg',
      });
      expect(media.visibility).toBe('public');
      expect(media.tokenVersion).toBe(0);
    } finally {
      await cleanup();
    }
  });

  it('config visibility.default applies when no folder rule matches', async () => {
    const { engine, cleanup } = await createTestEngine({ visibility: { default: 'private' } });
    try {
      const media = await engine.repositories.media.upload({
        buffer: BUF('x'),
        filename: 'x.jpg',
        mimeType: 'image/jpeg',
      });
      expect(media.visibility).toBe('private');
    } finally {
      await cleanup();
    }
  });

  it('byFolder rule wins over default, matches subfolders segment-wise', async () => {
    const { engine, cleanup } = await createTestEngine({
      visibility: { default: 'private', byFolder: { 'public-assets': 'public' } },
    });
    try {
      const pub = await engine.repositories.media.upload({
        buffer: BUF('a'),
        filename: 'a.jpg',
        mimeType: 'image/jpeg',
        folder: 'public-assets/logos',
      });
      expect(pub.visibility).toBe('public');

      // 'public-assets-extra' must NOT match the 'public-assets' rule.
      const priv = await engine.repositories.media.upload({
        buffer: BUF('b'),
        filename: 'b.jpg',
        mimeType: 'image/jpeg',
        folder: 'public-assets-extra',
      });
      expect(priv.visibility).toBe('private');
    } finally {
      await cleanup();
    }
  });

  it('explicit per-upload visibility overrides byFolder and default', async () => {
    const { engine, cleanup } = await createTestEngine({
      visibility: { default: 'public', byFolder: { invoices: 'private' } },
    });
    try {
      const media = await engine.repositories.media.upload({
        buffer: BUF('x'),
        filename: 'x.pdf',
        mimeType: 'application/pdf',
        folder: 'invoices/2026',
        visibility: 'public',
      });
      expect(media.visibility).toBe('public');

      const media2 = await engine.repositories.media.upload({
        buffer: BUF('y'),
        filename: 'y.jpg',
        mimeType: 'image/jpeg',
        folder: 'general',
        visibility: 'private',
      });
      expect(media2.visibility).toBe('private');
    } finally {
      await cleanup();
    }
  });

  it('confirmUpload stamps visibility from config (byFolder) and explicit input', async () => {
    const { engine, driver, cleanup } = await createTestEngine({
      visibility: { byFolder: { vault: 'private' } },
    });
    try {
      const repo = engine.repositories.media;

      const presigned = await repo.getSignedUploadUrl('doc.pdf', 'application/pdf', { folder: 'vault' });
      driver.simulateExternalUpload(presigned.key, BUF('pdf-bytes'), 'application/pdf');
      const confirmed = await repo.confirmUpload({
        key: presigned.key,
        filename: 'doc.pdf',
        mimeType: 'application/pdf',
        size: 9,
      });
      expect(confirmed.visibility).toBe('private');
      expect(confirmed.tokenVersion).toBe(0);

      const presigned2 = await repo.getSignedUploadUrl('pic.jpg', 'image/jpeg', { folder: 'vault' });
      driver.simulateExternalUpload(presigned2.key, BUF('jpg'), 'image/jpeg');
      const confirmed2 = await repo.confirmUpload({
        key: presigned2.key,
        filename: 'pic.jpg',
        mimeType: 'image/jpeg',
        size: 3,
        visibility: 'public',
      });
      expect(confirmed2.visibility).toBe('public');
    } finally {
      await cleanup();
    }
  });

  it('getSignedAssetUrl throws a typed error when signing is not configured', async () => {
    const { engine, cleanup } = await createTestEngine();
    try {
      const media = await engine.repositories.media.upload({
        buffer: BUF('x'),
        filename: 'x.jpg',
        mimeType: 'image/jpeg',
      });
      await expect(engine.repositories.media.getSignedAssetUrl(media)).rejects.toMatchObject({
        code: 'media.signing.not_configured',
      });
    } finally {
      await cleanup();
    }
  });

  it('getSignedAssetUrl routes through CdnBridge when configured (bridge wins)', async () => {
    const transform = vi.fn().mockResolvedValue('https://cf.example.com/offloaded?Signature=cf');
    const { engine, cleanup } = await createTestEngine({
      signing: { secret: 'cdn-secret', servePath: '/media/content' },
      bridges: { cdn: { transform } },
    });
    try {
      const media = await engine.repositories.media.upload({
        buffer: BUF('x'),
        filename: 'x.jpg',
        mimeType: 'image/jpeg',
        visibility: 'private',
      });
      const url = await engine.repositories.media.getSignedAssetUrl(media, { expiresIn: 600 });
      expect(url).toBe('https://cf.example.com/offloaded?Signature=cf');
      expect(transform).toHaveBeenCalledWith(
        media.key,
        expect.stringContaining(`/media/content/${String(media._id)}?e=`),
        expect.objectContaining({ signed: true, expiresIn: 600 }),
      );
    } finally {
      await cleanup();
    }
  });
});

describe('serve matrix over LocalProvider', () => {
  let baseDir: string;
  let engine: MediaEngine;
  let service: AssetTransformService;
  let publicId: string;
  let privateId: string;
  const PRIVATE_CONTENT = 'private-file-content-0123456789';
  const PUBLIC_CONTENT = 'public-file-content';

  beforeAll(async () => {
    baseDir = mkdtempSync(join(tmpdir(), 'media-kit-private-'));
    // Reuse the shared mongo connection from the test-engine helper.
    const handle = await createTestEngine();
    await handle.engine.dispose();

    engine = await createMedia({
      connection: handle.connection,
      driver: new LocalProvider({ basePath: baseDir, baseUrl: '/uploads' }),
      suppressWarnings: true,
      processing: { enabled: false },
      signing: { secret: 'serve-matrix-secret', servePath: '/media/content', defaultTtl: 3600 },
    });
    service = createAssetTransform({ media: engine });

    const pub = await engine.repositories.media.upload({
      buffer: BUF(PUBLIC_CONTENT),
      filename: 'pub.bin',
      mimeType: 'application/octet-stream',
    });
    publicId = String(pub._id);

    const priv = await engine.repositories.media.upload({
      buffer: BUF(PRIVATE_CONTENT),
      filename: 'priv.bin',
      mimeType: 'application/octet-stream',
      visibility: 'private',
    });
    privateId = String(priv._id);
  });

  afterAll(async () => {
    await engine.dispose();
    rmSync(baseDir, { recursive: true, force: true });
    await teardownTestMongo();
  });

  it('public file serves unchanged with public cache headers (zero behavior change)', async () => {
    const res = await service.handle({ fileId: publicId, params: {} });
    expect(res.status).toBe(200);
    expect(res.headers['Cache-Control']).toBe('public, max-age=86400');
    expect((await readBody(res)).toString()).toBe(PUBLIC_CONTENT);
  });

  it('private + unsigned → 403 JSON { error: { code: media.serve.forbidden } }, no bytes', async () => {
    const res = await service.handle({ fileId: privateId, params: {} });
    expect(res.status).toBe(403);
    expect(res.contentType).toBe('application/json');
    expect(res.headers['Cache-Control']).toBe('private, no-store');
    expect(JSON.parse((await readBody(res)).toString())).toEqual({
      error: { code: 'media.serve.forbidden' },
    });
  });

  it('private + valid signature → 200 with private, bounded max-age', async () => {
    const url = await engine.repositories.media.getSignedAssetUrl(privateId, { expiresIn: 7200 });
    const { fileId, query } = parseServeUrl(url);

    const res = await service.handle({ fileId, params: {}, query });
    expect(res.status).toBe(200);
    expect((await readBody(res)).toString()).toBe(PRIVATE_CONTENT);

    // Signed hits are browser-cacheable for min(remaining TTL, 3600) — never public.
    const cc = res.headers['Cache-Control']!;
    expect(cc).toMatch(/^private, max-age=\d+$/);
    const maxAge = Number(cc.match(/max-age=(\d+)/)![1]);
    expect(maxAge).toBeGreaterThan(0);
    expect(maxAge).toBeLessThanOrEqual(3600);
    expect(cc).not.toContain('public');
    expect(cc).not.toContain('immutable');
  });

  it('signature is bound to the variant — serving a different target 403s', async () => {
    // Mint a signature for a (synthetic) variant, then request the main file.
    const sig = engine.signing!.sign({ id: privateId, variant: 'thumbnail', tokenVersion: 0 });
    const query = Object.fromEntries(new URLSearchParams(sig.query));

    const res = await service.handle({ fileId: privateId, params: {}, query });
    expect(res.status).toBe(403);
    expect(JSON.parse((await readBody(res)).toString())).toEqual({
      error: { code: 'media.serve.forbidden' },
    });
  });

  it('serves a specific variant when requested with a matching signature', async () => {
    // Attach a real variant to the private doc.
    const variantKey = 'general/priv-thumb.bin';
    const variantContent = 'variant-bytes';
    await engine.driver.write(variantKey, BUF(variantContent), 'application/octet-stream');
    await engine.repositories.media.update(privateId, {
      variants: [
        {
          name: 'thumbnail',
          key: variantKey,
          url: `/uploads/${variantKey}`,
          filename: 'priv-thumb.bin',
          mimeType: 'application/octet-stream',
          size: variantContent.length,
        },
      ],
    });

    const url = await engine.repositories.media.getSignedAssetUrl(privateId, { variant: 'thumbnail' });
    const parsed = parseServeUrl(url);
    expect(parsed.variant).toBe('thumbnail');

    const res = await service.handle({
      fileId: parsed.fileId,
      variant: parsed.variant,
      params: {},
      query: parsed.query,
    });
    expect(res.status).toBe(200);
    expect((await readBody(res)).toString()).toBe(variantContent);
  });

  it('expired signature → 403 media.serve.link_expired', async () => {
    const url = await engine.repositories.media.getSignedAssetUrl(privateId, { expiresIn: 1 });
    const { fileId, query } = parseServeUrl(url);
    // expiry is inclusive at `e` (second granularity) — wait past e + 1s.
    await new Promise((resolve) => setTimeout(resolve, 2200));

    const res = await service.handle({ fileId, params: {}, query });
    expect(res.status).toBe(403);
    expect(JSON.parse((await readBody(res)).toString())).toEqual({
      error: { code: 'media.serve.link_expired' },
    });
  });

  it('revokeAccess invalidates already-minted URLs (tokenVersion bump)', async () => {
    const doc = await engine.repositories.media.upload({
      buffer: BUF('revocable'),
      filename: 'rev.bin',
      mimeType: 'application/octet-stream',
      visibility: 'private',
    });
    const url = await engine.repositories.media.getSignedAssetUrl(doc, { expiresIn: 3600 });
    const { fileId, query } = parseServeUrl(url);

    // Sanity: URL works before revocation.
    expect((await service.handle({ fileId, params: {}, query })).status).toBe(200);

    const revoked = await engine.repositories.media.revokeAccess(fileId);
    expect(revoked.tokenVersion).toBe(1);

    const res = await service.handle({ fileId, params: {}, query });
    expect(res.status).toBe(403);
    expect(JSON.parse((await readBody(res)).toString())).toEqual({
      error: { code: 'media.serve.forbidden' },
    });

    // Re-minting after revocation works (new URLs embed the bumped version).
    const freshUrl = await engine.repositories.media.getSignedAssetUrl(fileId);
    const fresh = parseServeUrl(freshUrl);
    expect((await service.handle({ fileId: fresh.fileId, params: {}, query: fresh.query })).status).toBe(200);
  });

  it('authorize → true serves with private, no-store (session path, no per-URL signing)', async () => {
    const authorize = vi.fn().mockResolvedValue(true);
    const sessionService = createAssetTransform({ media: engine, authorize });

    const principal = { userId: 'user_1', organizationId: 'org_1' };
    const res = await sessionService.handle({ fileId: privateId, params: {}, principal });

    expect(res.status).toBe(200);
    expect(res.headers['Cache-Control']).toBe('private, no-store');
    expect((await readBody(res)).toString()).toBe(PRIVATE_CONTENT);

    // The callback receives the full request (incl. opaque principal) + doc.
    expect(authorize).toHaveBeenCalledWith(
      expect.objectContaining({ fileId: privateId, principal }),
      expect.objectContaining({ visibility: 'private' }),
    );
  });

  it('authorize → false → 403', async () => {
    const sessionService = createAssetTransform({ media: engine, authorize: () => false });
    const res = await sessionService.handle({ fileId: privateId, params: {} });
    expect(res.status).toBe(403);
    expect(JSON.parse((await readBody(res)).toString())).toEqual({
      error: { code: 'media.serve.forbidden' },
    });
  });

  it('authorize throwing → 403, not 500 (fail-closed)', async () => {
    const sessionService = createAssetTransform({
      media: engine,
      authorize: () => {
        throw new Error('entitlement service down');
      },
    });
    const res = await sessionService.handle({ fileId: privateId, params: {} });
    expect(res.status).toBe(403);
  });

  it('authorize is NOT consulted for public files', async () => {
    const authorize = vi.fn().mockResolvedValue(false);
    const sessionService = createAssetTransform({ media: engine, authorize });
    const res = await sessionService.handle({ fileId: publicId, params: {} });
    expect(res.status).toBe(200);
    expect(authorize).not.toHaveBeenCalled();
  });

  it('range request on a signed private file → 206 partial content', async () => {
    const url = await engine.repositories.media.getSignedAssetUrl(privateId);
    const { fileId, query } = parseServeUrl(url);

    const res = await service.handle({ fileId, params: {}, query, range: 'bytes=0-6' });
    expect(res.status).toBe(206);
    expect(res.headers['Content-Range']).toBe(`bytes 0-6/${PRIVATE_CONTENT.length}`);
    expect(res.headers['Content-Length']).toBe('7');
    expect((await readBody(res)).toString()).toBe(PRIVATE_CONTENT.slice(0, 7));
    expect(res.headers['Cache-Control']).toMatch(/^private, max-age=\d+$/);
  });

  it('valid signature but expired + authorize=true still serves (session rescue)', async () => {
    const sessionService = createAssetTransform({ media: engine, authorize: () => true });
    const url = await engine.repositories.media.getSignedAssetUrl(privateId, { expiresIn: 1 });
    const { fileId, query } = parseServeUrl(url);
    await new Promise((resolve) => setTimeout(resolve, 2200));

    const res = await sessionService.handle({ fileId, params: {}, query });
    expect(res.status).toBe(200);
    expect(res.headers['Cache-Control']).toBe('private, no-store');
  });

  it('claims ride along and stay signed end-to-end', async () => {
    const url = await engine.repositories.media.getSignedAssetUrl(privateId, {
      claims: { uid: 'user_9', conv: 'c-1' },
    });
    const { fileId, query } = parseServeUrl(url);
    expect(query['c.uid']).toBe('user_9');

    // Untampered → serves.
    expect((await service.handle({ fileId, params: {}, query })).status).toBe(200);

    // Tampered claim → 403.
    const tampered = { ...query, 'c.uid': 'user_10' };
    expect((await service.handle({ fileId, params: {}, query: tampered })).status).toBe(403);
  });
});
