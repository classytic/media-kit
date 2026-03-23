/**
 * Move operation — move files to a different folder.
 * Supports physical storage key rewrite (default) or metadata-only mode.
 */

import type { OperationDeps } from './types';
import type { OperationContext, EventContext, EventError, RewriteResult } from '../types';
import { normalizeFolderPath } from '../utils/folders';
import { log, rewriteKey, executeKeyRewrite } from './helpers';

export async function move(
  deps: OperationDeps,
  ids: string[],
  targetFolder: string,
  context?: OperationContext,
): Promise<RewriteResult> {
  const folder = normalizeFolderPath(targetFolder);

  const eventCtx: EventContext<{ ids: string[]; targetFolder: string }> = {
    data: { ids, targetFolder: folder },
    context,
    timestamp: new Date(),
  };
  await deps.events.emit('before:move', eventCtx);

  try {
    const rewriteKeys = deps.config.folders?.rewriteKeys ?? true;

    if (!rewriteKeys) {
      // Metadata-only: just update the folder field in DB
      const dbResult = await deps.repository.moveToFolder(ids, folder, context);
      const result: RewriteResult = { modifiedCount: dbResult.modifiedCount, failed: [] };

      await deps.events.emit('after:move', {
        context: eventCtx,
        result,
        timestamp: new Date(),
      });

      return result;
    }

    // Full key rewrite via shared orchestration
    const files = await deps.repository.getMediaByIds(ids, context);
    if (files.length === 0) {
      return { modifiedCount: 0, failed: [] };
    }

    const result = await executeKeyRewrite(
      deps,
      files,
      (file) => ({
        newKey: rewriteKey(file.key, folder),
        newFolder: folder,
      }),
      (variantKey) => rewriteKey(variantKey, folder),
      'progress:move',
      context,
    );

    log(deps, 'info', 'Files moved', {
      targetFolder: folder,
      moved: result.modifiedCount,
      failed: result.failed.length,
      total: files.length,
    });

    await deps.events.emit('after:move', {
      context: eventCtx,
      result,
      timestamp: new Date(),
    });

    return result;
  } catch (error) {
    const errorEvent: EventError<{ ids: string[]; targetFolder: string }> = {
      context: eventCtx,
      error: error as Error,
      timestamp: new Date(),
    };
    await deps.events.emit('error:move', errorEvent);
    throw error;
  }
}
