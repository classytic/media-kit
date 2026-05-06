/**
 * Shared helper functions for all operations.
 * Pure functions that read from OperationDeps but don't call other operations.
 */

import crypto from 'crypto';
import type { OperationDeps, ConfigOnlyDeps } from './types';
import type {
  OperationContext,
  AspectRatioPreset,
  StorageDriver,
  WriteResult,
  GeneratedVariant,
  MediaEventName,
  RewriteResult,
} from '../types';
import { isAllowedMimeType } from '../utils/mime';

/**
 * Log helper that safely no-ops if logger is undefined.
 */
export function log(
  deps: OperationDeps,
  level: 'info' | 'warn' | 'error',
  message: string,
  meta?: Record<string, unknown>,
): void {
  if (deps.logger) {
    deps.logger[level](message, meta);
  }
}

/**
 * Require tenant context when multi-tenancy is enabled.
 * Returns the organizationId or undefined.
 */
export function requireTenant(
  deps: OperationDeps,
  context?: OperationContext,
): OperationContext['organizationId'] | undefined {
  const { tenant } = deps.config;
  if (!tenant?.enabled) {
    return undefined;
  }

  const organizationId = context?.organizationId;
  const field = tenant.tenantField;

  if (!organizationId && tenant.required) {
    throw new Error(`Multi-tenancy enabled: '${field}' is required in context`);
  }

  return organizationId;
}

/**
 * Get content type from folder path using config's contentTypeMap.
 */
export function getContentType(deps: ConfigOnlyDeps, folder: string): string {
  const contentTypeMap = deps.config.folders?.contentTypeMap || {};
  const folderLower = folder.toLowerCase();

  for (const [contentType, patterns] of Object.entries(contentTypeMap)) {
    if (patterns.some((p: string) => folderLower.includes(p.toLowerCase()))) {
      return contentType;
    }
  }

  return 'default';
}

/**
 * Get aspect ratio preset for a content type.
 */
export function getAspectRatio(
  deps: ConfigOnlyDeps,
  contentType: string,
): AspectRatioPreset | undefined {
  return (
    deps.config.processing?.aspectRatios?.[contentType] ||
    deps.config.processing?.aspectRatios?.default
  );
}

/**
 * Generate a storage key for a file.
 * Format: folder/timestamp-random-sanitizedName.ext
 */
export function generateKey(filename: string, folder: string): string {
  const timestamp = Date.now();
  const random = crypto.randomBytes(6).toString('hex');
  const safeName = filename.replace(/[^a-zA-Z0-9.-]/g, '_');
  const baseName = safeName.replace(/\.[^/.]+$/, '');
  const ext = safeName.split('.').pop() || 'bin';
  return `${folder}/${timestamp}-${random}-${baseName}.${ext}`;
}

/**
 * Auto-generate a human-readable title from a filename.
 */
