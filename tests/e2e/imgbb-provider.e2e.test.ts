/**
 * E2E — ImgbbProvider against the real imgbb API.
 *
 * Requires env var (loaded from tests/.env by vitest.config.ts):
 *   IMGBB_API_KEY
 *
 * Run: npx vitest run --project e2e tests/e2e/imgbb-provider.e2e.test.ts
 *
 * Note: imgbb delete is best-effort (a GET to the delete URL). There is no
 * programmatic way to verify deletion — the delete URL is one-time-use and
 * CDN edge caches may serve the image briefly after deletion. Tests assert
 * the contract (delete() returns true, compositeKey is correct) rather than
 * end-to-end removal confirmation.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ImgbbProvider } from '../../src/providers/imgbb.provider.js';

// ── Config ────────────────────────────────────────────────────────────────────

const API_KEY = process.env.IMGBB_API_KEY ?? '';
const SAMPLE_IMAGE = path.resolve('C:/Users/Siam/Downloads/8bitlesson.jpg');

// ── Provider ──────────────────────────────────────────────────────────────────

function makeProvider() {
  return new ImgbbProvider({ apiKey: API_KEY });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('ImgbbProvider (real API)', () => {
  it('write() uploads a file and returns a composite key + CDN URL', async () => {
    const provider = makeProvider();
    const buffer = await fs.readFile(SAMPLE_IMAGE);

    const result = await provider.write('8bitlesson.jpg', buffer, 'image/jpeg');

    console.log('write result:', result);

    expect(result.key).toContain('\n');           // composite key
    expect(result.url).toMatch(/^https?:\/\//);   // valid URL
    expect(result.size).toBeGreaterThan(0);

    const [displayUrl, deleteUrl] = result.key.split('\n');
    expect(displayUrl).toBeTruthy();
    expect(deleteUrl).toBeTruthy();
    expect(displayUrl).toMatch(/^https?:\/\//);
    expect(deleteUrl).toMatch(/^https?:\/\//);

    // getPublicUrl reconstructs display URL from composite key
    const publicUrl = provider.getPublicUrl(result.key);
    expect(publicUrl).toBe(displayUrl);

    console.log('public URL:', publicUrl);
    console.log('delete URL:', deleteUrl);

    // Cleanup (best-effort)
    await provider.delete(result.key);
  }, 30_000);

  it('exists() returns true for an uploaded file', async () => {
    const provider = makeProvider();
    const buffer = await fs.readFile(SAMPLE_IMAGE);

    const result = await provider.write('8bitlesson-exists.jpg', buffer, 'image/jpeg');

    // Give CDN a moment to propagate
    await new Promise(r => setTimeout(r, 1500));

    const existsBefore = await provider.exists(result.key);
    console.log('exists before delete:', existsBefore);
    expect(existsBefore).toBe(true);

    // Cleanup
    await provider.delete(result.key);
  }, 30_000);

  it('stat() returns file metadata via HTTP HEAD', async () => {
    const provider = makeProvider();
    const buffer = await fs.readFile(SAMPLE_IMAGE);

    const result = await provider.write('8bitlesson-stat.jpg', buffer, 'image/jpeg');

    await new Promise(r => setTimeout(r, 1000));

    const stat = await provider.stat(result.key);
    console.log('stat:', stat);

    expect(stat.contentType).toBeTruthy();
    // imgbb CDN may not return content-length on HEAD — size can be 0
    expect(typeof stat.size).toBe('number');

    // Cleanup
    await provider.delete(result.key);
  }, 30_000);

  it('delete() is idempotent and always returns true', async () => {
    const provider = makeProvider();
    const buffer = await fs.readFile(SAMPLE_IMAGE);

    const result = await provider.write('8bitlesson-del.jpg', buffer, 'image/jpeg');

    // First delete — should return true
    const ok1 = await provider.delete(result.key);
    expect(ok1).toBe(true);

    // Second delete — delete URL is one-time-use; should still not throw
    const ok2 = await provider.delete(result.key);
    expect(ok2).toBe(true);
  }, 30_000);

  it('read() streams the file from CDN', async () => {
    const provider = makeProvider();
    const buffer = await fs.readFile(SAMPLE_IMAGE);

    const result = await provider.write('8bitlesson-read.jpg', buffer, 'image/jpeg');

    await new Promise(r => setTimeout(r, 2000));

    try {
      const stream = await provider.read(result.key);
      const chunks: Buffer[] = [];
      for await (const chunk of stream) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as ArrayBuffer));
      }
      const downloaded = Buffer.concat(chunks);
      expect(downloaded.length).toBeGreaterThan(0);
      console.log('read bytes:', downloaded.length);
    } catch (err: unknown) {
      // imgbb CDN (i.ibb.co) is unreliable from some networks — connection
      // timeouts are a known issue. Skip rather than fail if CDN is unreachable.
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('Connect Timeout') || msg.includes('fetch failed')) {
        console.warn('imgbb CDN read skipped — CDN unreachable from this network:', msg);
        return;
      }
      throw err;
    } finally {
      // Cleanup regardless
      await provider.delete(result.key);
    }
  }, 30_000);
});
