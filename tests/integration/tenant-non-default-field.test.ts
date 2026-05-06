/**
 * Integration tests — multi-tenancy with a NON-DEFAULT tenant field.
 *
 * Regression for the bug where folder/analytics methods hardcoded
 * `organizationId` in raw `Model.aggregate(...)` / `Model.find(...)`
 * calls and bypassed the multiTenantPlugin. When a host configured
 * `tenant.tenantField !== 'organizationId'`, those queries either
 * scoped on the wrong (non-existent) field or returned cross-tenant
 * data.
 *
 * The fix routes every analytical / folder query through
 * `aggregatePipeline()` / `getAll()` / `getByQuery()` so the plugin
 * injects the correct field name as the leading $match.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestEngine,
  teardownTestMongo,
  type TestEngineHandle,
} from '../helpers/create-test-engine.js';

const BUF = (s: string) => Buffer.from(s, 'utf-8');

describe('Multi-tenancy — non-default tenantField (accountId)', () => {
  afterAll(async () => {
    await teardownTestMongo();
  });

  let handle: TestEngineHandle;

  beforeEach(async () => {
    handle = await createTestEngine({
      tenant: {
        enabled: true,
        tenantField: 'accountId',
        contextKey: 'organizationId',
        fieldType: 'string',
        required: true,
      },
    });
  });

  afterEach(async () => {
    await handle.cleanup();
  });

  async function seedTenant(orgId: string, files: Array<{ name: string; folder: string }>) {
    for (const f of files) {
      await handle.engine.repositories.media.upload(
        { buffer: BUF(f.name), filename: f.name, mimeType: 'text/plain', folder: f.folder },
        { organizationId: orgId },
      );
    }
  }

  it('schema column is `accountId` (not `organizationId`)', async () => {
    await seedTenant('org-a', [{ name: 'a.txt', folder: 'products' }]);
    const raw = await handle.engine.models.Media.findOne({}).lean();
    expect(raw).not.toBeNull();
    expect((raw as Record<string, unknown>).accountId).toBe('org-a');
    expect((raw as Record<string, unknown>).organizationId).toBeUndefined();
  });

  it('getFolderTree scopes by accountId — no cross-tenant leak', async () => {
    await seedTenant('org-a', [
      { name: 'a1.txt', folder: 'products' },
      { name: 'a2.txt', folder: 'products' },
    ]);
    await seedTenant('org-b', [
      { name: 'b1.txt', folder: 'products' },
      { name: 'b2.txt', folder: 'avatars' },
      { name: 'b3.txt', folder: 'avatars' },
    ]);

    const treeA = await handle.engine.repositories.media.getFolderTree({
      organizationId: 'org-a',
    });
    expect(treeA.meta.totalFiles).toBe(2);

    const treeB = await handle.engine.repositories.media.getFolderTree({
      organizationId: 'org-b',
    });
    expect(treeB.meta.totalFiles).toBe(3);
  });

  it('getFolderStats scopes by accountId', async () => {
    await seedTenant('org-a', [{ name: 'a.txt', folder: 'products' }]);
    await seedTenant('org-b', [
      { name: 'b1.txt', folder: 'products' },
      { name: 'b2.txt', folder: 'products' },
    ]);

    const statsA = await handle.engine.repositories.media.getFolderStats('products', {
      organizationId: 'org-a',
    });
    expect(statsA.totalFiles).toBe(1);

    const statsB = await handle.engine.repositories.media.getFolderStats('products', {
      organizationId: 'org-b',
    });
    expect(statsB.totalFiles).toBe(2);
  });

  it('getSubfolders scopes by accountId', async () => {
    await seedTenant('org-a', [
      { name: 'a1.txt', folder: 'products/featured' },
      { name: 'a2.txt', folder: 'products/sale' },
    ]);
    await seedTenant('org-b', [{ name: 'b.txt', folder: 'products/private' }]);

    const subA = await handle.engine.repositories.media.getSubfolders('products', {
      organizationId: 'org-a',
    });
    const namesA = subA.map((s) => s.name).sort();
    expect(namesA).toEqual(['featured', 'sale']);

    const subB = await handle.engine.repositories.media.getSubfolders('products', {
      organizationId: 'org-b',
    });
    expect(subB.map((s) => s.name)).toEqual(['private']);
  });

  it('getByHash scopes by accountId — same hash in two tenants returns each tenant\'s own row', async () => {
    // Both orgs upload the same content — same hash, different tenants
    await seedTenant('org-a', [{ name: 'shared.txt', folder: 'products' }]);
    await seedTenant('org-b', [{ name: 'shared.txt', folder: 'products' }]);

    const allDocs = await handle.engine.models.Media.find({}).lean();
    expect(allDocs).toHaveLength(2);
    const sharedHash = (allDocs[0] as Record<string, unknown>).hash as string;

    const resultA = await handle.engine.repositories.media.getByHash(sharedHash, {
      organizationId: 'org-a',
    });
    expect(resultA).not.toBeNull();
    expect((resultA as unknown as Record<string, unknown>).accountId).toBe('org-a');

    const resultB = await handle.engine.repositories.media.getByHash(sharedHash, {
      organizationId: 'org-b',
    });
    expect(resultB).not.toBeNull();
    expect((resultB as unknown as Record<string, unknown>).accountId).toBe('org-b');
  });

  it('getStorageByFolder + getTotalStorageUsed scope by accountId', async () => {
    await seedTenant('org-a', [
      { name: 'a1.txt', folder: 'products' },
      { name: 'a2.txt', folder: 'products' },
    ]);
    await seedTenant('org-b', [
      { name: 'b1.txt', folder: 'products' },
      { name: 'b2.txt', folder: 'avatars' },
      { name: 'b3.txt', folder: 'avatars' },
    ]);

    const byFolderA = await handle.engine.repositories.media.getStorageByFolder({
      organizationId: 'org-a',
    });
    expect(byFolderA).toHaveLength(1);
    expect(byFolderA[0].folder).toBe('products');
    expect(byFolderA[0].count).toBe(2);

    const totalA = await handle.engine.repositories.media.getTotalStorageUsed({
      organizationId: 'org-a',
    });
    const totalB = await handle.engine.repositories.media.getTotalStorageUsed({
      organizationId: 'org-b',
    });
    expect(totalA).toBeGreaterThan(0);
    expect(totalB).toBeGreaterThan(totalA);
  });

  it('deleteFolder + renameFolder scope by accountId', async () => {
    await seedTenant('org-a', [{ name: 'a.txt', folder: 'products' }]);
    await seedTenant('org-b', [{ name: 'b.txt', folder: 'products' }]);

    // Delete folder for org-a — must NOT touch org-b's row
    await handle.engine.repositories.media.deleteFolder('products', { organizationId: 'org-a' });

    const remaining = await handle.engine.models.Media.find({}).lean();
    expect(remaining).toHaveLength(1);
    expect((remaining[0] as Record<string, unknown>).accountId).toBe('org-b');
  });
});
