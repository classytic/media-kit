/**
 * CloudflareImagesProvider — unit tests with mocked global fetch.
 *
 * Mirrors the provider-lazy-secrets pattern (vi.stubGlobal('fetch', ...));
 * no network. Covers:
 *   - construct-time validation + lazy apiToken (LazySecret contract)
 *   - write(): public mode (custom id = generated key preserved) vs private
 *     mode (requireSignedURLs, CF UUID key), CF error-envelope mapping
 *   - delete / exists / stat (details GET + delivery HEAD)
 *   - getPublicUrl delivery-URL shape
 *   - read(): delivery proxy, Range forwarding, local slice on 200
 *   - getSignedUrl(): deterministic HMAC-SHA256 token per the documented
 *     scheme (pathname + '?' + params, hex) — exact-token assertion
 *   - getSignedUploadUrl(): direct_upload with custom id + expiry clamping;
 *     clear unsupported error in private mode
 */

import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CloudflareImagesProvider } from '../../src/providers/cloudflare-images.provider.js';

const CONFIG = {
  accountId: 'test-account',
  apiToken: 'test-token',
  accountHash: 'testhash',
} as const;

const KEY = 'media/1700000000000-abcdefabcdef-photo.jpg';
const API_V1 = 'https://api.cloudflare.com/client/v4/accounts/test-account/images/v1';
const DELIVERY = `https://imagedelivery.net/testhash/${KEY}/public`;

function cfOk(result: unknown, status = 200): Response {
  return new Response(JSON.stringify({ success: true, result, errors: [] }), { status });
}

function cfError(status: number, message: string): Response {
  return new Response(JSON.stringify({ success: false, result: null, errors: [{ code: 5400, message }] }), {
    status,
  });
}

function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// ── Construction ─────────────────────────────────────────────────────────────

