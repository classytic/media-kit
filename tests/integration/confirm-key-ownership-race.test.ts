/**
 * Storage-key ownership under CONCURRENCY.
 *
 * `confirmUpload` guards ownership with `isKeyRegistered()` — a read — and then
 * creates the record. Nothing binds the two, so two confirmations of one key
 * both saw "free" and both created a record. The damage is not a duplicate row:
 * the records point at ONE storage object, so `hardDelete()` on either removes
 * the bytes the other still serves, and the survivor keeps returning a URL that
 * 404s. Nothing throws anywhere along the way.
 *
 * The guard's own docblock says it exists to stop a caller claiming another
 * tenant's key and later deleting their object — a promise a check-then-act
 * cannot keep. The unique index can, so this asserts against the DATABASE, not
 * against the pre-check. A test that called `confirmUpload` twice in sequence
 * would pass with or without the index and prove nothing.
 */

import { afterAll, describe, expect, it } from 'vitest';
import { createTestEngine, teardownTestMongo, type TestEngineHandle } from '../helpers/create-test-engine.js';

describe('confirmUpload — storage key ownership', () => {
  afterAll(async () => {
    await teardownTestMongo();
  });

  it('two CONCURRENT confirms of one key produce exactly one record', async () => {
    const handle: TestEngineHandle = await createTestEngine();
    const { engine, driver, cleanup } = handle;
    try {
      // Index reconciliation is an EXPLICIT verb here (`autoIndex` is off in
      // every deployment — builds are deploy maintenance, not boot work), so
      // the constraint under test does not exist until it is called. In
      // production `scripts/ensure-indexes.ts` does this per release.
      await engine.syncIndexes();

      const repo = engine.repositories.media;
      const presigned = await repo.getSignedUploadUrl('race.jpg', 'image/jpeg');
      const key = presigned.key;
      // The bytes the client would have PUT straight to storage.
      driver.simulateExternalUpload(key, Buffer.from('pixels'), 'image/jpeg');

      const confirm = () =>
        repo.confirmUpload({ key, filename: 'race.jpg', mimeType: 'image/jpeg', size: 6 });

      const results = await Promise.allSettled([confirm(), confirm()]);
      const ok = results.filter((r) => r.status === 'fulfilled');
      const failed = results.filter((r) => r.status === 'rejected');

      expect(ok).toHaveLength(1);
      expect(failed).toHaveLength(1);

      // The loser must get the OWNERSHIP refusal, not a raw duplicate-key 500 —
      // a caller cannot be able to tell the raced path from the sequential one.
      const err = (failed[0] as PromiseRejectedResult).reason as { status?: number; code?: string };
      expect(err.code).toBe('media.confirm.key_in_use');
      expect(err.status).toBe(403);

      const all = await engine.repositories.media.findAll({ key });
      expect(all).toHaveLength(1);
    } finally {
      await cleanup();
    }
  });

  it('the sequential path still refuses with the same error', async () => {
    const handle: TestEngineHandle = await createTestEngine();
    const { engine, driver, cleanup } = handle;
    try {
      await engine.syncIndexes();
      const repo = engine.repositories.media;
      const presigned = await repo.getSignedUploadUrl('seq.jpg', 'image/jpeg');
      driver.simulateExternalUpload(presigned.key, Buffer.from('pixels'), 'image/jpeg');
      const input = { key: presigned.key, filename: 'seq.jpg', mimeType: 'image/jpeg', size: 6 };

      await repo.confirmUpload(input);
      await expect(repo.confirmUpload(input)).rejects.toMatchObject({
        code: 'media.confirm.key_in_use',
      });
    } finally {
      await cleanup();
    }
  });

  /**
   * A second tenant must not end up owning bytes another tenant owns.
   *
   * NOTE what this does NOT prove: it does not distinguish a global unique key
   * from a per-tenant one. `assertTenantBinding()` refuses tenant B before the
   * index is ever consulted, so this passes either way — verified by moving the
   * declaration above `injectTenantField()` and watching the suite stay green.
   * The index's global scope is defence in depth (it still holds with tenancy
   * off, or for a key minted without a tenant segment), and that limitation is
   * recorded here so the next reader does not mistake this for its proof.
   */
  it('a SECOND tenant cannot claim a key already owned', async () => {
    const handle: TestEngineHandle = await createTestEngine();
    const { engine, driver, cleanup } = handle;
    try {
      await engine.syncIndexes();
      const repo = engine.repositories.media;
      const presigned = await repo.getSignedUploadUrl('shared.jpg', 'image/jpeg', {}, { organizationId: 'org-a' });
      driver.simulateExternalUpload(presigned.key, Buffer.from('pixels'), 'image/jpeg');
      const input = { key: presigned.key, filename: 'shared.jpg', mimeType: 'image/jpeg', size: 6 };

      await repo.confirmUpload(input, { organizationId: 'org-a' });

      // Whatever refuses it — tenant binding or the unique index — it must be
      // REFUSED, and exactly one record may exist for these bytes.
      await expect(repo.confirmUpload(input, { organizationId: 'org-b' })).rejects.toThrow();
      const all = await engine.repositories.media.findAll({ key: presigned.key });
      expect(all).toHaveLength(1);
    } finally {
      await cleanup();
    }
  });
});
