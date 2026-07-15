/**
 * Delete & purge verbs — hardDelete, hardDeleteMany, purgeDeleted,
 * purgeStalePending, purgeExpired, getExpiringSoon.
 *
 * Extracted from MediaRepository; each function takes the repository as its
 * first parameter. The class methods in media.repository.ts are thin
 * delegates that preserve the public API surface.
 */

import type { IMediaDocument, BulkResult } from '../../types.js';
import type { MediaContext } from '../../engine/engine-types.js';
import { MEDIA_EVENTS } from '../../events/event-constants.js';
import { createMediaEvent } from '../../events/helpers.js';
import { isExternalMedia } from '../../utils/external.js';
import type { MediaRepository } from '../media.repository.js';

/**
 * Default staleness window for `purgeStalePending()`: 24 hours.
 *
 * `upload()` flips pending → processing → ready within a single request; a
 * genuinely in-flight upload never stays `'pending'` this long, so anything
 * older is a crashed/abandoned upload.
 */
export const STALE_PENDING_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Hard-delete: removes file from storage AND database.
 * Use repo.delete(id) for soft delete (when softDeletePlugin is wired).
 */
export async function hardDeleteVerb(repo: MediaRepository, id: string, ctx?: MediaContext): Promise<boolean> {
  let media: IMediaDocument | null;
  try {
    media = await repo.getById(id, { ...ctx, includeDeleted: true, throwOnNotFound: false });
  } catch {
    return false;
  }
  if (!media) return false;

  const variantKeys = (media.variants || []).map((v) => v.key);

  // External (reference-only) records own no bytes — the sentinel key is
  // not a storage location and `'external'` is not a registered driver, so
  // the delete is DB-only. This also keeps every purge sweep
  // (purgeDeleted / purgeExpired / purgeStalePending / deleteFolder →
  // hardDeleteMany) storage-safe for external records.
  if (!isExternalMedia(media)) {
    // Resolve the driver that stored this file (fall back to default for pre-multi-provider docs)
    const driver = repo.registry.resolve(media.provider ?? repo.registry.defaultName);

    // Delete from storage (best-effort)
    try {
      await driver.delete(media.key);
    } catch (err) {
      repo._log('warn', 'Failed to delete main file from storage', {
        id,
        key: media.key,
        error: (err as Error).message,
      });
    }
    for (const variant of media.variants || []) {
      try {
        await driver.delete(variant.key);
      } catch {
        /* ignore */
      }
    }

    // Evict the deleted keys from the CDN edge (best-effort).
    await repo._purgeCdn([media.key, ...variantKeys], ctx);
  }

  // Hard delete from DB (bypass softDeletePlugin) — idempotent on race:
  // parallel calls will both see the doc before either wins the delete,
  // so we treat a "not found" error as success (someone else deleted it).
  try {
    await repo.delete(id, { ...ctx, mode: 'hard' });
  } catch (err) {
    if (!/not found/i.test((err as Error).message)) throw err;
  }

  repo._log('info', 'Media hard-deleted', { id });

  await repo.events.publish(
    createMediaEvent(
      MEDIA_EVENTS.ASSET_DELETED,
      {
        assetId: id,
        key: media.key,
        variantKeys,
      },
      ctx,
      { resource: 'media', resourceId: id },
    ),
  );

  return true;
}

/**
 * Hard-delete multiple files with semaphore-bounded concurrency.
 */
export async function hardDeleteManyVerb(
  repo: MediaRepository,
  ids: string[],
  ctx?: MediaContext,
): Promise<BulkResult> {
  const result: BulkResult = { success: [], failed: [] };

  await Promise.allSettled(
    ids.map((id) =>
      repo.uploadSemaphore.run(async () => {
        try {
          const deleted = await repo.hardDelete(id, ctx);
          if (deleted) result.success.push(id);
          else result.failed.push({ id, reason: 'Not found' });
        } catch (err) {
          result.failed.push({ id, reason: (err as Error).message });
        }
      }),
    ),
  );

  await repo.events.publish(
    createMediaEvent(
      MEDIA_EVENTS.BATCH_DELETED,
      {
        deletedIds: result.success,
        failedIds: result.failed.map((f) => f.id),
      },
      ctx,
    ),
  );

  return result;
}

/**
 * Purge soft-deleted files older than a given date.
 * Hard-deletes from both storage and database.
 */
export async function purgeDeletedVerb(repo: MediaRepository, olderThan?: Date, ctx?: MediaContext): Promise<number> {
  const cutoff = olderThan || new Date(Date.now() - (repo.mediaConfig.softDelete?.ttlDays ?? 30) * 86400000);
  // Plugin-routed read with `includeDeleted: true` so softDeletePlugin
  // returns soft-deleted rows (the whole point of the purge); multiTenant
  // still scopes by configured field. We pass the deletedAt filter
  // explicitly because we want only docs older than the cutoff.
  const found = await repo.getAll({ filters: { deletedAt: { $ne: null, $lt: cutoff } } }, {
    lean: true,
    includeDeleted: true,
    ...repo._tenantOpts(ctx),
  } as Record<string, unknown>);
  const docs = (Array.isArray(found) ? found : (found as { data: unknown[] }).data) as Array<{ _id: unknown }>;

  let purged = 0;
  for (const doc of docs) {
    try {
      await repo.hardDelete(String(doc._id), ctx);
      purged++;
    } catch {
      repo._log('warn', 'Failed to purge soft-deleted file', { id: String(doc._id) });
    }
  }

  if (purged > 0) {
    await repo.events.publish(
      createMediaEvent(
        MEDIA_EVENTS.ASSET_PURGED,
        {
          count: purged,
          olderThan: cutoff,
        },
        ctx,
      ),
    );
  }

  return purged;
}

