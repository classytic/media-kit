/**
 * Folder verbs — getFolderTree, getFolderStats, getBreadcrumb, deleteFolder,
 * renameFolder, getSubfolders.
 *
 * Extracted from MediaRepository; each function takes the repository as its
 * first parameter (getBreadcrumb is pure and takes none). The class methods
 * in media.repository.ts are thin delegates that preserve the public API
 * surface.
 */

import type { FolderTree, FolderStats, FolderNode, BreadcrumbItem, BulkResult, RewriteResult } from '../../types.js';
import type { MediaContext } from '../../engine/engine-types.js';
import { MEDIA_EVENTS } from '../../events/event-constants.js';
import { createMediaEvent } from '../../events/helpers.js';
import { normalizeFolderPath, buildFolderTree } from '../../utils/folders.js';
import { rewriteKeyPrefix, executeKeyRewrite, type RewritableFile } from '../../operations/helpers.js';
import type { MediaRepository } from '../media.repository.js';

export async function getFolderTreeVerb(repo: MediaRepository, ctx?: MediaContext): Promise<FolderTree> {
  // Route through `aggregatePipeline` so multiTenantPlugin + softDeletePlugin
  // inject their `$match` predicates as the leading stage. Raw
  // `Model.aggregate()` would bypass them — and would scope on the wrong
  // field name when `tenant.tenantField` differs from 'organizationId'.
  const folders = (await repo.aggregatePipeline(
    [
      {
        $group: { _id: '$folder', count: { $sum: 1 }, size: { $sum: '$size' }, latestUpload: { $max: '$createdAt' } },
      },
    ],
    repo._tenantOpts(ctx),
  )) as Array<{ _id: string; count: number; size: number; latestUpload: Date }>;

  const tree = buildFolderTree(
    folders.map((f) => ({
      folder: f._id,
      count: f.count,
      totalSize: f.size,
      latestUpload: f.latestUpload,
    })),
  );
  return tree;
}

export async function getFolderStatsVerb(
  repo: MediaRepository,
  folder: string,
  ctx?: MediaContext,
): Promise<FolderStats> {
  const folderRegex = `^${folder.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`;

  // Plugin-routed pipeline — tenant + soft-delete predicates auto-injected.
  const [stats] = (await repo.aggregatePipeline(
    [
      { $match: { folder: { $regex: folderRegex } } },
      {
        $group: {
          _id: null,
          totalFiles: { $sum: 1 },
          totalSize: { $sum: '$size' },
          avgSize: { $avg: '$size' },
          mimeTypes: { $addToSet: '$mimeType' },
          oldestFile: { $min: '$createdAt' },
          newestFile: { $max: '$createdAt' },
        },
      },
    ],
    repo._tenantOpts(ctx),
  )) as Array<FolderStats>;

  return stats || { totalFiles: 0, totalSize: 0, avgSize: 0, mimeTypes: [], oldestFile: null, newestFile: null };
}

export function getBreadcrumbVerb(folder: string): BreadcrumbItem[] {
  const parts = folder.split('/').filter(Boolean);
  return parts.map((name, index) => ({
    name,
    path: parts.slice(0, index + 1).join('/'),
  }));
}

export async function deleteFolderVerb(repo: MediaRepository, folder: string, ctx?: MediaContext): Promise<BulkResult> {
  // Plugin-routed read — multiTenantPlugin scopes by configured tenant
  // field; softDeletePlugin filters out already-deleted rows.
  const found = await repo.getAll(
    { filters: { folder: { $regex: `^${folder.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}` } } },
    { lean: true, select: '_id', ...repo._tenantOpts(ctx) } as Record<string, unknown>,
  );
  const files = (Array.isArray(found) ? found : (found as { data: unknown[] }).data) as Array<{ _id: unknown }>;

  const ids = files.map((f) => String(f._id));
  const result = await repo.hardDeleteMany(ids, ctx);

  await repo.events.publish(
    createMediaEvent(
      MEDIA_EVENTS.FOLDER_DELETED,
      {
        folder,
        deletedCount: result.success.length,
      },
      ctx,
    ),
  );

  return result;
}

