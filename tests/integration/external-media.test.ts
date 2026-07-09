/**
 * Integration tests — EXTERNAL (reference-only) media records.
 *
 * `registerExternal()` registers a third-party-hosted URL as a first-class
 * media record without media-kit owning the bytes. Covers:
 *   - happy path: record shape, sentinel key, ready status, event
 *   - tenancy stamping + tenant scoping
 *   - visibility precedence (explicit > byFolder > default)
 *   - invalid / non-http(s) URL rejection (typed 400)
 *   - external.allowedOrigins enforcement (typed 403)
 *   - hardDelete is DB-only (driver.delete never called)
 *   - purgeExpired on an expired external record is storage-safe
 *   - serve path: 302 redirect (public raw), 400 external_no_bytes
 *     (transforms/variants), 403 for private-unsigned
 *   - getContextPayload / applyTransforms / replace typed errors
 *   - move()/renameFolder() are DB-only for external records (no storage ops)
 *   - isKeyRegistered sees the sentinel key; confirmUpload can never claim it
 */

import { describe, it, expect, afterAll, beforeEach, afterEach, vi } from 'vitest';
import type { HttpError } from '@classytic/repo-core/errors';
import { createTestEngine, teardownTestMongo, type TestEngineHandle } from '../helpers/create-test-engine.js';
import { createAssetTransform } from '../../src/transforms/asset-transform.js';
import { MEDIA_EVENTS } from '../../src/events/event-constants.js';
import { EXTERNAL_PROVIDER, buildExternalKey, externalUrlHash } from '../../src/utils/external.js';
import type { TransformResponse } from '../../src/types.js';
import type { DomainEvent } from '@classytic/primitives/events';

const URL_CF = 'https://imagedelivery.net/acct/uuid-1234/public';
const ORG_A = '507f1f77bcf86cd799439011';
const ORG_B = '507f1f77bcf86cd799439012';

async function readBody(res: TransformResponse): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of res.stream as AsyncIterable<Buffer | string>) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function expectHttpError(promise: Promise<unknown>, statusCode: number, code: string): Promise<HttpError> {
  try {
    await promise;
  } catch (err) {
    const httpErr = err as HttpError;
    expect(httpErr.status).toBe(statusCode);
    expect(httpErr.code).toBe(code);
    return httpErr;
  }
  throw new Error(`expected a ${statusCode} ${code} error`);
}

afterAll(async () => {
  await teardownTestMongo();
});

