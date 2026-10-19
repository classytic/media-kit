import { createHash } from 'node:crypto';
import type { Connection } from 'mongoose';
import { withTransaction } from '@classytic/mongokit';
import {
  assertAllocationInput,
  storageBudgetError,
  type StorageAllocation,
  type StorageBudget,
} from '../storage-budget.js';

interface Balance {
  _id: string;
  usedBytes: number;
  namespace: string;
  organizationId: string;
}
interface AllocationRow extends StorageAllocation {
  _id: string;
  namespace: string;
  retained: boolean;
  deleting: boolean;
}

/** Bind one ledger namespace per bucket; expiry never removes rows without deleting storage. */
export function createMongoStorageBudget(input: {
  connection: Connection;
  namespace: string;
  limitBytes(organizationId: string): Promise<number> | number;
}): StorageBudget & { init(): Promise<void> } {
  const balances = input.connection.collection<Balance>('media_storage_balances');
  const allocations = input.connection.collection<AllocationRow>('media_storage_allocations');
  const id = (value: string) =>
    createHash('sha256')
      .update(JSON.stringify([input.namespace, value]))
      .digest('hex');
  const limitFor = async (organizationId: string) => {
    const limit = await input.limitBytes(organizationId);
    if (!Number.isSafeInteger(limit) || limit < 0)
      throw storageBudgetError('media.quota.invalid_limit', 'Storage limit must be a non-negative integer.', 500);
    return limit;
  };
  return {
    async init() {
      await allocations.createIndex(
        { namespace: 1, retained: 1, expiresAt: 1, _id: 1 },
        { name: 'storage_allocation_scope_expiry' },
      );
    },
    async reserve(allocation) {
      assertAllocationInput(allocation);
      const limit = await limitFor(allocation.organizationId);
      const balanceId = id(allocation.organizationId);
      // Initialize outside the transaction so competing first uploads cannot race an upsert.
      try {
        await balances.updateOne(
          { _id: balanceId },
          { $setOnInsert: { usedBytes: 0, namespace: input.namespace, organizationId: allocation.organizationId } },
          { upsert: true, maxTimeMS: 5000 },
        );
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 11000)) throw error;
      }
      await withTransaction(input.connection, async (session) => {
        const existing = await allocations.findOne({ _id: id(allocation.key) }, { session, maxTimeMS: 5000 });
        if (existing) {
          if (existing.organizationId !== allocation.organizationId || existing.bytes !== allocation.bytes) {
            throw storageBudgetError('media.quota.allocation_conflict', 'Storage key has a different allocation.');
          }
          return;
        }
        const updated = await balances.updateOne(
          {
            _id: balanceId,
            $expr: { $lte: [{ $add: ['$usedBytes', allocation.bytes] }, limit] },
          },
          { $inc: { usedBytes: allocation.bytes } },
          { session, maxTimeMS: 5000 },
        );
        if (updated.modifiedCount !== 1)
          throw storageBudgetError(
            'media.quota.exceeded',
            'Your store storage allowance is full. Remove unused images or upgrade your plan.',
          );
        await allocations.insertOne(
          { ...allocation, _id: id(allocation.key), namespace: input.namespace, retained: false, deleting: false },
          { session },
        );
      });
    },
    async assertAllocation(key, organizationId, bytes) {
      const row = await allocations.findOne({ _id: id(key), organizationId }, { maxTimeMS: 5000 });
      if (!row || row.bytes !== bytes)
        throw storageBudgetError('media.quota.allocation_missing', 'Upload does not match a storage reservation.', 422);
    },
    async release(key) {
      await withTransaction(input.connection, async (session) => {
        const row = await allocations.findOneAndDelete({ _id: id(key) }, { session, maxTimeMS: 5000 });
        if (!row) return;
        const updated = await balances.updateOne(
          { _id: id(row.organizationId), usedBytes: { $gte: row.bytes } },
          { $inc: { usedBytes: -row.bytes } },
          { session, maxTimeMS: 5000 },
        );
        if (updated.modifiedCount !== 1)
          throw storageBudgetError('media.quota.balance_mismatch', 'Storage accounting requires repair.', 500);
      });
    },
    async retain(key) {
      await allocations.updateOne({ _id: id(key) }, { $set: { retained: true } }, { maxTimeMS: 5000 });
    },
    async commit(files, organizationId, create) {
      return withTransaction(input.connection, async (session) => {
        for (const file of files) {
          const updated = await allocations.updateOne(
            {
              _id: id(file.key),
              organizationId,
              bytes: file.bytes,
              retained: false,
              deleting: false,
            },
            { $set: { retained: true } },
            { session, maxTimeMS: 5000 },
          );
          if (updated.modifiedCount !== 1)
            throw storageBudgetError(
              'media.quota.allocation_missing',
              'Upload reservation is unavailable or being cleaned up.',
              422,
            );
        }
        return create(session);
      });
    },
    async claimExpired(key, before) {
      const updated = await allocations.updateOne(
        { _id: id(key), retained: false, expiresAt: { $lt: before } },
        { $set: { deleting: true } },
        { maxTimeMS: 5000 },
      );
      return updated.matchedCount === 1;
    },
    async usage(organizationId) {
      const row = await balances.findOne({ _id: id(organizationId) }, { maxTimeMS: 5000 });
      return { usedBytes: row?.usedBytes ?? 0, limitBytes: await limitFor(organizationId) };
    },
    async expired(before, limit) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 1000)
        throw new Error('Storage sweep limit must be between 1 and 1000.');
      return allocations
        .find({ namespace: input.namespace, retained: false, expiresAt: { $lt: before } }, { maxTimeMS: 5000 })
        .sort({ expiresAt: 1, _id: 1 })
        .limit(limit)
        .toArray();
    },
  };
}
