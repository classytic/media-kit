/**
 * Soft-delete operations — softDelete, restore, purgeDeleted.
 */

import type { OperationDeps } from './types';
import type {
  OperationContext,
  IMediaDocument,
  EventContext,
  EventError,
} from '../types';
import { log } from './helpers';

/**
 * Soft-delete a file by setting deletedAt. Does not touch storage.
 */
export async function softDelete(
  deps: OperationDeps,
  id: string,
  context?: OperationContext,
): Promise<IMediaDocument> {
  const eventCtx: EventContext<{ id: string }> = {
    data: { id },
    context,
    timestamp: new Date(),
  };
  await deps.events.emit('before:softDelete', eventCtx);

  try {
    const existing = await deps.repository.getMediaById(id, context);
    if (!existing) {
      throw new Error(`Media not found: ${id}`);
    }

    const media = await deps.repository.updateMedia(
      id,
      { deletedAt: new Date() },
      context,
    );

    log(deps, 'info', 'Media soft-deleted', { id });

    await deps.events.emit('after:softDelete', {
      context: eventCtx,
      result: media,
      timestamp: new Date(),
    });

    return media;
  } catch (error) {
    const errorEvent: EventError<{ id: string }> = {
      context: eventCtx,
      error: error as Error,
      timestamp: new Date(),
    };
    await deps.events.emit('error:softDelete', errorEvent);
    throw error;
  }
}

/**
 * Restore a soft-deleted file by clearing deletedAt.
 */
export async function restore(
  deps: OperationDeps,
  id: string,
  context?: OperationContext,
): Promise<IMediaDocument> {
  const eventCtx: EventContext<{ id: string }> = {
    data: { id },
    context,
    timestamp: new Date(),
  };
  await deps.events.emit('before:restore', eventCtx);

  try {
    // Must include trashed to find the soft-deleted file
    const trashedContext = { ...context, includeTrashed: true };
    const existing = await deps.repository.getMediaById(id, trashedContext);
    if (!existing) {
      throw new Error(`Media not found: ${id}`);
    }

    const media = await deps.repository.updateMedia(
      id,
      { deletedAt: null },
      trashedContext,
    );

    log(deps, 'info', 'Media restored', { id });

    await deps.events.emit('after:restore', {
      context: eventCtx,
      result: media,
      timestamp: new Date(),
    });

    return media;
  } catch (error) {
    const errorEvent: EventError<{ id: string }> = {
      context: eventCtx,
      error: error as Error,
      timestamp: new Date(),
    };
    await deps.events.emit('error:restore', errorEvent);
    throw error;
  }
}

/**
 * Permanently delete all soft-deleted files older than the given date.
 * Default: config.softDelete.ttlDays (30 days).
 * Returns the count of purged records.
 */
export async function purgeDeleted(
  deps: OperationDeps,
  olderThan?: Date,
  context?: OperationContext,
): Promise<number> {
  const ttlDays = deps.config.softDelete?.ttlDays ?? 30;
  const cutoff = olderThan || new Date(Date.now() - ttlDays * 24 * 60 * 60 * 1000);

  let purgedCount = 0;
  const BATCH_SIZE = 1000;

  // Must include trashed to find soft-deleted docs (otherwise the soft-delete
  // filter hook overwrites our deletedAt filter with { deletedAt: null })
  const trashedContext: OperationContext = { ...context, includeTrashed: true };

  while (true) {
    const trashedResult = await deps.repository.getAllMedia(
      {
        filters: {
          deletedAt: { $ne: null, $lt: cutoff },
        },
        limit: BATCH_SIZE,
      },
      trashedContext,
    );

    const docs = trashedResult.docs;
    if (docs.length === 0) {
      break;
    }

    let batchDeleted = 0;

    for (const doc of docs) {
      try {
        // Delete from storage
        try {
          await deps.driver.delete(doc.key);
        } catch (err) {
          log(deps, 'warn', 'Failed to delete purged file from storage', {
            id: doc._id,
            key: doc.key,
            error: (err as Error).message,
          });
        }

        // Delete variants from storage
        if (doc.variants && doc.variants.length > 0) {
          for (const variant of doc.variants) {
            try {
              await deps.driver.delete(variant.key);
            } catch (err) {
              log(deps, 'warn', 'Failed to delete purged variant from storage', {
                id: doc._id,
                variant: variant.name,
                error: (err as Error).message,
              });
            }
          }
        }

        // Delete from database (trashedContext already has includeTrashed: true)
        const deleted = await deps.repository.deleteMedia(doc._id.toString(), trashedContext);
        if (deleted) {
          purgedCount++;
          batchDeleted++;
        }
      } catch (err) {
        log(deps, 'error', 'Failed to purge deleted file', {
          id: doc._id,
          error: (err as Error).message,
        });
      }
    }

    // No progress in this batch — break to avoid infinite loop
    if (batchDeleted === 0) {
      log(deps, 'warn', 'Purge batch made no progress, aborting', {
        remaining: docs.length,
      });
      break;
    }

    // If we got fewer than BATCH_SIZE, we've processed all qualifying docs
    if (docs.length < BATCH_SIZE) {
      break;
    }
  }

  log(deps, 'info', 'Purged soft-deleted files', {
    purgedCount,
    cutoff: cutoff.toISOString(),
  });

  return purgedCount;
}