describe('CloudflareImagesProvider — construction', () => {
  it('throws on missing accountId / accountHash / apiToken', () => {
    expect(() => new CloudflareImagesProvider({ ...CONFIG, accountId: '' })).toThrow(/accountId is required/);
    expect(() => new CloudflareImagesProvider({ ...CONFIG, accountHash: '' })).toThrow(/accountHash is required/);
    expect(() => new CloudflareImagesProvider({ ...CONFIG, apiToken: '' })).toThrow(
      /CloudflareImagesProvider: apiToken is required/,
    );
  });

  it('throws on empty signing.key', () => {
    expect(() => new CloudflareImagesProvider({ ...CONFIG, signing: { key: '' } })).toThrow(/signing\.key/);
  });

  it('constructs without firing a lazy apiToken resolver (boot without secret)', () => {
    const resolver = vi.fn(() => 'token-from-vault');
    new CloudflareImagesProvider({ ...CONFIG, apiToken: resolver });
    expect(resolver).not.toHaveBeenCalled();
  });

  it('fires the resolver on first API call and memoizes it', async () => {
    const resolver = vi.fn(async () => 'token-from-vault');
    const provider = new CloudflareImagesProvider({ ...CONFIG, apiToken: resolver });
    fetchMock.mockResolvedValue(cfOk({ id: KEY }));

    await provider.exists(KEY);
    await provider.exists(KEY);

    expect(resolver).toHaveBeenCalledTimes(1);
    const headers = (fetchMock.mock.calls[0]?.[1] as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer token-from-vault');
  });
});

// ── write ────────────────────────────────────────────────────────────────────

describe('CloudflareImagesProvider — write()', () => {
  it('public mode: uploads with custom id = generated key and preserves the key', async () => {
    const provider = new CloudflareImagesProvider(CONFIG);
    fetchMock.mockResolvedValue(
      cfOk({
        id: KEY,
        filename: 'photo.jpg',
        uploaded: '2026-07-01T00:00:00.000Z',
        requireSignedURLs: false,
        variants: [DELIVERY],
      }),
    );

    const data = Buffer.from('fake-image-bytes');
    const result = await provider.write(KEY, data, 'image/jpeg');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(API_V1);
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer test-token');

    const form = init.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    expect(form.get('id')).toBe(KEY);
    expect(form.get('requireSignedURLs')).toBeNull();
    expect(form.get('file')).toBeInstanceOf(Blob);

    expect(result.key).toBe(KEY);
    expect(result.url).toBe(DELIVERY);
    expect(result.size).toBe(data.length);
    expect(result.metadata).toMatchObject({ id: KEY, filename: 'photo.jpg', requireSignedURLs: false });
  });

  it('accepts a ReadableStream body', async () => {
    const provider = new CloudflareImagesProvider(CONFIG);
    fetchMock.mockResolvedValue(cfOk({ id: KEY }));

    const data = Buffer.from('streamed-bytes');
    const result = await provider.write(KEY, Readable.from(data), 'image/png');
    expect(result.size).toBe(data.length);
  });

  it('private mode: sends requireSignedURLs, omits custom id, stores the CF UUID as key', async () => {
    const provider = new CloudflareImagesProvider({ ...CONFIG, signing: { key: 'test-signing-key' } });
    const cfUuid = '2cdc28f0-017a-49c4-9ed7-87056c83901f';
    fetchMock.mockResolvedValue(cfOk({ id: cfUuid, requireSignedURLs: true }));

    const result = await provider.write(KEY, Buffer.from('x'), 'image/jpeg');

    const form = (fetchMock.mock.calls[0]?.[1] as RequestInit).body as FormData;
    expect(form.get('requireSignedURLs')).toBe('true');
    expect(form.get('id')).toBeNull();

    expect(result.key).toBe(cfUuid);
    expect(result.url).toBe(`https://imagedelivery.net/testhash/${cfUuid}/public`);
  });

  it('maps the CF error envelope (success:false) to a thrown error', async () => {
    const provider = new CloudflareImagesProvider(CONFIG);
    fetchMock.mockResolvedValue(cfError(400, 'Invalid custom ID'));

    await expect(provider.write(KEY, Buffer.from('x'), 'image/jpeg')).rejects.toThrow(
      /Cloudflare Images upload failed \(400\): Invalid custom ID/,
    );
  });

  it('throws on a non-JSON error response without masking the status', async () => {
    const provider = new CloudflareImagesProvider(CONFIG);
    fetchMock.mockResolvedValue(new Response('<html>bad gateway</html>', { status: 502 }));

    await expect(provider.write(KEY, Buffer.from('x'), 'image/jpeg')).rejects.toThrow(
      /Cloudflare Images upload failed \(502\): unknown error/,
    );
  });
});

// ── delete ───────────────────────────────────────────────────────────────────

describe('CloudflareImagesProvider — delete()', () => {
  it('DELETEs /images/v1/{id} and returns true on success', async () => {
    const provider = new CloudflareImagesProvider(CONFIG);
    fetchMock.mockResolvedValue(cfOk({}));

    expect(await provider.delete(KEY)).toBe(true);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${API_V1}/${KEY}`);
    expect(init.method).toBe('DELETE');
  });

  it('treats 404 as already deleted', async () => {
    const provider = new CloudflareImagesProvider(CONFIG);
    fetchMock.mockResolvedValue(new Response('', { status: 404 }));
    expect(await provider.delete(KEY)).toBe(true);
  });

  it('throws with the envelope message on failure', async () => {
    const provider = new CloudflareImagesProvider(CONFIG);
    fetchMock.mockResolvedValue(cfError(403, 'Unauthorized to delete'));
    await expect(provider.delete(KEY)).rejects.toThrow(
      /Cloudflare Images delete failed \(403\): Unauthorized to delete/,
    );
  });
});

// ── exists / stat ────────────────────────────────────────────────────────────

describe('CloudflareImagesProvider — exists() / stat()', () => {
  it('exists() GETs image details and reflects res.ok', async () => {
    const provider = new CloudflareImagesProvider(CONFIG);
    fetchMock.mockResolvedValueOnce(cfOk({ id: KEY }));
    expect(await provider.exists(KEY)).toBe(true);

    fetchMock.mockResolvedValueOnce(new Response('', { status: 404 }));
    expect(await provider.exists(KEY)).toBe(false);
  });

  it('stat() merges details (identity) with a delivery HEAD (bytes)', async () => {
    const provider = new CloudflareImagesProvider(CONFIG);
    fetchMock
      .mockResolvedValueOnce(
        cfOk({ id: KEY, filename: 'photo.jpg', uploaded: '2026-07-01T12:00:00.000Z', requireSignedURLs: false }),
      )
      .mockResolvedValueOnce(
        new Response(null, {
          status: 200,
          headers: { 'content-length': '4321', 'content-type': 'image/jpeg' },
        }),
      );

    const stat = await provider.stat(KEY);

    expect(fetchMock.mock.calls[0]?.[0]).toBe(`${API_V1}/${KEY}`);
    expect(fetchMock.mock.calls[1]?.[0]).toBe(DELIVERY);
    expect((fetchMock.mock.calls[1]?.[1] as RequestInit).method).toBe('HEAD');

    expect(stat.size).toBe(4321);
    expect(stat.contentType).toBe('image/jpeg');
    expect(stat.lastModified).toEqual(new Date('2026-07-01T12:00:00.000Z'));
    expect(stat.metadata).toMatchObject({ filename: 'photo.jpg', requireSignedURLs: 'false' });
  });

  it('stat() survives a failing delivery HEAD (size 0 fallback)', async () => {
    const provider = new CloudflareImagesProvider(CONFIG);
    fetchMock.mockResolvedValueOnce(cfOk({ id: KEY })).mockRejectedValueOnce(new Error('network down'));

    const stat = await provider.stat(KEY);
    expect(stat.size).toBe(0);
    expect(stat.contentType).toBe('application/octet-stream');
  });

  it('stat() throws for a missing image', async () => {
    const provider = new CloudflareImagesProvider(CONFIG);
    fetchMock.mockResolvedValue(cfError(404, 'Image not found'));
    await expect(provider.stat(KEY)).rejects.toThrow(/Cloudflare Images stat failed \(404\): Image not found/);
  });
});

// ── getPublicUrl ─────────────────────────────────────────────────────────────

describe('CloudflareImagesProvider — getPublicUrl()', () => {
  it('builds imagedelivery.net/{accountHash}/{key}/{defaultVariant}', () => {
    const provider = new CloudflareImagesProvider(CONFIG);
    expect(provider.getPublicUrl(KEY)).toBe(DELIVERY);
  });

  it('honors a custom defaultVariant and exposes getVariantUrl()', () => {
    const provider = new CloudflareImagesProvider({ ...CONFIG, defaultVariant: 'hero' });
    expect(provider.getPublicUrl(KEY)).toBe(`https://imagedelivery.net/testhash/${KEY}/hero`);
    expect(provider.getVariantUrl(KEY, 'w=400,sharpen=3')).toBe(
      `https://imagedelivery.net/testhash/${KEY}/w=400,sharpen=3`,
    );
  });
});

// ── read ─────────────────────────────────────────────────────────────────────

describe('CloudflareImagesProvider — read()', () => {
  it('proxies a GET to the delivery URL and returns the byte stream', async () => {
    const provider = new CloudflareImagesProvider(CONFIG);
    const bytes = Buffer.from('image-bytes-here');
    fetchMock.mockResolvedValue(new Response(new Uint8Array(bytes), { status: 200 }));

    const stream = await provider.read(KEY);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(DELIVERY);
    expect(await streamToBuffer(stream)).toEqual(bytes);
  });

  it('forwards Range and passes a 206 partial body through untouched', async () => {
    const provider = new CloudflareImagesProvider(CONFIG);
    const partial = Buffer.from('bcde');
    fetchMock.mockResolvedValue(new Response(new Uint8Array(partial), { status: 206 }));

    const stream = await provider.read(KEY, { start: 1, end: 4 });
    const headers = (fetchMock.mock.calls[0]?.[1] as RequestInit).headers as Record<string, string>;
    expect(headers.Range).toBe('bytes=1-4');
    expect(await streamToBuffer(stream)).toEqual(partial);
  });

  it('slices the window locally when the CDN ignores Range (200 full body)', async () => {
    const provider = new CloudflareImagesProvider(CONFIG);
    fetchMock.mockResolvedValue(new Response(new Uint8Array(Buffer.from('abcdefgh')), { status: 200 }));

    const stream = await provider.read(KEY, { start: 2, end: 5 });
    expect(await streamToBuffer(stream)).toEqual(Buffer.from('cdef'));
  });

  it('throws on a non-OK delivery response', async () => {
    const provider = new CloudflareImagesProvider(CONFIG);
    fetchMock.mockResolvedValue(new Response('denied', { status: 403 }));
    await expect(provider.read(KEY)).rejects.toThrow(/Cloudflare Images read failed \(403\)/);
  });

  it('private mode: reads through a SIGNED delivery URL', async () => {
    const provider = new CloudflareImagesProvider({ ...CONFIG, signing: { key: 'test-signing-key' } });
    fetchMock.mockResolvedValue(new Response(new Uint8Array(Buffer.from('x')), { status: 200 }));

    await provider.read(KEY);
    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url).toContain('exp=');
    expect(url).toContain('sig=');
  });
});

