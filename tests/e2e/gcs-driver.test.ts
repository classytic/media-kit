/**
 * E2E tests — GCSProvider against a real bucket.
 *
 * Gated by GCS credentials in tests/.env.
 * Skips when creds are not available.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'path';
import { GCSProvider } from '../../src/providers/gcs.provider.js';
import { hasGcs, gcsConfig, testKeyPrefix } from '../helpers/env.js';

const describeGcs = hasGcs() ? describe : describe.skip;

describeGcs('E2E — GCSProvider against real bucket', () => {
  let driver: GCSProvider;
  const prefix = testKeyPrefix('gcs-driver');

  beforeAll(() => {
    const cfg = gcsConfig();
    driver = new GCSProvider({
      bucket: cfg.bucket,
      projectId: cfg.projectId,
      keyFilename: path.resolve(process.cwd(), cfg.keyFilename),
    });
  });

  afterAll(async () => {
    // Cleanup keys under prefix
    if (driver?.list) {
      for await (const key of driver.list(prefix)) {
        try {
          await driver.delete(key);
        } catch {
          // ignore
        }
      }
    }
  });

  describe('write + read', () => {
    it('writes and reads back content', async () => {
      const key = `${prefix}/gcs-roundtrip.txt`;
      const content = Buffer.from('hello gcs e2e', 'utf-8');
      const writeResult = await driver.write(key, content, 'text/plain');
      expect(writeResult.key).toBe(key);
      expect(writeResult.size).toBe(content.length);

      const readStream = await driver.read(key);
      const chunks: Buffer[] = [];
      for await (const chunk of readStream as AsyncIterable<Buffer>) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      expect(Buffer.concat(chunks).toString('utf-8')).toBe('hello gcs e2e');
    });
  });

  describe('exists + delete', () => {
    it('exists() + delete() + exists()', async () => {
      const key = `${prefix}/gcs-deleteme.txt`;
      await driver.write(key, Buffer.from('bye'), 'text/plain');
      expect(await driver.exists(key)).toBe(true);

      await driver.delete(key);
      expect(await driver.exists(key)).toBe(false);
    });
  });

  describe('stat', () => {
    it('returns size and contentType', async () => {
      const key = `${prefix}/gcs-stat.txt`;
      const content = Buffer.from('stat test');
      await driver.write(key, content, 'text/plain');
      const stat = await driver.stat(key);
      expect(stat.size).toBe(content.length);
      expect(stat.contentType).toContain('text/plain');
    });
  });

  describe('getPublicUrl', () => {
    it('returns a valid URL for a key', () => {
      const key = `${prefix}/gcs-public.txt`;
      const url = driver.getPublicUrl(key);
      expect(url).toMatch(/^https?:\/\//);
    });
  });

  describe('signed upload URL', () => {
    it('generates a signed upload URL', async () => {
      if (!driver.getSignedUploadUrl) return;
      const result = await driver.getSignedUploadUrl(
        `${prefix}/gcs-presigned.txt`,
        'text/plain',
        3600,
      );
      expect(result.uploadUrl).toMatch(/^https?:\/\//);
      expect(result.key).toBe(`${prefix}/gcs-presigned.txt`);
    });
  });

  describe('resumable upload', () => {
    it('creates a resumable upload session', async () => {
      if (!driver.createResumableUpload) return;
      const session = await driver.createResumableUpload(
        `${prefix}/gcs-resumable.bin`,
        'application/octet-stream',
      );
      expect(session.uploadUrl).toMatch(/^https?:\/\//);
      expect(session.key).toBe(`${prefix}/gcs-resumable.bin`);
      expect(session.minChunkSize).toBeGreaterThan(0);

      // Abort
      if (driver.abortResumableUpload) {
        try {
          await driver.abortResumableUpload(session.uploadUrl);
        } catch {
          // GCS may have already cleaned up — ignore
        }
      }
    });
  });
});
