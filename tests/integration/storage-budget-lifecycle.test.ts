import { randomUUID } from 'node:crypto';
import { Mongoose } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { defineMedia } from '../../src/engine/define-media.js';
import type { MediaEngine } from '../../src/engine/engine-types.js';
import { createMongoStorageBudget } from '../../src/repositories/storage-budget.store.js';
import { MemoryStorageDriver } from '../helpers/memory-driver.js';

const uri = process.env.MEDIA_QUOTA_TEST_MONGODB_URI;
describe.skipIf(!uri)('quota-managed media lifecycle', () => {
  const db = new Mongoose();
  const namespace = `quota-lifecycle:${randomUUID()}`;
  const collection = `quota_test_${randomUUID().replaceAll('-', '')}`;
  const budget = createMongoStorageBudget({ connection: db.connection, namespace, limitBytes: () => 100 });
  class Driver extends MemoryStorageDriver { readonly exactUploadSize = true; }
  const driver = new Driver();
  const context = { organizationId: 'store-a' };
  let referenced = false;
  let engine: MediaEngine;
  beforeAll(async () => {
    await db.connect(uri!, { timeoutMS: 15000 }); await budget.init();
    engine = await defineMedia({
      tenant: { enabled: true, required: true, fieldType: 'string' },
      schemaOptions: { collection }, processing: { enabled: false },
      folders: { keyPrefix: 'brihot/store/test', defaultFolder: 'products' },
      fileTypes: { allowed: ['image/webp'], maxSize: 100, verifyContent: false },
    }).bind(db.connection, { driver, storageBudget: budget, bridges: { usage: { inUse: async () => referenced } } });
    await engine.syncIndexes();
  });
  afterAll(async () => {
    await engine?.close();
    await db.connection.collection(collection).drop();
    await db.connection.collection('media_storage_allocations').deleteMany({ namespace });
    await db.connection.collection('media_storage_balances').deleteMany({ namespace });
    await db.disconnect();
  });
  it('charges main and thumbnail, protects shared references, and releases bytes only after deletion', async () => {
    const repo = engine.repositories.media;
    const main = await repo.getSignedUploadUrl('main.webp', 'image/webp', { size: 10 }, context);
    expect(main.key).toMatch(/^brihot\/store\/test\/products\/__t-store-a\//);
    const [thumbnail] = await repo.signDerivativeUploads({ primaryKey: main.key, derivatives: [{ name: 'thumbnail', contentType: 'image/webp', size: 5 }] }, context);
    await driver.write(main.key, Buffer.alloc(10, 1), 'image/webp');
    await driver.write(thumbnail!.upload.key, Buffer.alloc(5, 2), 'image/webp');
    const media = await repo.confirmUpload({ key: main.key, filename: 'main.webp', mimeType: 'image/webp', size: 10, variants: [{ name: 'thumbnail', key: thumbnail!.upload.key, mimeType: 'image/webp', size: 5 }] }, context);
    expect(media.folder).toBe('products');
    expect((await budget.usage('store-a')).usedBytes).toBe(15);
    expect(await budget.expired(new Date(Date.now() + 86_400_000), 100)).toHaveLength(0);
    referenced = true;
    await expect(repo.hardDelete(String(media._id), context)).rejects.toMatchObject({ code: 'media.in_use' });
    expect(await driver.exists(main.key)).toBe(true);
    referenced = false;
    const failure = vi.spyOn(driver, 'delete').mockRejectedValueOnce(new Error('temporary provider failure'));
    await expect(repo.hardDelete(String(media._id), context)).rejects.toThrow('temporary provider failure');
    expect((await budget.usage('store-a')).usedBytes).toBe(10);
    expect((await repo.getById(String(media._id), context))?.status).toBe('deleting');
    failure.mockRestore();
    await repo.hardDelete(String(media._id), context);
    expect((await budget.usage('store-a')).usedBytes).toBe(0);
    expect(await driver.exists(main.key)).toBe(false);
    expect(await driver.exists(thumbnail!.upload.key)).toBe(false);
  });
  it('cleans abandoned bytes and retries storage failures without releasing the reservation early', async () => {
    await budget.reserve({ key: 'abandoned.webp', organizationId: 'store-a', bytes: 3, expiresAt: new Date(0) });
    await driver.write('abandoned.webp', Buffer.alloc(3), 'image/webp');
    const failure = vi.spyOn(driver, 'delete').mockRejectedValueOnce(new Error('provider unavailable'));
    expect((await engine.repositories.media.purgeAbandonedUploads()).failed).toBe(1);
    expect((await budget.usage('store-a')).usedBytes).toBe(3);
    failure.mockRestore();
    expect((await engine.repositories.media.purgeAbandonedUploads()).removed).toBe(1);
    expect((await budget.usage('store-a')).usedBytes).toBe(0);
  });
  it('rejects unmetered upload paths and a mismatched actual object size', async () => {
    const repo = engine.repositories.media;
    await expect(repo.upload({ buffer: Buffer.alloc(1), filename: 'x.webp', mimeType: 'image/webp' }, context)).rejects.toMatchObject({ code: 'media.quota.direct_upload_required' });
    await expect(repo.initiateMultipartUpload({ filename: 'x.webp', contentType: 'image/webp' }, context)).rejects.toMatchObject({ code: 'media.quota.direct_upload_required' });
    await expect(repo.signUploadParts('x', 'upload-id', [1])).rejects.toMatchObject({ code: 'media.quota.direct_upload_required' });
    await expect(repo.renameFolder('products', 'renamed', context)).rejects.toMatchObject({ code: 'media.quota.direct_upload_required' });
    const main = await repo.getSignedUploadUrl('mismatch.webp', 'image/webp', { size: 5 }, context);
    await driver.write(main.key, Buffer.alloc(6), 'image/webp');
    await expect(repo.confirmUpload({ key: main.key, filename: 'mismatch.webp', mimeType: 'image/webp', size: 5 }, context)).rejects.toBeDefined();
    expect((await budget.usage('store-a')).usedBytes).toBe(5);
  });
});
