import type { MediaRepository } from '../repositories/media.repository.js';
import type { MediaContext } from '../engine/engine-types.js';

/** Mark detached catalog URLs in the caller's transaction; never remove storage before commit. */
export async function scheduleDetachedMedia(
  repository: MediaRepository,
  urls: readonly string[],
  context?: MediaContext,
): Promise<void> {
  if (!repository.bridges.usage) throw new Error('Detached-image cleanup requires reference protection.');
  if (urls.length === 0) return;
  await repository.updateMany(
    { $or: [{ url: { $in: [...urls] } }, { 'variants.url': { $in: [...urls] } }] },
    {
      $set: { 'metadata.cleanupAfter': new Date(Date.now() + 86_400_000) },
    },
    repository._tenantOpts(context),
  );
}

/** Recheck current references after the grace period and retain retryable deletion tombstones. */
export async function purgeDetachedMedia(repository: MediaRepository, before: Date, context?: MediaContext) {
  const rows = await repository.findAll(
    { 'metadata.cleanupAfter': { $lte: before }, status: { $in: ['ready', 'deleting'] } },
    {
      ...repository._tenantOpts(context),
      sort: { _id: 1 },
      limit: 100,
    },
  );
  const result = { removed: 0, retained: 0, failed: 0 };
  for (const media of rows) {
    try {
      if (await repository.hardDelete(String(media._id), context)) result.removed += 1;
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'media.in_use') {
        await repository.updateMany(
          { _id: media._id, 'metadata.cleanupAfter': media.metadata?.cleanupAfter },
          { $unset: { 'metadata.cleanupAfter': '' } },
          repository._tenantOpts(context),
        );
        result.retained += 1;
      } else {
        repository._log('error', 'Detached image cleanup failed; tombstone retained for retry', {
          id: String(media._id),
          error,
        });
        result.failed += 1;
      }
    }
  }
  return result;
}
