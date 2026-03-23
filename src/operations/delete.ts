/**
 * Delete operations — hard-delete single/multiple files from storage and database.
 */

import type { OperationDeps } from './types';
import type {
  OperationContext,
  IMediaDocument,
  BulkResult,
  EventContext,
  EventResult,
  EventError,
} from '../types';
import { log } from './helpers';

/**
 * Hard-delete a single file from storage and database.
 */
export async function deleteMedia(
  deps: OperationDeps,
  id: string,
  context?: OperationContext,
): Promise<boolean> {
  const eventCtx: EventContext<{ id: string }> = {
    data: { id },
    context,
    timestamp: new Date(),
  };
  await deps.events.emit('before:delete', eventCtx);

  try {
    const media = await deps.repository.getMediaById(id, context);
    if (!media) {
      return false;
    }

    // Delete main file from storage
    try {
      await deps.driver.delete(media.key);
    } catch (err) {
      log(deps, 'warn', 'Failed to delete main file from storage', {
        id,
        key: media.key,
        error: (err as Error).message,
      });
    }

    // Delete all size variants from storage
    if (media.variants && media.variants.length > 0) {
      for (const variant of media.variants) {
        try {
          await deps.driver.delete(variant.key);
        } catch (err) {
          log(deps, 'warn', 'Failed to delete variant from storage', {
            id,
            variant: variant.name,
            key: variant.key,
            error: (err as Error).message,
          });
        }
      }

      log(deps, 'info', 'Deleted variants', {
        id,
        count: media.variants.length,
      });
    }

    // Delete from database
    const deleted = await deps.repository.deleteMedia(id, context);

    if (deleted) {
      log(deps, 'info', 'Media deleted', { id });

      await deps.events.emit('after:delete', {
        context: eventCtx,
        result: { id, deleted: true },
        timestamp: new Date(),
      });
    }

    return deleted;
  } catch (error) {
    await deps.events.emit('error:delete', {
      context: eventCtx,
      error: error as Error,
      timestamp: new Date(),
    });
    throw error;
  }
}

/**
 * Hard-delete multiple files with semaphore-bounded concurrency.
 */
export async function deleteMany(
  deps: OperationDeps,
  ids: string[],
  context?: OperationContext,
): Promise<BulkResult> {
  const eventCtx: EventContext<{ ids: string[] }> = {
    data: { ids },
    context,
    timestamp: new Date(),
  };
  await deps.events.emit('before:deleteMany', eventCtx);

  const result: BulkResult = { success: [], failed: [] };

  await Promise.allSettled(
    ids.map((id) =>
      deps.uploadSemaphore.run(async () => {
        try {
          const deleted = await deleteMedia(deps, id, context);
          if (deleted) {
            result.success.push(id);
          } else {
            result.failed.push({ id, reason: 'Not found' });
          }
        } catch (err) {
          result.failed.push({ id, reason: (err as Error).message });
        }
      }),
    ),
  );

  await deps.events.emit('after:deleteMany', {
    context: eventCtx,
    result,
    timestamp: new Date(),
  });

  return result;
}