describe('registerExternal — happy path', () => {
  let handle: TestEngineHandle;

  beforeEach(async () => {
    handle = await createTestEngine();
  });

  afterEach(async () => {
    await handle.cleanup();
  });

  it('creates a ready record with the external sentinel shape + emits the event', async () => {
    const repo = handle.engine.repositories.media;
    const events: DomainEvent[] = [];
    await handle.engine.events.subscribe(MEDIA_EVENTS.ASSET_EXTERNAL_REGISTERED, async (e) => {
      events.push(e);
    });

    const media = await repo.registerExternal({
      url: URL_CF,
      mimeType: 'image/png',
      size: 4096,
      folder: 'landing/heroes',
      tags: ['hero'],
      alt: 'Hero',
      metadata: { campaign: 'q3' },
      sourceProvider: 'cloudflare-images',
      width: 1280,
      height: 960,
      thumbhash: '3OcRJYB4d3h/iIeHeEh3eIhw+j2w',
      dominantColor: '#8a6f4b',
    });

    expect(media.status).toBe('ready');
    expect(media.provider).toBe(EXTERNAL_PROVIDER);
    expect(media.url).toBe(URL_CF);
    expect(media.key).toBe(buildExternalKey(URL_CF));
    expect(media.key).toMatch(/^__external__\/[0-9a-f]{16}$/);
    expect(media.hash).toBe(externalUrlHash(URL_CF));
    expect(media.folder).toBe('landing/heroes');
    // Filename derived from the URL's last path segment
    expect(media.filename).toBe('public');
    expect(media.mimeType).toBe('image/png');
    expect(media.size).toBe(4096);
    expect(media.tags).toEqual(['hero']);
    expect(media.alt).toBe('Hero');
    expect(media.metadata).toMatchObject({ campaign: 'q3' });
    expect(media.providerMetadata).toMatchObject({ sourceProvider: 'cloudflare-images' });
    expect(media.width).toBe(1280);
    expect(media.height).toBe(960);
    expect(media.aspectRatio).toBe(1280 / 960);
    expect(media.thumbhash).toBe('3OcRJYB4d3h/iIeHeEh3eIhw+j2w');
    expect(media.dominantColor).toBe('#8a6f4b');
    expect(media.variants).toEqual([]);
    expect(media.tokenVersion).toBe(0);

    // Nothing written to storage
    expect(handle.driver.size).toBe(0);

    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toMatchObject({
      assetId: String(media._id),
      url: URL_CF,
      sourceProvider: 'cloudflare-images',
      key: media.key,
      folder: 'landing/heroes',
    });
  });

  it('applies defaults: filename fallback, octet-stream mime, size 0, sourceProvider "external"', async () => {
    const repo = handle.engine.repositories.media;
    const media = await repo.registerExternal({ url: 'https://cdn.partner.example/' });

    expect(media.filename).toBe(`external-${externalUrlHash('https://cdn.partner.example/').slice(0, 16)}`);
    expect(media.mimeType).toBe('application/octet-stream');
    expect(media.size).toBe(0);
    expect(media.folder).toBe('general');
    expect(media.providerMetadata).toMatchObject({ sourceProvider: 'external' });
    expect(media.title).toBeDefined();
  });

  it('is listable + findable via existsByHash (hash = sha256 of url)', async () => {
    const repo = handle.engine.repositories.media;
    const media = await repo.registerExternal({ url: URL_CF });

    const result = await repo.existsByHash(externalUrlHash(URL_CF));
    expect(result.exists).toBe(true);
    expect(String(result.media!._id)).toBe(String(media._id));
  });
});

describe('registerExternal — validation + allowlist', () => {
  let handle: TestEngineHandle;

  afterEach(async () => {
    await handle.cleanup();
  });

  it.each([
    'javascript:alert(1)',
    'data:image/png;base64,AAAA',
    '/relative/img.png',
    'ftp://host/x.png',
  ])('rejects %s with 400 media.external.invalid_url', async (url) => {
    handle = await createTestEngine();
    await expectHttpError(
      handle.engine.repositories.media.registerExternal({ url }),
      400,
      'media.external.invalid_url',
    );
  });

  it('enforces external.allowedOrigins: match passes, mismatch → 403', async () => {
    handle = await createTestEngine({
      external: { allowedOrigins: ['https://imagedelivery.net', 'https://cdn.partner.example'] },
    });
    const repo = handle.engine.repositories.media;

    const ok = await repo.registerExternal({ url: URL_CF });
    expect(ok.url).toBe(URL_CF);

    await expectHttpError(
      repo.registerExternal({ url: 'https://evil.example/img.png' }),
      403,
      'media.external.origin_not_allowed',
    );
    // Same host, different scheme is a different origin
    await expectHttpError(
      repo.registerExternal({ url: 'http://imagedelivery.net/x.png' }),
      403,
      'media.external.origin_not_allowed',
    );
  });
});

