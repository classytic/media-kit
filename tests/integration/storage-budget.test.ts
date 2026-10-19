import { randomUUID } from 'node:crypto';
import { Mongoose } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMongoStorageBudget } from '../../src/repositories/storage-budget.store.js';

const uri = process.env.MEDIA_QUOTA_TEST_MONGODB_URI;
describe.skipIf(!uri)('storage quota transaction safety', () => {
  const db = new Mongoose();
  const namespace = `quota-test:${randomUUID()}`;
  const budget = createMongoStorageBudget({ connection: db.connection, namespace, limitBytes: () => 20 });
  const allocation = (key: string, bytes: number, organizationId = 'store-a') => ({ key, bytes, organizationId, expiresAt: new Date(Date.now() - 1000) });
  beforeAll(async () => { await db.connect(uri!, { timeoutMS: 15000 }); await budget.init(); });
  afterAll(async () => {
    await db.connection.collection('media_storage_allocations').deleteMany({ namespace });
    await db.connection.collection('media_storage_balances').deleteMany({ namespace });
    await db.disconnect();
  });
  it('bounds concurrent reservations, isolates tenants and charges both primary and thumbnail bytes', async () => {
    const results = await Promise.allSettled(Array.from({ length: 10 }, (_, i) => budget.reserve(allocation(`concurrent-${i}`, 3))));
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(6);
    expect(await budget.usage('store-a')).toEqual({ usedBytes: 18, limitBytes: 20 });
    expect(results.filter((result) => result.status === 'rejected').every((result) => result.status === 'rejected' && result.reason.code === 'media.quota.exceeded')).toBe(true);
    await budget.reserve(allocation('store-b-main', 15, 'store-b'));
    await budget.reserve(allocation('store-b-thumb', 5, 'store-b'));
    await expect(budget.reserve(allocation('store-b-overflow', 1, 'store-b'))).rejects.toMatchObject({ code: 'media.quota.exceeded' });
    expect((await budget.usage('store-a')).usedBytes).toBe(18);
  });
  it('makes allocation replay and concurrent release idempotent', async () => {
    const input = allocation('replay', 7, 'store-c');
    await Promise.all([budget.reserve(input), budget.reserve(input)]);
    expect((await budget.usage('store-c')).usedBytes).toBe(7);
    await expect(budget.assertAllocation('replay', 'store-d', 7)).rejects.toMatchObject({ code: 'media.quota.allocation_missing' });
    await expect(budget.assertAllocation('replay', 'store-c', 8)).rejects.toMatchObject({ code: 'media.quota.allocation_missing' });
    await Promise.all([budget.release('replay'), budget.release('replay')]);
    expect((await budget.usage('store-c')).usedBytes).toBe(0);
  });
  it('keeps retained files out of abandoned-upload cleanup and isolates bucket namespaces', async () => {
    const input = allocation('retained', 1, 'store-e');
    await budget.reserve(input); await budget.retain(input.key);
    const expired = await budget.expired(new Date(), 100);
    expect(expired.some((row) => row.key === input.key)).toBe(false);
    const other = createMongoStorageBudget({ connection: db.connection, namespace: `${namespace}:other`, limitBytes: () => 20 });
    expect(await other.expired(new Date(), 100)).toEqual([]);
    await other.release('retained');
    expect((await budget.usage('store-e')).usedBytes).toBe(1);
  });
  it('rolls back confirmation with its media write and fences confirmation after cleanup claims a key', async () => {
    await budget.reserve(allocation('confirm', 2, 'store-f'));
    await expect(budget.commit([{ key: 'confirm', bytes: 2 }], 'store-f', async () => { throw new Error('media write failed'); })).rejects.toThrow('media write failed');
    expect((await budget.expired(new Date(), 100)).some((row) => row.key === 'confirm')).toBe(true);
    expect(await budget.claimExpired('confirm', new Date())).toBe(true);
    await expect(budget.commit([{ key: 'confirm', bytes: 2 }], 'store-f', async () => true)).rejects.toMatchObject({ code: 'media.quota.allocation_missing' });
    await budget.reserve(allocation('confirmed', 2, 'store-f'));
    await budget.commit([{ key: 'confirmed', bytes: 2 }], 'store-f', async (session) => {
      expect(session.inTransaction()).toBe(true);
      return true;
    });
    expect(await budget.claimExpired('confirmed', new Date())).toBe(false);
  });
});