// ── getSignedUrl (delivery tokens) ───────────────────────────────────────────

describe('CloudflareImagesProvider — getSignedUrl()', () => {
  it('produces the exact documented HMAC-SHA256 hex token for a fixed input', async () => {
    // Scheme (developers.cloudflare.com serve-private-images): sign
    // `${pathname}?${searchParams}` with exp present, hex-encode, append as sig.
    // Expected value precomputed independently with node:crypto:
    //   HMAC-SHA256('test-signing-key',
    //     '/testhash/media/1700000000000-abcdefabcdef-photo.jpg/public?exp=1700003600')
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1_700_000_000 * 1000));

    const provider = new CloudflareImagesProvider({ ...CONFIG, signing: { key: 'test-signing-key' } });
    const url = await provider.getSignedUrl(KEY, 3600);

    expect(url).toBe(
      `${DELIVERY}?exp=1700003600&sig=86824ca48a4694cb9e240ba6697d18bcf222f22013765288fb03bb2ee570cd9d`,
    );
  });

  it('getSignedVariantUrl() signs the variant path, so tokens differ per variant', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1_700_000_000 * 1000));

    const provider = new CloudflareImagesProvider({ ...CONFIG, signing: { key: 'test-signing-key' } });
    const publicUrl = await provider.getSignedUrl(KEY, 3600);
    const thumbUrl = provider.getSignedVariantUrl(KEY, 'thumbnail', 3600);

    expect(thumbUrl).toContain('/thumbnail?exp=1700003600&sig=');
    expect(new URL(thumbUrl).searchParams.get('sig')).not.toBe(new URL(publicUrl).searchParams.get('sig'));
  });

  it('throws a clear error when signing is not configured', async () => {
    const provider = new CloudflareImagesProvider(CONFIG);
    await expect(provider.getSignedUrl(KEY)).rejects.toThrow(/requires signing\.key/);
  });
});