describe('registerExternal — tenancy + visibility precedence', () => {
  let handle: TestEngineHandle;

  afterEach(async () => {
    await handle.cleanup();
  });

  it('stamps the tenant and scopes reads like any other create', async () => {
    handle = await createTestEngine({
      tenant: { enabled: true, fieldType: 'string', tenantField: 'organizationId', required: true },
    });
    const repo = handle.engine.repositories.media;

    const media = await repo.registerExternal({ url: URL_CF }, { organizationId: ORG_A });
    expect(String(media.organizationId)).toBe(ORG_A);

    // Cross-tenant read misses (existence-oracle stance, same as uploads)
    const crossTenant = await repo.existsByHash(externalUrlHash(URL_CF), { organizationId: ORG_B });
    expect(crossTenant.exists).toBe(false);
    const sameTenant = await repo.existsByHash(externalUrlHash(URL_CF), { organizationId: ORG_A });
    expect(sameTenant.exists).toBe(true);
  });

  it('resolves visibility: explicit > byFolder > default', async () => {
    handle = await createTestEngine({
      visibility: { default: 'public', byFolder: { invoices: 'private' } },
    });
    const repo = handle.engine.repositories.media;

    const byFolder = await repo.registerExternal({ url: `${URL_CF}?v=1`, folder: 'invoices/2026' });
    expect(byFolder.visibility).toBe('private');

    const explicit = await repo.registerExternal({
      url: `${URL_CF}?v=2`,
      folder: 'invoices/2026',
      visibility: 'public',
    });
    expect(explicit.visibility).toBe('public');

    const fallthrough = await repo.registerExternal({ url: `${URL_CF}?v=3`, folder: 'general' });
    expect(fallthrough.visibility).toBe('public');
  });
});

describe('external records — storage-op safety', () => {
  let handle: TestEngineHandle;

  beforeEach(async () => {
    handle = await createTestEngine();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await handle.cleanup();
  });

  it('hardDelete removes the row WITHOUT calling driver.delete', async () => {
    const repo = handle.engine.repositories.media;
    const media = await repo.registerExternal({ url: URL_CF });
    const deleteSpy = vi.spyOn(handle.driver, 'delete');

    const deleted = await repo.hardDelete(String(media._id));

    expect(deleted).toBe(true);
    expect(deleteSpy).not.toHaveBeenCalled();
    expect(await repo.getById(String(media._id), { throwOnNotFound: false })).toBeNull();
  });

  it('purgeExpired on an expired external record is storage-safe', async () => {
    const repo = handle.engine.repositories.media;
    const media = await repo.registerExternal({ url: URL_CF });
    await repo.update(String(media._id), { expiresAt: new Date(Date.now() - 1000) });
    const deleteSpy = vi.spyOn(handle.driver, 'delete');

    const result = await repo.purgeExpired();

    expect(result.success).toContain(String(media._id));
    expect(result.failed).toEqual([]);
    expect(deleteSpy).not.toHaveBeenCalled();
    expect(await repo.getById(String(media._id), { throwOnNotFound: false })).toBeNull();
  });

  it('move() with key rewriting enabled is DB-only for external records', async () => {
    const repo = handle.engine.repositories.media;
    const media = await repo.registerExternal({ url: URL_CF, folder: 'a' });
    const copySpy = vi.spyOn(handle.driver, 'copy');
    const deleteSpy = vi.spyOn(handle.driver, 'delete');

    const result = await repo.move([String(media._id)], 'b');

    expect(result.modifiedCount).toBe(1);
    expect(result.failed).toEqual([]);
    expect(copySpy).not.toHaveBeenCalled();
    expect(deleteSpy).not.toHaveBeenCalled();
    const moved = await repo.getById(String(media._id));
    expect(moved!.folder).toBe('b');
    expect(moved!.key).toBe(buildExternalKey(URL_CF)); // sentinel key untouched
  });

  it('renameFolder() with key rewriting enabled is DB-only for external records', async () => {
    const repo = handle.engine.repositories.media;
    const media = await repo.registerExternal({ url: URL_CF, folder: 'campaigns/q3' });
    const copySpy = vi.spyOn(handle.driver, 'copy');

    const result = await repo.renameFolder('campaigns/q3', 'campaigns/q4');

    expect(result.modifiedCount).toBe(1);
    expect(copySpy).not.toHaveBeenCalled();
    const renamed = await repo.getById(String(media._id));
    expect(renamed!.folder).toBe('campaigns/q4');
    expect(renamed!.key).toBe(buildExternalKey(URL_CF));
  });

  it('replace() throws a typed 400 media.external.no_bytes', async () => {
    const repo = handle.engine.repositories.media;
    const media = await repo.registerExternal({ url: URL_CF });
    await expectHttpError(
      repo.replace(String(media._id), { buffer: Buffer.from('x'), filename: 'x.png', mimeType: 'image/png' }),
      400,
      'media.external.no_bytes',
    );
  });

  it('getContextPayload() throws a typed 400 media.context.external', async () => {
    const repo = handle.engine.repositories.media;
    const media = await repo.registerExternal({ url: URL_CF });
    await expectHttpError(repo.getContextPayload(String(media._id)), 400, 'media.context.external');
  });

  it('isKeyRegistered sees the sentinel key, and confirmUpload can never claim it', async () => {
    const repo = handle.engine.repositories.media;
    const media = await repo.registerExternal({ url: URL_CF });

    expect(await repo.isKeyRegistered(media.key)).toBe(true);

    // The sentinel basename can't match the generated-key shape → typed 400
    await expectHttpError(
      repo.confirmUpload({ key: media.key, filename: 'x.png', mimeType: 'image/png', size: 1 }),
      400,
      'media.confirm.invalid_key',
    );
  });
});

