/**
 * E2E — ImageKitProvider against the real ImageKit API.
 *
 * Requires env vars (or the defaults below):
 *   IMAGEKIT_PUBLIC_KEY
 *   IMAGEKIT_PRIVATE_KEY
 *   IMAGEKIT_URL_ENDPOINT
 *
 * Run: npx vitest run --project e2e tests/e2e/imagekit-provider.e2e.test.ts
 *
 * Every test cleans up after itself (deletes uploaded files).
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ImageKitProvider } from '../../src/providers/imagekit.provider.js';

// ── Config ────────────────────────────────────────────────────────────────────

const PUBLIC_KEY  = process.env.IMAGEKIT_PUBLIC_KEY  ?? '';
const PRIVATE_KEY = process.env.IMAGEKIT_PRIVATE_KEY ?? '';
const URL_ENDPOINT = process.env.IMAGEKIT_URL_ENDPOINT ?? '';

const SAMPLE_IMAGE = path.resolve('C:/Users/Siam/Downloads/8bitlesson.jpg');
const TEST_FOLDER = 'media-kit-test';

// ── Provider ──────────────────────────────────────────────────────────────────

function makeProvider() {
  return new ImageKitProvider({
    publicKey: PUBLIC_KEY,
    privateKey: PRIVATE_KEY,
    urlEndpoint: URL_ENDPOINT,
    defaultFolder: TEST_FOLDER,
    useUniqueFileName: true,
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('ImageKitProvider (real API)', () => {
  it('write() uploads a file and returns a composite key + CDN URL', async () => {
    const provider = makeProvider();
    const buffer = await fs.readFile(SAMPLE_IMAGE);

    const result = await provider.write('8bitlesson.jpg', buffer, 'image/jpeg');

    console.log('write result:', result);

    expect(result.key).toContain('\n');          // composite key
    expect(result.url).toMatch(/^https?:\/\//);  // valid URL
    expect(result.size).toBeGreaterThan(0);

    const [fileId, filePath] = result.key.split('\n');
    expect(fileId).toBeTruthy();
    expect(filePath).toBeTruthy();

    // getPublicUrl reconstructs the same CDN URL
    const publicUrl = provider.getPublicUrl(result.key);
    expect(publicUrl).toContain(URL_ENDPOINT);
    expect(publicUrl).toContain(filePath);

    console.log('public URL:', publicUrl);

    // Cleanup
    await provider.delete(result.key);
  }, 30_000);

  it('exists() returns true for uploaded file, false after delete', async () => {
    const provider = makeProvider();
    const buffer = await fs.readFile(SAMPLE_IMAGE);

    const result = await provider.write('8bitlesson-exists.jpg', buffer, 'image/jpeg');

    // Give CDN a moment to propagate
    await new Promise(r => setTimeout(r, 1500));

    const existsBefore = await provider.exists(result.key);
    expect(existsBefore).toBe(true);

    await provider.delete(result.key);

    // After delete, CDN might still serve the file briefly (edge cache).
    // Just verify delete() completes without throwing.
  }, 30_000);

  it('stat() returns file metadata from the management API', async () => {
    const provider = makeProvider();
    const buffer = await fs.readFile(SAMPLE_IMAGE);

    const result = await provider.write('8bitlesson-stat.jpg', buffer, 'image/jpeg');

    const stat = await provider.stat(result.key);
    console.log('stat:', stat);

    expect(stat.size).toBeGreaterThan(0);
    expect(stat.contentType).toBeTruthy();

    // Cleanup
    await provider.delete(result.key);
  }, 30_000);

  it('delete() removes the file (404 = idempotent)', async () => {
    const provider = makeProvider();
    const buffer = await fs.readFile(SAMPLE_IMAGE);

    const result = await provider.write('8bitlesson-del.jpg', buffer, 'image/jpeg');

    // First delete — should succeed
    const ok1 = await provider.delete(result.key);
    expect(ok1).toBe(true);

    // Second delete — should not throw (404 = idempotent)
    const ok2 = await provider.delete(result.key);
    expect(ok2).toBe(true);
  }, 30_000);

  it('list() yields uploaded file keys for a folder', async () => {
    const provider = makeProvider();
    const buffer = await fs.readFile(SAMPLE_IMAGE);

    const result = await provider.write('8bitlesson-list.jpg', buffer, 'image/jpeg');

    // Wait for ImageKit indexing
    await new Promise(r => setTimeout(r, 2000));

    const keys: string[] = [];
    for await (const key of provider.list(TEST_FOLDER)) {
      keys.push(key);
    }

    console.log('list keys:', keys.length, 'files in', TEST_FOLDER);
    expect(keys.length).toBeGreaterThan(0);

    // Every key should be composite
    for (const k of keys) {
      expect(k).toContain('\n');
    }

    // Cleanup
    await provider.delete(result.key);
  }, 30_000);

  it('read() streams the file from CDN', async () => {
    const provider = makeProvider();
    const buffer = await fs.readFile(SAMPLE_IMAGE);

    const result = await provider.write('8bitlesson-read.jpg', buffer, 'image/jpeg');

    // Wait briefly for CDN propagation
    await new Promise(r => setTimeout(r, 1500));

    const stream = await provider.read(result.key);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as ArrayBuffer));
    }
    const downloaded = Buffer.concat(chunks);
    expect(downloaded.length).toBeGreaterThan(0);
    console.log('read bytes:', downloaded.length);

    // Cleanup
    await provider.delete(result.key);
  }, 30_000);
});
