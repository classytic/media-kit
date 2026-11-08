import { afterAll, describe, expect, it } from 'vitest';
import { createTestEngine, type TestEngineHandle } from '../helpers/create-test-engine.js';

/**
 * Key ownership by scope. The rule that every unique index leads with the tenant field is the shared
 * `unique-indexes-tenant-prefixed` check in `tests/unit/kernel-conformance.test.ts`; this file pins the
 * two behaviours around the one index media-kit declares itself.
 */
describe('the key-ownership claim follows the tenancy setting', () => {
  let scoped: TestEngineHandle | undefined;
  let unscoped: TestEngineHandle | undefined;
  afterAll(async () => {
    await scoped?.cleanup();
    await unscoped?.cleanup();
  });

  it('keeps the key-ownership claim global when tenancy is off (no tenant to lead it)', async () => {
    unscoped = await createTestEngine({ tenant: false });
    const names = unscoped.engine.models.Media.schema
      .indexes()
      .filter(([, o]) => o?.unique)
      .map(([f, o]) => `${o?.name}:${Object.keys(f).join(',')}`);
    expect(names).toContain('media_key_unique:key');
  });

  it('the per-tenant claim still refuses a second record for one key inside a tenant', async () => {
    scoped ??= await createTestEngine({
      tenant: { enabled: true, fieldType: 'string', tenantField: 'organizationId', required: true },
    });
    const Media = scoped.engine.models.Media;
    // The suite shares one collection: the unscoped engine above leaves its tenant-less indexes
    // (same names, other keys), which `syncIndexes()` cannot replace in place. Let both engines'
    // background index builds settle first, or they race the drop.
    await Promise.allSettled([Media.init(), unscoped?.engine.models.Media.init()]);
    await Media.collection.dropIndexes().catch(() => {});
    await Media.syncIndexes();
    const base = {
      filename: 'a.jpg',
      originalFilename: 'a.jpg',
      mimeType: 'image/jpeg',
      size: 1,
      url: 'u',
      hash: 'h',
      status: 'ready',
      folder: 'f',
      key: 'f/__t-org_a/1-x-a.jpg',
    };
    await Media.collection.insertOne({ ...base, organizationId: 'org_a' } as never);
    await expect(Media.collection.insertOne({ ...base, organizationId: 'org_a' } as never)).rejects.toThrow(
      /duplicate key/i,
    );
  });
});