export async function renameFolderVerb(
  repo: MediaRepository,
  oldPath: string,
  newPath: string,
  ctx?: MediaContext,
): Promise<RewriteResult> {
  const normalizedOld = normalizeFolderPath(oldPath);
  const normalizedNew = normalizeFolderPath(newPath);
  const rewriteKeys = repo.mediaConfig.folders?.rewriteKeys !== false;
  const folderRegex = `^${normalizedOld.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`;

  // Plugin-routed read — multiTenant + softDelete predicates auto-applied.
  const found = await repo.getAll({ filters: { folder: { $regex: folderRegex } } }, {
    lean: true,
    ...repo._tenantOpts(ctx),
  } as Record<string, unknown>);
  const files = (Array.isArray(found) ? found : (found as { data: unknown[] }).data) as unknown as RewritableFile[];

  if (!rewriteKeys) {
    // Metadata-only rename. updateMany only accepts an operator-shaped update,
    // not a pipeline expression — apply the prefix swap per-doc via the IDs we
    // already loaded above (they were tenant-scoped on the read).
    const updates = files
      .filter((f) => f.folder.startsWith(normalizedOld))
      .map((f) => ({
        id: f._id.toString(),
        data: { folder: normalizedNew + f.folder.slice(normalizedOld.length) },
      }));
    const { modifiedCount } = await repo.bulkUpdateMedia(updates, repo._tenantOpts(ctx));
    await repo.events.publish(
      createMediaEvent(
        MEDIA_EVENTS.FOLDER_RENAMED,
        {
          oldPath: normalizedOld,
          newPath: normalizedNew,
          modifiedCount,
        },
        ctx,
      ),
    );
    return { modifiedCount, failed: [] };
  }

  // Full key rewrite
  const result = await executeKeyRewrite(
    repo._opDeps,
    files,
    (file) => {
      const newFolder = file.folder.replace(normalizedOld, normalizedNew);
      return { newKey: rewriteKeyPrefix(file.key, normalizedOld, normalizedNew), newFolder };
    },
    (variantKey) => rewriteKeyPrefix(variantKey, normalizedOld, normalizedNew),
    'progress:rename',
    repo._opCtx(ctx),
  );

  await repo.events.publish(
    createMediaEvent(
      MEDIA_EVENTS.FOLDER_RENAMED,
      {
        oldPath: normalizedOld,
        newPath: normalizedNew,
        modifiedCount: result.modifiedCount,
      },
      ctx,
    ),
  );

  return result;
}

export async function getSubfoldersVerb(
  repo: MediaRepository,
  parentPath: string,
  ctx?: MediaContext,
): Promise<FolderNode[]> {
  const normalized = normalizeFolderPath(parentPath);
  const escapedPath = normalized.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const depth = normalized.split('/').filter(Boolean).length;

  // Plugin-routed pipeline — tenant + soft-delete predicates auto-injected.
  const results = (await repo.aggregatePipeline(
    [
      { $match: { folder: { $regex: `^${escapedPath}/` } } },
      {
        $addFields: {
          folderParts: { $split: ['$folder', '/'] },
        },
      },
      {
        $addFields: {
          subfolder: {
            $reduce: {
              input: { $slice: ['$folderParts', 0, depth + 1] },
              initialValue: '',
              in: { $cond: [{ $eq: ['$$value', ''] }, '$$this', { $concat: ['$$value', '/', '$$this'] }] },
            },
          },
        },
      },
      {
        $group: {
          _id: '$subfolder',
          count: { $sum: 1 },
          size: { $sum: '$size' },
          latestUpload: { $max: '$createdAt' },
        },
      },
      { $sort: { _id: 1 } },
    ],
    repo._tenantOpts(ctx),
  )) as Array<{ _id: string; count: number; size: number; latestUpload: Date }>;

  return results.map((r) => ({
    id: r._id,
    name: r._id.split('/').pop() || r._id,
    path: r._id,
    stats: { count: r.count, size: r.size },
    children: [],
    latestUpload: r.latestUpload,
  }));
}
