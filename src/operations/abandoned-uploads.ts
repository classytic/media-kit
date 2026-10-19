import type { MediaRepository } from '../repositories/media.repository.js';

/** Claim expired reservations before removing bytes; confirmation and cleanup compete atomically. */
export async function purgeAbandonedUploads(repository: MediaRepository, limit = 100) {
  const budget = repository.storageBudget;
  const result = { removed: 0, retained: 0, failed: 0 };
  if (!budget) return result;
  const before = new Date();
  for (const allocation of await budget.expired(before, limit)) {
    try {
      if (await repository.isStorageKeyReferenced(allocation.key)) {
        await budget.retain(allocation.key);
        result.retained += 1;
        continue;
      }
      if (!(await budget.claimExpired(allocation.key, before))) continue;
      await repository.registry.defaultDriver.delete(allocation.key);
      await budget.release(allocation.key);
      result.removed += 1;
    } catch (error) {
      result.failed += 1;
      repository._log('error', 'Abandoned upload cleanup failed; reservation retained for retry', {
        key: allocation.key,
        error,
      });
    }
  }
  return result;
}
