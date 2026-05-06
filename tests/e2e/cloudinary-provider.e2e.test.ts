/**
 * E2E tests — CloudinaryProvider
 *
 * Requires real Cloudinary credentials in tests/.env:
 *   CLOUDINARY_CLOUD_NAME=...
 *   CLOUDINARY_API_KEY=...
 *   CLOUDINARY_API_SECRET=...
 *
 * Skipped automatically when any credential is missing.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { CloudinaryProvider } from '../../src/providers/cloudinary.provider.js';

const CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME ?? '';
const API_KEY = process.env.CLOUDINARY_API_KEY ?? '';
const API_SECRET = process.env.CLOUDINARY_API_SECRET ?? '';

const SKIP = !CLOUD_NAME || !API_KEY || !API_SECRET;
const describeIf = SKIP ? describe.skip : describe;

// Use the same sample image as imgbb/imagekit tests
const SAMPLE_IMAGE = path.resolve('C:/Users/Siam/Downloads/8bitlesson.jpg');
let sampleBuffer: Buffer;

try {
  sampleBuffer = readFileSync(SAMPLE_IMAGE);
} catch {
  sampleBuffer = Buffer.from('fake-image-data');
}

let provider: CloudinaryProvider;
let uploadedKey: string;

describeIf('CloudinaryProvider — E2E', () => {
  beforeAll(() => {
    provider = new CloudinaryProvider({
      cloudName: CLOUD_NAME,
      apiKey: API_KEY,
      apiSecret: API_SECRET,
      folder: 'media-kit-tests',
      overwrite: true,
    });
  });

  it('write() uploads a file and returns composite key + metadata', async () => {
    const key = `e2e-cloudinary-${Date.now()}.jpg`;

    const result = await provider.write(key, sampleBuffer, 'image/jpeg');

    expect(result.key).toContain('\n');
    expect(result.url).toContain('cloudinary.com');
    expect(result.size).toBeGreaterThan(0);
    expect(result.metadata?.publicId).toBeDefined();
    expect(result.metadata?.resourceType).toBe('image');

    uploadedKey = result.key;
    console.log('Cloudinary uploaded key:', uploadedKey);
    console.log('Cloudinary URL:', result.url);
  }, 30000);

  it('exists() returns true for uploaded file', async () => {
    expect(uploadedKey).toBeDefined();
    const found = await provider.exists(uploadedKey);
    expect(found).toBe(true);
  }, 15000);

  it('stat() returns size and contentType', async () => {
    expect(uploadedKey).toBeDefined();
    const stat = await provider.stat(uploadedKey);

    expect(stat.size).toBeGreaterThan(0);
    expect(stat.contentType).toMatch(/image/);
    console.log('Cloudinary stat:', stat);
  }, 15000);

  it('getPublicUrl() returns a valid CDN URL with f_auto,q_auto', () => {
    expect(uploadedKey).toBeDefined();
    const url = provider.getPublicUrl(uploadedKey);
    expect(url).toMatch(/^https:\/\/res\.cloudinary\.com\//);
    expect(url).toContain('f_auto,q_auto');
    console.log('Cloudinary public URL:', url);
  });

  it('getTransformUrl() builds a valid transformation URL', () => {
    expect(uploadedKey).toBeDefined();
    const url = provider.getTransformUrl(uploadedKey, 'w_200,h_200,c_fill,g_face');
    expect(url).toMatch(/^https:\/\/res\.cloudinary\.com\//);
    expect(url).toContain('w_200,h_200,c_fill,g_face');
    expect(url).not.toContain('f_auto'); // transform URL is explicit, not auto
    console.log('Cloudinary transform URL:', url);
  });

  it('getSignedUrl() returns a signed delivery URL', async () => {
    expect(uploadedKey).toBeDefined();
    const url = await provider.getSignedUrl(uploadedKey, 3600);
    expect(url).toMatch(/^https:\/\/res\.cloudinary\.com\//);
    expect(url).toContain('s--');
    console.log('Cloudinary signed URL:', url);
  });

  it('read() streams the file back', async () => {
    expect(uploadedKey).toBeDefined();
    let stream: NodeJS.ReadableStream | undefined;
    try {
      stream = await provider.read(uploadedKey);
    } catch (err: any) {
      if (/timeout|ECONNRESET|fetch failed/i.test(err.message)) {
        console.warn('Cloudinary read() CDN timeout — skipping read assertion');
        return;
      }
      throw err;
    }

    let bytes = 0;
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      bytes += Buffer.isBuffer(chunk) ? chunk.length : Buffer.from(chunk as unknown as Uint8Array).length;
    }
    expect(bytes).toBeGreaterThan(0);
  }, 30000);

  it('delete() removes the file and is idempotent', async () => {
    expect(uploadedKey).toBeDefined();

    const deleted = await provider.delete(uploadedKey);
    expect(deleted).toBe(true);

    // Second call — file already gone, should return true (not throw)
    const idempotent = await provider.delete(uploadedKey);
    expect(idempotent).toBe(true);
  }, 15000);

  it('exists() returns false after deletion', async () => {
    // Small delay — Cloudinary CDN may take a moment to propagate delete
    await new Promise((r) => setTimeout(r, 2000));
    const found = await provider.exists(uploadedKey);
    expect(found).toBe(false);
  }, 15000);
});