// ── getSignedUploadUrl (direct creator upload) ───────────────────────────────

describe('CloudflareImagesProvider — getSignedUploadUrl()', () => {
  it('POSTs /images/v2/direct_upload with the generated key as custom id', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-01T00:00:00.000Z'));

    const provider = new CloudflareImagesProvider(CONFIG);
    fetchMock.mockResolvedValue(
      cfOk({ id: KEY, uploadURL: 'https://upload.imagedelivery.net/testhash/one-time-token' }),
    );

    const result = await provider.getSignedUploadUrl(KEY, 'image/jpeg', 1800);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.cloudflare.com/client/v4/accounts/test-account/images/v2/direct_upload');
    expect(init.method).toBe('POST');

    const form = init.body as FormData;
    expect(form.get('id')).toBe(KEY);
    expect(form.get('expiry')).toBe('2026-07-01T00:30:00.000Z'); // now + 1800s

    expect(result).toEqual({
      uploadUrl: 'https://upload.imagedelivery.net/testhash/one-time-token',
      key: KEY, // generated key preserved → confirmUpload() shape check passes
      publicUrl: DELIVERY,
      expiresIn: 1800,
    });
  });

  it('clamps expiresIn to the Cloudflare window (2 min – 6 h)', async () => {
    const provider = new CloudflareImagesProvider(CONFIG);
    // Fresh Response per call — a Response body is single-use.
    fetchMock.mockImplementation(async () => cfOk({ id: KEY, uploadURL: 'https://upload.example/u' }));

    expect((await provider.getSignedUploadUrl(KEY, 'image/png', 5)).expiresIn).toBe(120);
    expect((await provider.getSignedUploadUrl(KEY, 'image/png', 999_999)).expiresIn).toBe(21_600);
  });

  it('maps the CF error envelope to a thrown error', async () => {
    const provider = new CloudflareImagesProvider(CONFIG);
    fetchMock.mockResolvedValue(cfError(409, 'Duplicate custom ID'));
    await expect(provider.getSignedUploadUrl(KEY, 'image/png')).rejects.toThrow(
      /Cloudflare Images direct_upload failed \(409\): Duplicate custom ID/,
    );
  });

  it('private mode: throws a clear unsupported error instead of a broken flow', async () => {
    const provider = new CloudflareImagesProvider({ ...CONFIG, signing: { key: 'k' } });
    await expect(provider.getSignedUploadUrl(KEY, 'image/png')).rejects.toThrow(
      /unsupported in private mode.*Use server-side upload\(\)/s,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ── Unsupported ops stay undefined (engine feature-detects) ─────────────────

describe('CloudflareImagesProvider — unsupported operations', () => {
  it('leaves list/copy/move/multipart/resumable undefined', () => {
    const provider = new CloudflareImagesProvider(CONFIG);
    const driver = provider as import('../../src/types.js').StorageDriver;
    expect(driver.list).toBeUndefined();
    expect(driver.copy).toBeUndefined();
    expect(driver.move).toBeUndefined();
    expect(driver.createMultipartUpload).toBeUndefined();
    expect(driver.createResumableUpload).toBeUndefined();
  });
});
