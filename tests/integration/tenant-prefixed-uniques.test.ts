import { afterAll, describe, expect, it } from 'vitest';
import { createTestEngine, type TestEngineHandle } from '../helpers/create-test-engine.js';

/**
 * Shard-readiness guard. MongoDB can only shard a collection by a key if every unique index starts
 * with that key, so one unique index without the tenant prefix makes the collection unshardable by
 * tenant. Nothing here is global on purpose; a new entry needs a stated reason.
 */
const GLOBAL_UNIQUE_ALLOWLIST: Record<string, string> = {};

describe('every unique index on a tenant-scoped media engine leads with the tenant field', () => {
  let scoped: TestEngineHandle | undefined;
  let unscoped: TestEngineHandle | undefined;
  afterAll(async () => {
    await scoped?.cleanup();
    await unscoped?.cleanup();
  });

  it('has no unique index missing the tenant prefix outside the allowlist', async () => {
    scoped = await createTestEngine({
      tenant: { enabled: true, fieldType: 'string', tenantField: 'organizationId', required: true },
    });
    const offenders: string[] = [];
    let inspected = 0;
    for (const [fields, options] of scoped.engine.models.Media.schema.indexes()) {
      if (!options?.unique) continue;
      inspected++;
      const name = String(options.name ?? JSON.stringify(fields));
      if (Object.keys(fields)[0] === 'organizationId' || name in GLOBAL_UNIQUE_ALLOWLIST) continue;
      offenders.push(`${name} ${JSON.stringify(fields)}`);
    }
    expect(offenders).toEqual([]);
    expect(inspected).toBeGreaterThan(0); // the scan must actually have seen the key-ownership index
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
    const handle =
      scoped ??
      (scoped = await createTestEngine({
        tenant: { enabled: true, fieldType: 'string', tenantField: 'organizationId', required: true },
      }));
    const Media = handle.engine.models.Media;
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