/**
 * Purge stale `status: 'pending'` rows left behind by crashed or abandoned
 * uploads.
 *
 * `upload()` creates the DB row as `'pending'` BEFORE writing to storage and
 * flips it to `'ready'` at the end — a process crash anywhere in between
 * strands the row (and possibly a storage object) forever. This sweep
 * hard-deletes (storage + DB) every pending row created before the cutoff.
 *
 * - **What counts as stale:** `status: 'pending'` AND `createdAt` older than
 *   `olderThan` (default: {@link STALE_PENDING_MAX_AGE_MS} = 24h ago — a
 *   genuinely in-flight upload never lives that long).
 * - **Cron-safe and idempotent:** already-purged rows simply don't match;
 *   a missing storage object (crash before the write) is tolerated — the
 *   DB row is still removed (`hardDelete()` treats storage deletion as
 *   best-effort and drivers treat missing keys as already-deleted).
 * - Emits `media:asset.purged` with `reason: 'stale_pending'` when anything
 *   was purged.
 *
 * Note: abandoned PRESIGNED uploads are the opposite shape — an unconfirmed
 * storage object with NO DB row (`confirmUpload()` creates the row). Those
 * are invisible to this sweep by design; use a bucket lifecycle rule on the
 * upload prefix instead.
 */
export async function purgeStalePendingVerb(
  repo: MediaRepository,
  olderThan?: Date,
  ctx?: MediaContext,
): Promise<number> {
  const cutoff = olderThan ?? new Date(Date.now() - STALE_PENDING_MAX_AGE_MS);
  // Plugin-routed read — multiTenant scopes by configured field. Pending
  // rows are never soft-deleted (delete flows flip status or remove the
  // row), so no `includeDeleted` needed here.
  const found = await repo.getAll({ filters: { status: 'pending', createdAt: { $lt: cutoff } } }, {
    lean: true,
    ...repo._tenantOpts(ctx),
  } as Record<string, unknown>);
  const docs = (Array.isArray(found) ? found : (found as { data: unknown[] }).data) as Array<{ _id: unknown }>;

  let purged = 0;
  for (const doc of docs) {
    try {
      await repo.hardDelete(String(doc._id), ctx);
      purged++;
    } catch {
      repo._log('warn', 'Failed to purge stale pending upload', { id: String(doc._id) });
    }
  }

  if (purged > 0) {
    await repo.events.publish(
      createMediaEvent(
        MEDIA_EVENTS.ASSET_PURGED,
        {
          count: purged,
          olderThan: cutoff,
          reason: 'stale_pending',
        },
        ctx,
      ),
    );
  }

  return purged;
}

/**
 * Purge all assets whose `expiresAt` is in the past (or before `before`).
 *
 * Queries in batches of 100 to avoid loading the entire collection. Re-queries
 * from the start each batch since hardDelete() shrinks the result set.
 * Fires `media:assets.expired` with purge summary after completion.
 *
 * Safe to call from a cron job — idempotent if some docs were already removed.
 * Does NOT touch soft-deleted files (status is not a filter here; purge is
 * unconditional once expiresAt passes).
 */
export async function purgeExpiredVerb(repo: MediaRepository, before?: Date, ctx?: MediaContext): Promise<BulkResult> {
  const cutoff = before ?? new Date();
  const result: BulkResult = { success: [], failed: [] };
  const BATCH = 100;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const found = await repo.getAll(
      { filters: { expiresAt: { $ne: null, $lte: cutoff } }, pagination: { limit: BATCH, page: 1 } },
      { lean: true, includeDeleted: true, ...repo._tenantOpts(ctx) } as Record<string, unknown>,
    );
    const docs = (Array.isArray(found) ? found : (found as { data: unknown[] }).data) as Array<{ _id: unknown }>;
    if (docs.length === 0) break;

    for (const doc of docs) {
      const id = String(doc._id);
      try {
        await repo.hardDelete(id, ctx);
        result.success.push(id);
      } catch (err) {
        result.failed.push({ id, reason: (err as Error).message });
        repo._log('warn', 'Failed to purge expired asset', { id, error: (err as Error).message });
      }
    }
  }

  await repo.events.publish(
    createMediaEvent(
      MEDIA_EVENTS.ASSETS_EXPIRED,
      {
        purgedIds: result.success,
        failedIds: result.failed.map((f) => f.id),
        before: cutoff,
        purgedCount: result.success.length,
        failedCount: result.failed.length,
      },
      ctx,
    ),
  );

  return result;
}

/**
 * Return assets that will expire within `withinHours` from now.
 * Useful for sending pre-expiry notifications before purgeExpired() runs.
 */
export async function getExpiringSoonVerb(
  repo: MediaRepository,
  withinHours: number,
  ctx?: MediaContext,
): Promise<IMediaDocument[]> {
  const now = new Date();
  const horizon = new Date(now.getTime() + withinHours * 3600000);
  const found = await repo.getAll({ filters: { expiresAt: { $gt: now, $lte: horizon } } }, {
    lean: true,
    ...repo._tenantOpts(ctx),
  } as Record<string, unknown>);
  return (Array.isArray(found) ? found : (found as { data: unknown[] }).data) as IMediaDocument[];
}
