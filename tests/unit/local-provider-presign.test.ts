/**
 * LocalProvider dev presigned PUT (RI-13): off unless explicitly enabled, and the receiver
 * refuses every request it did not sign, with typed (status + code) errors.
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocalProvider, type LocalPresignConfig } from '../../src/providers/local.provider.js';
import { createUrlSigner } from '../../src/signing/index.js';

const UPLOAD_URL = 'http://localhost:3000/media/dev-uploads';
const KEY = 'uploads/1700000000000-abcdef012345-photo.png';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'mk-local-presign-unit-'));
});

afterEach(async () => {
  vi.useRealTimers();
  await rm(dir, { recursive: true, force: true });
});

function provider(presign?: Partial<LocalPresignConfig>) {
  return new LocalProvider({
    basePath: dir,
    baseUrl: '/files',
    ...(presign && { presign: { enabled: true, uploadUrl: UPLOAD_URL, secret: 's3cret', ...presign } }),
  });
}

async function signedQuery(p: LocalProvider, key = KEY, ct = 'image/png', expiresIn?: number) {
  const result = await p.getSignedUploadUrl!(key, ct, expiresIn);
  return { result, query: Object.fromEntries(new URL(result.uploadUrl).searchParams) };
}

async function rejection(promise: Promise<unknown>) {
  const err = await promise.then(
    () => {
      throw new Error('expected a rejection');
    },
    (e: unknown) => e as { status?: number; code?: string },
  );
  return { status: err.status, code: err.code };
}

describe('activation', () => {
  it('without presign: no getSignedUploadUrl, receiver refuses with 404', async () => {
    const p = provider();
    expect(p.getSignedUploadUrl).toBeUndefined();
    expect(await rejection(p.acceptSignedUpload({ query: {}, body: Buffer.from('x') }))).toEqual({
      status: 404,
      code: 'media.upload.receiver_disabled',
    });
  });

  it('enabled: false is off too (only a literal true activates)', async () => {
    const p = provider({ enabled: false });
    expect(typeof p.getSignedUploadUrl).not.toBe('function');
    expect((await rejection(p.acceptSignedUpload({ query: {}, body: Buffer.from('x') }))).status).toBe(404);
  });

  it('enabled: true exposes a PUT on the host receiver', async () => {
    const { result, query } = await signedQuery(provider({}));
    expect(result.uploadUrl.startsWith(`${UPLOAD_URL}?`)).toBe(true);
    expect(result.key).toBe(KEY);
    expect(result.headers).toEqual({ 'Content-Type': 'image/png' });
    expect(result.expiresIn).toBeGreaterThan(890);
    expect(query.key).toBe(KEY);
  });
});

describe('acceptSignedUpload', () => {
  it('writes the body at the signed key', async () => {
    const p = provider({});
    const { query } = await signedQuery(p);
    const res = await p.acceptSignedUpload({
      query,
      contentType: 'image/png; charset=binary',
      body: Buffer.from('png'),
    });
    expect(res).toEqual({ key: KEY, size: 3 });
    expect(await readFile(path.join(dir, KEY), 'utf8')).toBe('png');
    expect(await p.exists(KEY)).toBe(true);
  });

  it('forged, re-keyed or expired signatures are 403 media.upload.signature_invalid', async () => {
    const p = provider({});
    const { query } = await signedQuery(p);
    const body = Buffer.from('x');
    const invalid = { status: 403, code: 'media.upload.signature_invalid' };

    expect(
      await rejection(p.acceptSignedUpload({ query: { ...query, sig: 'AAAA' }, contentType: 'image/png', body })),
    ).toEqual(invalid);
    expect(
      await rejection(
        p.acceptSignedUpload({ query: { ...query, key: 'uploads/other.png' }, contentType: 'image/png', body }),
      ),
    ).toEqual(invalid);
    expect(await rejection(p.acceptSignedUpload({ query: {}, contentType: 'image/png', body }))).toEqual(invalid);

    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 3600_000);
    expect(await rejection(p.acceptSignedUpload({ query, contentType: 'image/png', body }))).toEqual(invalid);
  });

  it('a GET-serve signature from the same secret cannot authorise a write', async () => {
    const p = provider({});
    const serve = createUrlSigner({ secret: 's3cret' }).sign({ id: KEY, claims: { ct: 'image/png' } });
    const query = { key: KEY, ...Object.fromEntries(new URLSearchParams(serve.query)) };
    expect(await rejection(p.acceptSignedUpload({ query, contentType: 'image/png', body: Buffer.from('x') }))).toEqual({
      status: 403,
      code: 'media.upload.signature_invalid',
    });
  });

  it('a Content-Type other than the signed one is 415', async () => {
    const p = provider({});
    const { query } = await signedQuery(p);
    expect(await rejection(p.acceptSignedUpload({ query, contentType: 'text/html', body: Buffer.from('x') }))).toEqual({
      status: 415,
      code: 'media.upload.content_type_mismatch',
    });
  });

  it('empty body is 400, over maxBytes is 413', async () => {
    const p = provider({ maxBytes: 4 });
    const { query } = await signedQuery(p);
    expect(await rejection(p.acceptSignedUpload({ query, contentType: 'image/png', body: Buffer.alloc(0) }))).toEqual({
      status: 400,
      code: 'media.file.empty',
    });
    expect(await rejection(p.acceptSignedUpload({ query, contentType: 'image/png', body: Buffer.alloc(5) }))).toEqual({
      status: 413,
      code: 'media.file.too_large',
    });
  });

  it('signs and expires on the injected clock', async () => {
    let at = new Date('2030-01-01T00:00:00Z');
    const p = provider({ now: () => at, defaultExpiresIn: 60 });
    const { result, query } = await signedQuery(p);
    expect(result.expiresIn).toBe(60);
    expect(query.e).toBe(String(Math.floor(at.getTime() / 1000) + 60));
    at = new Date(at.getTime() + 30_000);
    expect((await p.acceptSignedUpload({ query, contentType: 'image/png', body: Buffer.from('x') })).size).toBe(1);
    at = new Date(at.getTime() + 60_000);
    expect(
      (await rejection(p.acceptSignedUpload({ query, contentType: 'image/png', body: Buffer.from('x') }))).status,
    ).toBe(403);
  });

  it('a traversal key is refused at signing time with 400 media.key.invalid', async () => {
    const p = provider({});
    expect(await rejection(p.getSignedUploadUrl!('../escape.png', 'image/png'))).toEqual({
      status: 400,
      code: 'media.key.invalid',
    });
  });
});
