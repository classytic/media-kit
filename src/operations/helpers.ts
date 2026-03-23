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
  if (!deps.config.multiTenancy?.enabled) {
    return undefined;
  }

  const organizationId = context?.organizationId;
  const field = deps.config.multiTenancy.field || 'organizationId';

  if (!organizationId && deps.config.multiTenancy.required) {
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
export async function copyStorageFile(
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
 * Shared 3-phase key-rewrite orchestration.
 *
 * Phase 1: Copy files to new storage keys (semaphore-bounded).
 * Phase 2: Bulk update DB (rollback copied files on failure).
 * Phase 3: Delete old storage keys (best-effort).
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
  const updates: Array<{ id: string; data: Record<string, unknown> }> = [];
  const copiedKeys: string[] = [];
  const keysToDelete: string[] = [];
  const failed: Array<{ id: string; reason: string }> = [];
  let completed = 0;

  // Phase 1: Copy files to new storage locations
  await Promise.allSettled(
    files.map((file) =>
      deps.uploadSemaphore.run(async () => {
        const fileId = file._id.toString();
        const { newKey, newFolder } = mapFile(file);

        // Key unchanged — just update folder field if needed
        if (file.key === newKey) {
          if (file.folder !== newFolder) {
            updates.push({ id: fileId, data: { folder: newFolder } });
          }
          completed++;
          // Fire-and-forget: don't block hot path
          void deps.events.emit(progressEvent, {
            fileId, completed, total, key: file.key, context, timestamp: new Date(),
          });
          return;
        }

        try {
          const writeResult = await copyStorageFile(deps.driver, file.key, newKey);
          copiedKeys.push(writeResult.key);
          keysToDelete.push(file.key);

          // Copy variants
          const newVariants: GeneratedVariant[] = [];
          for (const variant of (file.variants || []) as GeneratedVariant[]) {
            const newVarKey = mapVariantKey(variant.key);
            if (variant.key === newVarKey) {
              newVariants.push(variant);
              continue;
            }
            const varResult = await copyStorageFile(deps.driver, variant.key, newVarKey);
            copiedKeys.push(varResult.key);
            keysToDelete.push(variant.key);
            newVariants.push({ ...variant, key: varResult.key, url: varResult.url });
          }

          updates.push({
            id: fileId,
            data: {
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

  if (updates.length === 0) {
    return { modifiedCount: 0, failed };
  }

  // Phase 2: Bulk update DB (rollback copied files on failure)
  let modifiedCount: number;
  try {
    const result = await deps.repository.bulkUpdateMedia(updates, context);
    modifiedCount = result.modifiedCount;
  } catch (dbError) {
    for (const key of copiedKeys) {
      try { await deps.driver.delete(key); } catch { /* ignore rollback failure */ }
    }
    throw dbError;
  }

  // Phase 3: Delete old storage files (best-effort)
  for (const key of keysToDelete) {
    try {
      await deps.driver.delete(key);
    } catch (err) {
      log(deps, 'warn', 'Failed to delete old file after key rewrite', {
        key,
        error: (err as Error).message,
      });
    }
  }

  return { modifiedCount, failed };
}
