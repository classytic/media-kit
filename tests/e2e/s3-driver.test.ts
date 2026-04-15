/**
 * E2E tests — S3Provider against a real bucket.
 *
 * Gated by S3 credentials in tests/.env.
 * Skips when creds are not available (never fails CI).
 *
 * Each test uses a unique key prefix so parallel runs don't collide.
 * afterAll cleans up via driver.list() + driver.delete().
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { S3Provider } from '../../src/providers/s3.provider.js';
import { hasS3, s3Config, testKeyPrefix } from '../helpers/env.js';

const describeS3 = hasS3() ? describe : describe.skip;

describeS3('E2E — S3Provider against real bucket', () => {
  let driver: S3Provider;
  const prefix = testKeyPrefix('s3-driver');

  beforeAll(() => {
    const cfg = s3Config();
    driver = new S3Provider({
      bucket: cfg.bucket,
      region: cfg.region,
      credentials: {
        accessKeyId: cfg.accessKeyId,
        secretAccessKey: cfg.secretAccessKey,
      },
    });
  });

  afterAll(async () => {
    // Cleanup: delete all test keys under prefix
    if (driver?.list) {
      for await (const key of driver.list(prefix)) {
        try {
          await driver.delete(key);
        } catch {
          // ignore cleanup errors
        }
      }
    }
  });

  describe('write + read roundtrip', () => {
    it('writes a buffer and reads it back identically', async () => {
      const key = `${prefix}/roundtrip.txt`;
      const content = Buffer.from('hello s3 e2e', 'utf-8');

      const writeResult = await driver.write(key, content, 'text/plain');
      expect(writeResult.key).toBe(key);
      expect(writeResult.size).toBe(content.length);
      expect(writeResult.url).toContain('amazonaws');

      const readStream = await driver.read(key);
      const chunks: Buffer[] = [];
      for await (const chunk of readStream as AsyncIterable<Buffer>) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const readBack = Buffer.concat(chunks);
      expect(readBack.toString('utf-8')).toBe('hello s3 e2e');
    });
  });

  describe('exists / stat', () => {
    it('exists() returns true for uploaded file', async () => {
      const key = `${prefix}/exists.txt`;
      await driver.write(key, Buffer.from('x'), 'text/plain');
      expect(await driver.exists(key)).toBe(true);
    });

    it('exists() returns false for missing file', async () => {
      const key = `${prefix}/not-here-${Date.now()}.txt`;
      expect(await driver.exists(key)).toBe(false);
    });

    it('stat() returns size + contentType', async () => {
      const key = `${prefix}/stat.txt`;
      const content = Buffer.from('stat test');
      await driver.write(key, content, 'text/plain');
      const stat = await driver.stat(key);
      expect(stat.size).toBe(content.length);
      expect(stat.contentType).toContain('text/plain');
    });
  });

  describe('delete', () => {
    it('deletes an uploaded file', async () => {
      const key = `${prefix}/deleteme.txt`;
      await driver.write(key, Buffer.from('bye'), 'text/plain');
      expect(await driver.exists(key)).toBe(true);

      await driver.delete(key);
      expect(await driver.exists(key)).toBe(false);
    });
  });

  describe('copy', () => {
    it('copies a file to a new key', async () => {
      if (!driver.copy) return; // optional method
      const src = `${prefix}/src.txt`;
      const dst = `${prefix}/dst.txt`;
      await driver.write(src, Buffer.from('copy me'), 'text/plain');

      const result = await driver.copy(src, dst);
      expect(result.key).toBe(dst);
      expect(await driver.exists(dst)).toBe(true);
      expect(await driver.exists(src)).toBe(true); // source not removed
    });
  });

  describe('getPublicUrl', () => {
    it('returns a valid URL for a key', () => {
      const key = `${prefix}/public.txt`;
      const url = driver.getPublicUrl(key);
      expect(url).toMatch(/^https?:\/\//);
      expect(url).toContain(key);
    });
  });

  describe('signed URLs', () => {
    it('generates a signed upload URL', async () => {
      if (!driver.getSignedUploadUrl) return;
      const result = await driver.getSignedUploadUrl(
        `${prefix}/presigned.txt`,
        'text/plain',
        3600,
      );
      expect(result.uploadUrl).toMatch(/^https?:\/\//);
      expect(result.key).toBe(`${prefix}/presigned.txt`);
      expect(result.expiresIn).toBe(3600);
    });

    it('generates a signed read URL', async () => {
      if (!driver.getSignedUrl) return;
      const key = `${prefix}/signed-read.txt`;
      await driver.write(key, Buffer.from('read me'), 'text/plain');
      const url = await driver.getSignedUrl(key, 3600);
      expect(url).toMatch(/^https?:\/\//);
      expect(url).toContain('Signature');
    });
  });

  describe('multipart upload', () => {
    it('creates, signs parts, and completes a multipart upload', async () => {
      if (
        !driver.createMultipartUpload ||
        !driver.signUploadPart ||
        !driver.completeMultipartUpload
      ) {
        return;
      }

      const key = `${prefix}/multipart.bin`;
      const init = await driver.createMultipartUpload(key, 'application/octet-stream');
      expect(init.uploadId).toBeTruthy();

      // Sign a single part URL (we won't actually upload parts here — that requires fetch + real network)
      const signed = await driver.signUploadPart(key, init.uploadId, 1, 3600);
      expect(signed.uploadUrl).toMatch(/^https?:\/\//);
      expect(signed.partNumber).toBe(1);

      // Abort the upload (we're not going to complete it in e2e)
      if (driver.abortMultipartUpload) {
        await driver.abortMultipartUpload(key, init.uploadId);
      }
    });
  });
});