describe('external records — serve path (AssetTransformService)', () => {
  let handle: TestEngineHandle;

  beforeEach(async () => {
    handle = await createTestEngine();
  });

  afterEach(async () => {
    await handle.cleanup();
  });

  it('raw serve of a public external record → 302 redirect to the stored URL', async () => {
    const repo = handle.engine.repositories.media;
    const media = await repo.registerExternal({ url: URL_CF, mimeType: 'image/png' });
    const transform = createAssetTransform({ media: handle.engine });

    const res = await transform.handle({ fileId: String(media._id), params: {} });

    expect(res.status).toBe(302);
    expect(res.headers.Location).toBe(URL_CF);
    expect(res.headers['Cache-Control']).toBe('public, max-age=3600');
    expect((await readBody(res)).length).toBe(0);
  });

  it('transform params on an external record → 400 media.serve.external_no_bytes with the url in the body', async () => {
    const repo = handle.engine.repositories.media;
    const media = await repo.registerExternal({ url: URL_CF, mimeType: 'image/png' });
    const transform = createAssetTransform({ media: handle.engine });

    const res = await transform.handle({ fileId: String(media._id), params: { w: 200 } });

    expect(res.status).toBe(400);
    expect(res.contentType).toBe('application/json');
    expect(JSON.parse((await readBody(res)).toString('utf-8'))).toEqual({
      error: { code: 'media.serve.external_no_bytes', url: URL_CF },
    });
  });

  it('variant request on an external record → 400 media.serve.external_no_bytes', async () => {
    const repo = handle.engine.repositories.media;
    const media = await repo.registerExternal({ url: URL_CF });
    const transform = createAssetTransform({ media: handle.engine });

    const res = await transform.handle({ fileId: String(media._id), variant: 'thumb', params: {} });

    expect(res.status).toBe(400);
  });

  it('private external record without a signature → 403 BEFORE any redirect leaks the URL', async () => {
    const repo = handle.engine.repositories.media;
    const media = await repo.registerExternal({ url: URL_CF, visibility: 'private' });
    const transform = createAssetTransform({ media: handle.engine });

    const res = await transform.handle({ fileId: String(media._id), params: {} });

    expect(res.status).toBe(403);
    expect(res.headers.Location).toBeUndefined();
    expect(JSON.parse((await readBody(res)).toString('utf-8'))).toEqual({
      error: { code: 'media.serve.forbidden' },
    });
  });

  it('private external record approved by authorize() → 302 with private no-store cache', async () => {
    const repo = handle.engine.repositories.media;
    const media = await repo.registerExternal({ url: URL_CF, visibility: 'private' });
    const transform = createAssetTransform({ media: handle.engine, authorize: async () => true });

    const res = await transform.handle({ fileId: String(media._id), params: {} });

    expect(res.status).toBe(302);
    expect(res.headers.Location).toBe(URL_CF);
    expect(res.headers['Cache-Control']).toBe('private, no-store');
  });
});
