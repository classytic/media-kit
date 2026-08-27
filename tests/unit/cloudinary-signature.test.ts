/**
 * The Cloudinary signature must match the OFFICIAL SDK, byte for byte.
 *
 * This provider hand-rolls the signature rather than depending on `cloudinary`
 * (an optional peer nobody should be forced to install to use a different
 * driver). A hand-rolled crypto contract silently diverging from the service it
 * signs for is the failure this pins: a wrong signature is not a crash, it is a
 * 401 from an upload that used to work.
 *
 * It previously computed SIGNATURE VERSION 1 — no `&` encoding. v2 (the SDK
 * default) percent-encodes `&` inside each `k=v` pair, so without it a
 * `public_id` containing `&` splits into extra parameters when Cloudinary
 * parses the signed string: a caller could smuggle parameters the signer never
 * authorised. The third case below is exactly that input.
 *
 * The expectations are the algorithm transcribed from
 * `cloudinary/lib/utils/index.js` (`api_string_to_sign` + `api_sign_request`),
 * not copied hashes — a hash fixture would pin our own bug if we had one.
 */
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';

/** The SDK's algorithm, transcribed: sort, drop empties, encode `&`, join. */
function sdkSign(params: Record<string, string>, apiSecret: string, version = 2): string {
  const str = Object.entries(params)
    .filter(([, v]) => v !== null && v !== undefined && v !== '')
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => {
      const pair = `${k}=${v}`;
      return version >= 2 ? pair.replace(/&/g, '%26') : pair;
    })
    .join('&');
  return createHash('sha1')
    .update(str + apiSecret)
    .digest('hex');
}

/**
 * The provider's `sign` is module-private and it stamps its own timestamp, so
 * the check RECONSTRUCTS the expected signature from the fields it returned and
 * compares. That closes the loop on the real output — an earlier version of
 * this test compared a transcription to itself and passed happily with v1
 * signing restored, which is no test at all.
 */
async function signedUpload(apiSecret: string, key = 'folder/name.jpg', mime = 'image/jpeg') {
  const { CloudinaryProvider } = await import('../../src/providers/cloudinary.provider.js');
  const p = new CloudinaryProvider({ cloudName: 'demo', apiKey: 'k', apiSecret });
  return p.getSignedUploadUrl(key, mime);
}

/** Rebuild what the SDK would sign for the params the provider actually sent. */
function expectedFor(fields: Record<string, string>, apiSecret: string, version = 2): string {
  const { api_key: _a, signature: _s, ...signed } = fields;
  return sdkSign(signed, apiSecret, version);
}

const SECRET = 'test-secret-123';

describe('Cloudinary signature — parity with the official SDK', () => {
  it('the signature the provider emits IS the SDK v2 signature', async () => {
    const res = await signedUpload(SECRET);
    const fields = res.fields as Record<string, string>;
    expect(fields.signature).toBe(expectedFor(fields, SECRET, 2));
  });

  it('and is NOT the v1 signature when a value contains `&`', async () => {
    // v1 and v2 only diverge on `&`, so this is the input that proves which
    // version is in force. Without it, reverting to v1 passes every assertion.
    const res = await signedUpload(SECRET, 'a&b/weird-name.jpg');
    const fields = res.fields as Record<string, string>;
    expect(fields.public_id).toContain('&');
    expect(fields.signature).toBe(expectedFor(fields, SECRET, 2));
    expect(fields.signature).not.toBe(expectedFor(fields, SECRET, 1));
  });

  it('the signed-upload result carries what a multipart POST needs', async () => {
    const res = await signedUpload(SECRET);
    expect(res.method).toBe('POST');
    expect(res.fileField).toBe('file');
    expect(res.fields?.api_key).toBe('k');
    expect(res.fields?.signature).toMatch(/^[0-9a-f]{40}$/);
    expect(res.fields?.timestamp).toMatch(/^\d+$/);
    // A PUT-shaped result would be silently unusable: Cloudinary needs the
    // fields alongside the file, and a client that only PUT the body gets 401.
    expect(res.fields?.public_id).toBeTruthy();
  });

  it('returns the GENERATED key, so the confirmUpload security check still passes', async () => {
    const res = await signedUpload(SECRET, 'folder/name.jpg');
    // `confirmUpload` runs `assertGeneratedKeyShape`, which only accepts a
    // server-minted basename. Returning Cloudinary's composite key made every
    // confirm 400 — the upload succeeded and the record was never written.
    expect(res.key).toBe('folder/name.jpg');
    expect(res.key).not.toContain(String.fromCharCode(10));
    // The publicId the upload will create is derived from that key, and the
    // reported URL must point at it or the record references nothing.
    expect(res.fields?.public_id).toBe('folder/name');
    expect(res.publicUrl).toContain('folder/name');
  });

  it('pins the resource type instead of relying on auto-detection', async () => {
    const pdf = await signedUpload(SECRET, 'docs/manual.pdf', 'application/pdf');
    // `auto` leaves the resolved type unknowable until Cloudinary answers — and
    // the browser gets that answer, not us.
    expect(pdf.uploadUrl).toContain('/raw/upload');
    const img = await signedUpload(SECRET, 'a/b.jpg', 'image/jpeg');
    expect(img.uploadUrl).toContain('/image/upload');
  });

  it('a raw file keeps its extension in the public id; an image does not', async () => {
    // Cloudinary stores an image's format separately, so the extension must be
    // stripped or the asset lands at `name.jpg` and reads back as missing.
    const pdf = await signedUpload(SECRET, 'docs/manual.pdf', 'application/pdf');
    expect(pdf.fields?.public_id).toBe('docs/manual.pdf');
    const img = await signedUpload(SECRET, 'a/b.jpg', 'image/jpeg');
    expect(img.fields?.public_id).toBe('a/b');
  });
});