export function generateTitle(filename: string): string {
  const name = filename.replace(/\.[^.]+$/, '');
  return name.replace(/[-_]/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Validate file buffer, filename, and MIME type against config rules.
 */
export function validateFile(
  deps: ConfigOnlyDeps,
  buffer: Buffer,
  filename: string,
  mimeType: string,
): void {
  if (!buffer || buffer.length === 0) {
    throw new Error(`Cannot upload empty file '${filename}'. Buffer is empty or missing.`);
  }

  const { allowed = [], maxSize } = deps.config.fileTypes || {};

  if (allowed.length > 0 && !isAllowedMimeType(mimeType, allowed)) {
    throw new Error(`File type '${mimeType}' is not allowed. Allowed: ${allowed.join(', ')}`);
  }

  if (maxSize && buffer.length > maxSize) {
    const maxMB = Math.round(maxSize / 1024 / 1024);
    throw new Error(`File size exceeds limit of ${maxMB}MB`);
  }
}

/**
 * Copy a file between storage keys.
 * Uses driver.copy() if available, otherwise read → write fallback.
 */
async function copyStorageFile(
  driver: StorageDriver,
  sourceKey: string,
  destinationKey: string,
): Promise<WriteResult> {
  if (driver.copy) {
    return driver.copy(sourceKey, destinationKey);
  }
  const stat = await driver.stat(sourceKey);
  const stream = await driver.read(sourceKey);
  return driver.write(destinationKey, stream, stat.contentType);
}

/**
 * Derive new key by placing the filename under a new folder.
 * Extracts the last path segment (unique filename) and combines with targetFolder.
 */
export function rewriteKey(oldKey: string, targetFolder: string): string {
  const filename = oldKey.split('/').pop() || oldKey;
  return `${targetFolder}/${filename}`;
}

/**
 * Derive new key by replacing a folder prefix.
 * Used by renameFolder to remap nested paths.
 */
export function rewriteKeyPrefix(key: string, oldPrefix: string, newPrefix: string): string {
  if (key.startsWith(oldPrefix + '/')) {
    return newPrefix + key.slice(oldPrefix.length);
  }
  if (key === oldPrefix) {
    return newPrefix;
  }
  return key;
}

/**
 * File-to-new-location mapping produced by the caller's key strategy.
 */
export interface KeyRewriteMapping {
  newKey: string;
  newFolder: string;
}

/**
 * Minimal file shape needed by the rewrite engine.
 */
export interface RewritableFile {
  _id: { toString(): string };
  key: string;
  folder: string;
  variants?: GeneratedVariant[];
}

/**
 * Per-file rewrite plan — kept together so the cleanup phases can correlate
 * "which DB row landed" against "which old keys are safe to delete." Stored
 * IN ORDER alongside the file so a partial DB update doesn't desync from
 * storage state.
 */
interface RewritePlan {
  fileId: string;
  oldKey: string;
  newKey: string;
  /** Old variant keys we deleted-after — empty when no variants moved. */
  oldVariantKeys: string[];
  /** New keys we copied to (main + variants) — used for orphan rollback. */
  newKeysCopied: string[];
  /** Update payload for `bulkUpdateMedia`. */
  updateData: Record<string, unknown>;
}

/**
 * Shared 3-phase key-rewrite orchestration.
 *
 * Phase 1: Copy files to new storage keys (semaphore-bounded).
 * Phase 2: Bulk update DB; capture per-file success/fail.
 * Phase 3a: Delete old keys ONLY for files whose DB update succeeded.
 * Phase 3b: Delete orphaned new copies for files whose DB update failed.
 *
 * **Storage-DB consistency contract.** A document's `key` field always
 * points to an object that exists in storage. If the DB update fails, the
 * old key stays alive (DB still references it) and the new copy is
 * rolled back. If the DB update succeeds, the old key is deleted (DB
 * no longer references it). At no point does the DB point at a deleted
 * object — that was the corruption shape that motivated this design.
 *
 * Progress events are fire-and-forget (not awaited) so slow listeners
 * can't throttle storage copy throughput.
 */
export async function executeKeyRewrite(
  deps: OperationDeps,
  files: RewritableFile[],
  mapFile: (file: RewritableFile) => KeyRewriteMapping,
  mapVariantKey: (variantKey: string) => string,
  progressEvent: MediaEventName,
  context?: OperationContext,
): Promise<RewriteResult> {
  const total = files.length;
  const plans: RewritePlan[] = [];
  const noOpUpdates: Array<{ id: string; data: Record<string, unknown> }> = [];
  const failed: Array<{ id: string; reason: string }> = [];
  let completed = 0;

  // Phase 1: Copy files to new storage locations. Each file's plan is
  // captured atomically — copy + correlate within the same task — so a
  // partial copy failure can't desync the cleanup phase from the DB phase.
  await Promise.allSettled(
    files.map((file) =>
      deps.uploadSemaphore.run(async () => {
        const fileId = file._id.toString();
        const { newKey, newFolder } = mapFile(file);

        // Key unchanged — folder-only update, no storage work
        if (file.key === newKey) {
          if (file.folder !== newFolder) {
            noOpUpdates.push({ id: fileId, data: { folder: newFolder } });
          }
          completed++;
          void deps.events.emit(progressEvent, {
            fileId, completed, total, key: file.key, context, timestamp: new Date(),
          });
          return;
        }

        const newKeysCopied: string[] = [];
        const oldVariantKeys: string[] = [];
        try {
          const writeResult = await copyStorageFile(deps.driver, file.key, newKey);
          newKeysCopied.push(writeResult.key);

          const newVariants: GeneratedVariant[] = [];
          for (const variant of (file.variants || []) as GeneratedVariant[]) {
            const newVarKey = mapVariantKey(variant.key);
            if (variant.key === newVarKey) {
              newVariants.push(variant);
              continue;
            }
            const varResult = await copyStorageFile(deps.driver, variant.key, newVarKey);
            newKeysCopied.push(varResult.key);
            oldVariantKeys.push(variant.key);
            newVariants.push({ ...variant, key: varResult.key, url: varResult.url });
          }

          plans.push({
            fileId,
            oldKey: file.key,
            newKey: writeResult.key,
            oldVariantKeys,
            newKeysCopied,
            updateData: {
              folder: newFolder,
              key: writeResult.key,
              url: writeResult.url,
              variants: newVariants.length > 0 ? newVariants : file.variants,
            },
          });

          completed++;
          void deps.events.emit(progressEvent, {
            fileId, completed, total, key: writeResult.key, context, timestamp: new Date(),
          });
        } catch (err) {
          const reason = (err as Error).message;
          failed.push({ id: fileId, reason });
          completed++;
          // Roll back any partial copies for THIS file before bailing out.
          // Without this, a variant-copy failure mid-way would leave the
          // first few new keys orphaned even though no DB update lands.
          for (const orphan of newKeysCopied) {
            try { await deps.driver.delete(orphan); } catch { /* ignore */ }
          }
          void deps.events.emit(progressEvent, {
            fileId, completed, total, key: file.key, context, timestamp: new Date(),
          });
          log(deps, 'warn', 'Failed to copy file during key rewrite', {
            id: fileId,
            oldKey: file.key,
            newKey,
            error: reason,
          });
        }
      }),
    ),
  );

  const allUpdates = [
    ...plans.map((p) => ({ id: p.fileId, data: p.updateData })),
    ...noOpUpdates,
  ];

  if (allUpdates.length === 0) {
    return { modifiedCount: 0, failed };
  }

  // Phase 2: Apply DB updates and learn which ones landed. A wholesale
  // throw rolls back EVERY copied key (no DB row references them); a
  // partial failure rolls back only the orphaned copies (per-plan).
  let succeededIds: Set<string>;
  let perFileFailures: Array<{ id: string; reason: string }>;
  try {
    const result = await deps.repository.bulkUpdateMedia(allUpdates, context);
    succeededIds = result.succeededIds;
    perFileFailures = result.failed;
  } catch (dbError) {
    for (const plan of plans) {
      for (const key of plan.newKeysCopied) {
        try { await deps.driver.delete(key); } catch { /* ignore rollback failure */ }
      }
    }
    throw dbError;
  }

  // Phase 3a: Delete old storage files ONLY for plans whose DB update landed.
  // For plans whose DB update failed, the document still references oldKey —
  // deleting it would leave the row pointing at a missing object (the
  // corruption this design prevents).
  for (const plan of plans) {
    if (!succeededIds.has(plan.fileId)) continue;
    for (const oldKey of [plan.oldKey, ...plan.oldVariantKeys]) {
      try {
        await deps.driver.delete(oldKey);
      } catch (err) {
        log(deps, 'warn', 'Failed to delete old file after key rewrite', {
          key: oldKey,
          error: (err as Error).message,
        });
      }
    }
  }

  // Phase 3b: Roll back orphaned new copies for plans whose DB update failed.
  // Without this, a copy lives in storage that no document references —
  // a slow storage leak.
  for (const plan of plans) {
    if (succeededIds.has(plan.fileId)) continue;
    for (const newKey of plan.newKeysCopied) {
      try { await deps.driver.delete(newKey); } catch { /* ignore rollback failure */ }
    }
    // Surface the failure so callers can react / log / alert.
    const dbFailure = perFileFailures.find((f) => f.id === plan.fileId);
    failed.push({
      id: plan.fileId,
      reason: dbFailure?.reason ?? 'DB update did not land',
    });
  }

  return { modifiedCount: succeededIds.size, failed };
}
