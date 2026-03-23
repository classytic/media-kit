/**
 * Folder operations — tree, stats, breadcrumb, deleteFolder, renameFolder, subfolders.
 */

import type { OperationDeps } from './types';
import type {
  OperationContext,
  FolderTree,
  FolderStats,
  FolderNode,
  BreadcrumbItem,
  BulkResult,
  EventError,
  RewriteResult,
} from '../types';
import { normalizeFolderPath } from '../utils/folders';
import { log, rewriteKeyPrefix, executeKeyRewrite } from './helpers';

export async function getFolderTree(
  deps: OperationDeps,
  context?: OperationContext,
): Promise<FolderTree> {
  return deps.repository.getFolderTree(context);
}

export async function getFolderStats(
  deps: OperationDeps,
  folder: string,
  context?: OperationContext,
): Promise<FolderStats> {
  return deps.repository.getFolderStats(folder, context);
}

export function getBreadcrumb(
  deps: OperationDeps,
  folder: string,
): BreadcrumbItem[] {
  return deps.repository.getBreadcrumb(folder);
}

/**
 * Delete a folder and all its files.
 * Uses semaphore-bounded parallelism for storage deletion.
 */
export async function deleteFolder(
  deps: OperationDeps,
  folder: string,
  context?: OperationContext,
): Promise<BulkResult> {
  const files = await deps.repository.getFilesInFolder(folder, context);

  const result: BulkResult = { success: [], failed: [] };

  // Delete storage files in parallel with semaphore
  await Promise.allSettled(
    files.map((file) =>
      deps.uploadSemaphore.run(async () => {
        try {
          // Delete main file
          await deps.driver.delete(file.key);

          // Delete all variants
          if (file.variants && file.variants.length > 0) {
            for (const variant of file.variants) {
              try {
                await deps.driver.delete(variant.key);
              } catch (err) {
                log(deps, 'warn', 'Failed to delete variant in folder deletion', {
                  folder,
                  fileId: file._id.toString(),
                  variant: variant.name,
                  error: (err as Error).message,
                });
              }
            }
          }

          result.success.push(file._id.toString());
        } catch (err) {
          result.failed.push({
            id: file._id.toString(),
            reason: (err as Error).message,
          });
        }
      }),
    ),
  );

  // Bulk delete from database
  const successIds = result.success;
  if (successIds.length > 0) {
    await deps.repository.deleteManyMedia(successIds, context);
  }

  log(deps, 'info', 'Folder deleted', {
    folder,
    deleted: result.success.length,
    failed: result.failed.length,
  });

  return result;
}

/**
 * Rename/move a folder and all its contents.
 * With rewriteKeys (default), physically copies files to new storage keys.
 */
export async function renameFolder(
  deps: OperationDeps,
  oldPath: string,
  newPath: string,
  context?: OperationContext,
): Promise<RewriteResult> {
  const normalizedOld = normalizeFolderPath(oldPath);
  const normalizedNew = normalizeFolderPath(newPath);

  const eventCtx = {
    data: { oldPath: normalizedOld, newPath: normalizedNew },
    context,
    timestamp: new Date(),
  };
  await deps.events.emit('before:rename', eventCtx);

  try {
    const rewriteKeys = deps.config.folders?.rewriteKeys ?? true;

    if (!rewriteKeys) {
      // Metadata-only: delegate to repository's folder rename
      const dbResult = await deps.repository.renameFolder(normalizedOld, normalizedNew, context);
      const result: RewriteResult = { modifiedCount: dbResult.modifiedCount, failed: [] };

      await deps.events.emit('after:rename', {
        context: eventCtx,
        result,
        timestamp: new Date(),
      });

      log(deps, 'info', 'Folder renamed (metadata-only)', {
        oldPath: normalizedOld,
        newPath: normalizedNew,
        modifiedCount: result.modifiedCount,
      });
      return result;
    }

    // Full key rewrite via shared orchestration
    const files = await deps.repository.getFilesInFolder(normalizedOld, context);
    if (files.length === 0) {
      return { modifiedCount: 0, failed: [] };
    }

    const result = await executeKeyRewrite(
      deps,
      files,
      (file) => ({
        newKey: rewriteKeyPrefix(file.key, normalizedOld, normalizedNew),
        newFolder: file.folder === normalizedOld
          ? normalizedNew
          : normalizedNew + file.folder.slice(normalizedOld.length),
      }),
      (variantKey) => rewriteKeyPrefix(variantKey, normalizedOld, normalizedNew),
      'progress:rename',
      context,
    );

    await deps.events.emit('after:rename', {
      context: eventCtx,
      result,
      timestamp: new Date(),
    });

    log(deps, 'info', 'Folder renamed', {
      oldPath: normalizedOld,
      newPath: normalizedNew,
      modifiedCount: result.modifiedCount,
      failed: result.failed.length,
    });
    return result;
  } catch (error) {
    const errorEvent: EventError<{ oldPath: string; newPath: string }> = {
      context: eventCtx,
      error: error as Error,
      timestamp: new Date(),
    };
    await deps.events.emit('error:rename', errorEvent);
    throw error;
  }
}

export async function getSubfolders(
  deps: OperationDeps,
  parentPath: string,
  context?: OperationContext,
): Promise<FolderNode[]> {
  return deps.repository.getSubfolders(parentPath, context);
}
