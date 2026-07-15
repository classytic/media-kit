/**
 * Integration tests — presigned upload security hardening
 *
 * Covers:
 *   - confirmUpload key validation (generated-key shape, traversal rejection)
 *   - tenant-bound presign keys: cross-tenant confirmation rejected
 *     (403 tenant_mismatch), incl. the leaked UNCONFIRMED key scenario
 *   - client-supplied url validated (scheme + origin) and always derived server-side
 *   - upload policy (fileTypes.allowed / maxSize) enforced at presign time
 */

import { describe, it, expect, afterAll, beforeEach, afterEach } from 'vitest';
import { createTestEngine, teardownTestMongo, type TestEngineHandle } from '../helpers/create-test-engine.js';

const BUF = (s: string) => Buffer.from(s, 'utf-8');
const ORG_A = '507f1f77bcf86cd799439011';
const ORG_B = '507f1f77bcf86cd799439012';

interface HttpishError extends Error {
  status?: number;
  code?: string;
}

describe('presigned upload security', () => {
  afterAll(async () => {
    await teardownTestMongo();
  });

  describe('confirmUpload — key + url validation', () => {
    let handle: TestEngineHandle;

    beforeEach(async () => {
      handle = await createTestEngine();
    });

    afterEach(async () => {
      await handle.cleanup();
    });

    /** Presign + simulate the external PUT, returning the server-generated key. */
    async function presignAndUpload(filename = 'photo.png'): Promise<string> {
      const repo = handle.engine.repositories.media;
      const presigned = await repo.getSignedUploadUrl(filename, 'image/png');
      handle.driver.simulateExternalUpload(presigned.key, BUF('png-bytes'), 'image/png');
      return presigned.key;
    }

    it('happy path: confirms a presigned upload with a server-generated key', async () => {
      const repo = handle.engine.repositories.media;
      const key = await presignAndUpload();

      const media = await repo.confirmUpload({
        key,
        filename: 'photo.png',
        mimeType: 'image/png',
        size: 9,
      });

      expect(media.status).toBe('ready');
      expect(media.key).toBe(key);
      // URL is derived from the driver, never taken from the client
      expect(media.url).toBe(handle.driver.getPublicUrl(key));
    });

    it('rejects hand-crafted keys that do not match the generated-key shape', async () => {
      const repo = handle.engine.repositories.media;
      handle.driver.simulateExternalUpload('uploads/evil.png', BUF('x'), 'image/png');

      for (const key of ['uploads/evil.png', 'uploads/../secrets/passwd.png', '/etc/passwd.png']) {
        try {
          await repo.confirmUpload({ key, filename: 'evil.png', mimeType: 'image/png', size: 1 });
          expect.unreachable(`expected rejection for key: ${key}`);
        } catch (err) {
          const e = err as HttpishError;
          expect(e.status).toBe(400);
          expect(e.code).toBe('media.confirm.invalid_key');
        }
      }
    });

    it('rejects javascript:/data:/malformed urls', async () => {
      const repo = handle.engine.repositories.media;

      for (const url of ['javascript:alert(1)', 'data:text/html,<script>x</script>', 'not a url']) {
        const key = await presignAndUpload();
        try {
          await repo.confirmUpload({ key, filename: 'p.png', mimeType: 'image/png', size: 9, url });
          expect.unreachable(`expected rejection for url: ${url}`);
        } catch (err) {
          const e = err as HttpishError;
          expect(e.status).toBe(400);
          expect(e.code).toBe('media.confirm.invalid_url');
        }
      }
    });

    it('rejects urls whose origin does not match the storage origin', async () => {
      const repo = handle.engine.repositories.media;
      const key = await presignAndUpload();

      await expect(
        repo.confirmUpload({
          key,
          filename: 'p.png',
          mimeType: 'image/png',
          size: 9,
          url: `https://attacker.example.com/${key}`,
        }),
      ).rejects.toMatchObject({ status: 400, code: 'media.confirm.invalid_url' });
    });

    it('accepts a matching-origin url but stores the server-derived one', async () => {
      const repo = handle.engine.repositories.media;
      const key = await presignAndUpload();

      const media = await repo.confirmUpload({
        key,
        filename: 'p.png',
        mimeType: 'image/png',
        size: 9,
        url: `https://cdn.example.com/anything-else-entirely`,
      });

      expect(media.url).toBe(handle.driver.getPublicUrl(key));
    });

    it('rejects confirming a key twice (already registered)', async () => {
      const repo = handle.engine.repositories.media;
      const key = await presignAndUpload();

      await repo.confirmUpload({ key, filename: 'p.png', mimeType: 'image/png', size: 9 });

      await expect(
        repo.confirmUpload({ key, filename: 'p.png', mimeType: 'image/png', size: 9 }),
      ).rejects.toMatchObject({ status: 403, code: 'media.confirm.key_in_use' });
    });
  });

  describe('confirmUpload — tenant-bound keys', () => {
    let handle: TestEngineHandle;

    beforeEach(async () => {
      handle = await createTestEngine({
        tenant: { enabled: true, fieldType: 'string', tenantField: 'organizationId', required: true },
      });
    });

    afterEach(async () => {
      await handle.cleanup();
    });

    it('presign under a tenant mints a tenant-bound key and round-trips', async () => {
      const repo = handle.engine.repositories.media;

      const presigned = await repo.getSignedUploadUrl('b-file.png', 'image/png', {}, { organizationId: ORG_B });
      expect(presigned.key).toContain(`/__t-${ORG_B}/`);
      handle.driver.simulateExternalUpload(presigned.key, BUF('b-bytes'), 'image/png');

      const bMedia = await repo.confirmUpload(
        { key: presigned.key, filename: 'b-file.png', mimeType: 'image/png', size: 7 },
        { organizationId: ORG_B },
      );
      expect(bMedia.organizationId).toBe(ORG_B);
      // Tenant segment is a key-format detail — it must NOT leak into folder
      expect(bMedia.folder).not.toContain('__t-');
    });

    it("tenant A cannot confirm tenant B's UNCONFIRMED key (the leaked-key hole)", async () => {
      const repo = handle.engine.repositories.media;

      // B presigns + uploads but never confirms — the key leaks (logs, referrer)
      const presigned = await repo.getSignedUploadUrl('b-file.png', 'image/png', {}, { organizationId: ORG_B });
      handle.driver.simulateExternalUpload(presigned.key, BUF('b-bytes'), 'image/png');

      // A holds the key but it was minted for B — rejected BEFORE any DB lookup
      await expect(
        repo.confirmUpload(
          { key: presigned.key, filename: 'stolen.png', mimeType: 'image/png', size: 7 },
          { organizationId: ORG_A },
        ),
      ).rejects.toMatchObject({ status: 403, code: 'media.confirm.tenant_mismatch' });

      // B can still legitimately confirm its own key afterwards
      const bMedia = await repo.confirmUpload(
        { key: presigned.key, filename: 'b-file.png', mimeType: 'image/png', size: 7 },
        { organizationId: ORG_B },
      );
      expect(bMedia.organizationId).toBe(ORG_B);
    });

    it("tenant A cannot re-claim tenant B's REGISTERED key either", async () => {
      const repo = handle.engine.repositories.media;

      const presigned = await repo.getSignedUploadUrl('b-file.png', 'image/png', {}, { organizationId: ORG_B });
      handle.driver.simulateExternalUpload(presigned.key, BUF('b-bytes'), 'image/png');
      const bMedia = await repo.confirmUpload(
        { key: presigned.key, filename: 'b-file.png', mimeType: 'image/png', size: 7 },
        { organizationId: ORG_B },
      );

      // Tenant binding rejects A before the key-in-use guard is even consulted
      await expect(
        repo.confirmUpload(
          { key: presigned.key, filename: 'stolen.png', mimeType: 'image/png', size: 7 },
          { organizationId: ORG_A },
        ),
      ).rejects.toMatchObject({ status: 403, code: 'media.confirm.tenant_mismatch' });

      // B's record is untouched and its file still exists
      const still = await repo.getById(String(bMedia._id), { organizationId: ORG_B });
      expect(still).not.toBeNull();
      expect(handle.driver.getBuffer(presigned.key)).toBeDefined();
    });

    it('a segmentless key cannot be confirmed under a tenant scope (fail closed)', async () => {
      const repo = handle.engine.repositories.media;

      // Hand-crafted segmentless key with a perfectly valid generated shape —
      // e.g. minted by a tenantless deployment or forged from the format docs
      const key = `uploads/${Date.now()}-abcdef012345-file.png`;
      handle.driver.simulateExternalUpload(key, BUF('x'), 'image/png');

      await expect(
        repo.confirmUpload(
          { key, filename: 'file.png', mimeType: 'image/png', size: 1 },
          { organizationId: ORG_A },
        ),
      ).rejects.toMatchObject({ status: 403, code: 'media.confirm.tenant_mismatch' });
    });

    it('batch presign mints tenant-bound keys for every file', async () => {
      const repo = handle.engine.repositories.media;

      const batch = await repo.generateBatchPutUrls(
        {
          files: [
            { filename: 'a.png', contentType: 'image/png' },
            { filename: 'b.png', contentType: 'image/png' },
          ],
        },
        { organizationId: ORG_A },
      );
      for (const upload of batch.uploads) {
        expect(upload.key).toContain(`/__t-${ORG_A}/`);
      }
    });
  });

  describe('confirmUpload — tenant-bound keys under optional tenancy', () => {
    let handle: TestEngineHandle;

    beforeEach(async () => {
      handle = await createTestEngine({
        tenant: { enabled: true, fieldType: 'string', tenantField: 'organizationId', required: false },
      });
    });

    afterEach(async () => {
      await handle.cleanup();
    });

    it('an org-bound key cannot be confirmed by a tenantless caller', async () => {
      const repo = handle.engine.repositories.media;

      const presigned = await repo.getSignedUploadUrl('a.png', 'image/png', {}, { organizationId: ORG_A });
      handle.driver.simulateExternalUpload(presigned.key, BUF('x'), 'image/png');

      await expect(
        repo.confirmUpload({ key: presigned.key, filename: 'a.png', mimeType: 'image/png', size: 1 }),
      ).rejects.toMatchObject({ status: 403, code: 'media.confirm.tenant_mismatch' });
    });

    it('tenantless presign → tenantless confirm round-trips with a segmentless key', async () => {
      const repo = handle.engine.repositories.media;

      const presigned = await repo.getSignedUploadUrl('a.png', 'image/png');
      expect(presigned.key).not.toContain('__t-');
      handle.driver.simulateExternalUpload(presigned.key, BUF('x'), 'image/png');

      const media = await repo.confirmUpload({
        key: presigned.key,
        filename: 'a.png',
        mimeType: 'image/png',
        size: 1,
      });
      expect(media.status).toBe('ready');
    });
  });

  describe('abortMultipartUpload — tenant binding (ctx-aware, 3.7)', () => {
    let handle: TestEngineHandle;

    beforeEach(async () => {
      handle = await createTestEngine({
        tenant: { enabled: true, fieldType: 'string', tenantField: 'organizationId', required: true },
      });
    });

    afterEach(async () => {
      await handle.cleanup();
    });

    it("tenant A cannot abort tenant B's in-flight session (same matrix as confirm)", async () => {
      const repo = handle.engine.repositories.media;

      const session = await repo.initiateMultipartUpload(
        { filename: 'big.webm', contentType: 'video/webm' },
        { organizationId: ORG_B },
      );
      expect(session.key).toContain(`/__t-${ORG_B}/`);

      // A holds the leaked key+uploadId — rejected before any driver call
      await expect(
        repo.abortMultipartUpload(session.key, session.uploadId as string, { organizationId: ORG_A }),
      ).rejects.toMatchObject({ status: 403, code: 'media.confirm.tenant_mismatch' });

      // The session is still alive — B can complete or abort it
      await repo.abortMultipartUpload(session.key, session.uploadId as string, {
        organizationId: ORG_B,
      });
    });

    it('a hand-crafted key is rejected at the shape check when a ctx is provided', async () => {
      const repo = handle.engine.repositories.media;

      await expect(
        repo.abortMultipartUpload('../../etc/passwd', 'upload-1', { organizationId: ORG_A }),
      ).rejects.toMatchObject({ status: 400 });
    });

    it('ctx-less abort keeps the trusted server-side behavior (no guard)', async () => {
      const repo = handle.engine.repositories.media;

      const session = await repo.initiateMultipartUpload(
        { filename: 'big.webm', contentType: 'video/webm' },
        { organizationId: ORG_B },
      );

      // No ctx → pre-3.7 semantics: no tenant matrix, abort goes through
      await expect(
        repo.abortMultipartUpload(session.key, session.uploadId as string),
      ).resolves.toBeUndefined();
    });
  });

  describe('presign-time upload policy', () => {
    let handle: TestEngineHandle;

    beforeEach(async () => {
      handle = await createTestEngine({
        fileTypes: { allowed: ['image/*'], maxSize: 1024 },
      });
    });

    afterEach(async () => {
      await handle.cleanup();
    });

    it('rejects a disallowed content type at presign time', async () => {
      await expect(
        handle.engine.repositories.media.getSignedUploadUrl('doc.pdf', 'application/pdf'),
      ).rejects.toThrow(/not allowed/);
    });

    it('rejects an oversize declared size at presign time', async () => {
      await expect(
        handle.engine.repositories.media.getSignedUploadUrl('big.png', 'image/png', { size: 4096 }),
      ).rejects.toThrow(/exceeds limit/);
    });

    it('allows a permitted content type + size', async () => {
      const result = await handle.engine.repositories.media.getSignedUploadUrl('ok.png', 'image/png', {
        size: 512,
      });
      expect(result.uploadUrl).toContain(result.key);
    });

    it('enforces the policy per-file in generateBatchPutUrls', async () => {
      const repo = handle.engine.repositories.media;

      await expect(
        repo.generateBatchPutUrls({
          files: [
            { filename: 'a.png', contentType: 'image/png' },
            { filename: 'b.pdf', contentType: 'application/pdf' },
          ],
        }),
      ).rejects.toThrow(/not allowed/);

      await expect(
        repo.generateBatchPutUrls({
          files: [{ filename: 'a.png', contentType: 'image/png', size: 999999 }],
        }),
      ).rejects.toThrow(/exceeds limit/);

      const ok = await repo.generateBatchPutUrls({
        files: [
          { filename: 'a.png', contentType: 'image/png', size: 100 },
          { filename: 'b.webp', contentType: 'image/webp' },
        ],
      });
      expect(ok.uploads).toHaveLength(2);
    });
  });
});
