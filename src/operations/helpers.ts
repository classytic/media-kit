/**
 * Shared helper functions for all operations.
 * Pure functions that read from OperationDeps but don't call other operations.
 */

import crypto from 'node:crypto';
import { createError } from '@classytic/repo-core/errors';
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
import { isExternalMedia } from '../utils/external';

/**
 * Rebind an OperationDeps bag to a specific storage driver.
 *
 * Operation helpers that touch storage (`processImage`, variant cleanup)
 * write through `deps.driver`. In multi-provider setups the caller resolves
 * the target driver per upload/replace (`input.provider` → registry) — this
 * helper produces a deps view whose `driver` IS that resolved driver, so
 * variants land in the SAME provider as the main file instead of silently
 * defaulting.
 *
 * `processor` is forwarded through a getter (not copied): the repository's
 * own deps expose it lazily because `processorReady` may null it out after
 * construction (sharp unavailable). Copying the value here would freeze a
 * possibly-stale processor before that promise settles.
 */
export function withDriver(deps: OperationDeps, driver: StorageDriver): OperationDeps {
  if (deps.driver === driver) return deps;
  return {
    config: deps.config,
    driver,
    registry: deps.registry,
    repository: deps.repository,
    get processor() {
      return deps.processor;
    },
    processorReady: deps.processorReady,
    events: deps.events,
    uploadSemaphore: deps.uploadSemaphore,
    logger: deps.logger,
  };
}

/**
 * Best-effort delete of storage keys through a SPECIFIC driver — the shared
 * primitive behind every orphan-rollback path (processImage's internal
 * cleanup, upload/replace rollback, presigned reprocess rollback).
 *
 * Delete errors never rethrow — they are reported to `onFailure` (when
 * given) and otherwise swallowed. Deleting an already-deleted key is a
 * driver-level no-op, so two cleanup layers (e.g. processImage's internal
 * cleanup AND a caller's `onWrite`-fed rollback list) can safely overlap.
 */
export async function deleteKeysBestEffort(
  driver: StorageDriver,
  keys: readonly string[],
  onFailure?: (key: string, error: Error) => void,
): Promise<void> {
  for (const key of keys) {
    try {
      await driver.delete(key);
    } catch (err) {
      onFailure?.(key, err as Error);
    }
  }
}

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
export function getAspectRatio(deps: ConfigOnlyDeps, contentType: string): AspectRatioPreset | undefined {
  return deps.config.processing?.aspectRatios?.[contentType] || deps.config.processing?.aspectRatios?.default;
}

/** Normalize a deployment key-prefix into a clean single path segment set:
 *  trims, drops leading/trailing slashes, collapses repeats. Empty → ''. */
export function normalizeKeyPrefix(keyPrefix?: string): string {
  if (!keyPrefix) return '';
  return keyPrefix
    .trim()
    .replace(/^\/+|\/+$/g, '')
    .replace(/\/{2,}/g, '/');
}

/**
 * Generate a storage key for a file.
 * Format: [keyPrefix/]folder/timestamp-random-sanitizedName.ext
 *
 * `keyPrefix` (optional) namespaces the STORAGE KEY for a deployment sharing
 * a bucket with other companies — it is NOT part of the `folder` metadata.
 * Omitted/empty → the classic `folder/…` shape (back-compatible).
 */
export function generateKey(filename: string, folder: string, keyPrefix?: string): string {
  const timestamp = Date.now();
  const random = crypto.randomBytes(6).toString('hex');
  const safeName = filename.replace(/[^a-zA-Z0-9.-]/g, '_');
  const baseName = safeName.replace(/\.[^/.]+$/, '');
  const ext = safeName.split('.').pop() || 'bin';
  const prefix = normalizeKeyPrefix(keyPrefix);
  return `${prefix ? `${prefix}/` : ''}${folder}/${timestamp}-${random}-${baseName}.${ext}`;
}

/**
 * Reserved tenant-scope key segment. `__`-prefixed segments are this
 * package's internal namespace (same convention as `__transforms/` and the
 * `__original` variant) — host folders must not use the prefix, so a
 * `__t-<id>` segment in a key is unambiguously a tenant binding, never a
 * folder name (`products/t-shirts` stays a plain folder).
 */
const TENANT_SEGMENT_PREFIX = '__t-';
const TENANT_SEGMENT_SHAPE = /^__t-[a-zA-Z0-9_-]+$/;

/** Sanitized `__t-<organizationId>` segment (ObjectId hex / UUIDs pass through unchanged). */
export function tenantKeySegment(organizationId: unknown): string {
  return `${TENANT_SEGMENT_PREFIX}${String(organizationId).replace(/[^a-zA-Z0-9_-]/g, '_')}`;
}

/**
 * Generate a storage key for CLIENT-COMPLETED upload flows (presign,
 * multipart, resumable). When the caller context carries a tenant, the key
 * embeds a `__t-<orgId>` segment so confirm-time can verify the key was
 * minted FOR that tenant — a leaked unconfirmed key cannot be claimed by
 * anyone else. Without a tenant the format is identical to generateKey().
 */
export function generateScopedKey(
  filename: string,
  folder: string,
  organizationId?: unknown,
  keyPrefix?: string,
): string {
  if (organizationId === undefined || organizationId === null || organizationId === '') {
    return generateKey(filename, folder, keyPrefix);
  }
  return generateKey(filename, `${folder}/${tenantKeySegment(organizationId)}`, keyPrefix);
}

/**
 * Basename shape produced by {@link generateKey}:
 * `<ms-timestamp>-<12 hex chars>-<sanitized name>.<ext>`.
 * Name/ext segments are restricted to the sanitizer charset ([a-zA-Z0-9._-]).
 */
const GENERATED_KEY_BASENAME = /^\d{13,}-[0-9a-f]{12}-[a-zA-Z0-9._-]*\.[a-zA-Z0-9_-]+$/;

/** Result of {@link assertGeneratedKeyShape} — the extracted tenant binding, if any. */
export interface GeneratedKeyShape {
  /** Full `__t-<orgId>` segment when the key was minted tenant-scoped, else undefined. */
  tenantSegment: string | undefined;
  /** Folder path with the tenant segment (if any) stripped — safe for the doc's `folder` field. */
  folder: string;
}

/**
 * Assert that a client-submitted storage key has exactly the shape this
 * package's {@link generateScopedKey} produces under a normalized folder
 * prefix, and extract its tenant binding.
 *
 * confirmUpload() must never trust a raw client key — without this check a
 * caller could register (and later hard-delete or read through transforms)
 * arbitrary storage objects, including paths outside the presign folder
 * space. Throws a 400 HttpError (`code: 'media.confirm.invalid_key'`).
 *
 * A `__t-` segment is accepted ONLY in the position generateScopedKey mints
 * it (immediately before the basename) and only in the sanitizer charset —
 * anywhere else is a hand-crafted key.
 */
export function assertGeneratedKeyShape(key: string): GeneratedKeyShape {
  const fail = (reason: string): never => {
    const err = createError(400, `Invalid storage key '${key}': ${reason}`);
    err.code = 'media.confirm.invalid_key';
    throw err;
  };

  if (key.includes('\\') || key.includes('://')) fail('malformed path');
  const segments = key.split('/');
  if (segments.length < 2) fail('missing folder prefix');
  // Empty segments cover leading/trailing/duplicate slashes (non-normalized
  // folder); '.'/'..' segments are path traversal.
  if (segments.some((s) => s === '' || s === '.' || s === '..')) fail('path traversal or non-normalized folder');
  const basename = segments[segments.length - 1]!;
  if (!GENERATED_KEY_BASENAME.test(basename)) fail('basename does not match the generated-key format');

  const maybeTenant = segments.length >= 3 ? segments[segments.length - 2]! : undefined;
  const tenantSegment =
    maybeTenant !== undefined && maybeTenant.startsWith(TENANT_SEGMENT_PREFIX) ? maybeTenant : undefined;
  if (tenantSegment !== undefined && !TENANT_SEGMENT_SHAPE.test(tenantSegment)) {
    fail('malformed tenant segment');
  }
  // The tenant segment position is the ONLY place the reserved prefix may
  // appear; a folder path segment using it is a forgery attempt.
  const folderSegments = segments.slice(0, tenantSegment !== undefined ? -2 : -1);
  if (folderSegments.some((s) => s.startsWith(TENANT_SEGMENT_PREFIX))) {
    fail('reserved tenant segment in folder path');
  }
  if (tenantSegment !== undefined && folderSegments.length === 0) fail('missing folder prefix');

  return { tenantSegment, folder: folderSegments.join('/') };
}

/**
 * Derive aspect ratio from dimensions — the SAME convention processImage
 * uses when it stores server-computed dimensions (`width / height`,
 * unrounded; undefined unless both are positive). Used to derive
 * `aspectRatio` from client-computed display hints so client-processed and
 * server-processed records store the same shape.
 */
export function deriveAspectRatio(width?: number, height?: number): number | undefined {
  return width && height ? width / height : undefined;
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
export function validateFile(deps: ConfigOnlyDeps, buffer: Buffer, filename: string, mimeType: string): void {
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
async function copyStorageFile(driver: StorageDriver, sourceKey: string, destinationKey: string): Promise<WriteResult> {
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
  if (key.startsWith(`${oldPrefix}/`)) {
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
  /** Storage provider name — `'external'` marks reference-only records (no storage ops). */
  provider?: string | undefined;
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
  /**
   * The driver that stored THIS file (`file.provider` → registry, default
   * when absent). Files in one folder can span providers, so every copy /
   * delete / rollback for this plan must go through this driver — a single
   * deps-level driver would copy from (and delete in) the wrong backend.
   */
  driver: StorageDriver;
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
 * **Per-file provider routing.** Files in a single folder can span storage
 * providers (each doc stores its own `provider`), so the driver is resolved
 * PER FILE (`registry.resolve(file.provider)`, default when absent) and
 * every phase (copy, old-key delete, orphan rollback) goes through that
 * file's own driver. External (reference-only) records never reach storage
 * ops — their sentinel key takes the key-unchanged, DB-only branch.
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
        const mapped = mapFile(file);
        const newFolder = mapped.newFolder;
        // External (reference-only) records: the `__external__/…` sentinel
        // key is NOT a storage location — it must never be rewritten into
        // copy/delete ops. A folder move/rename is DB-only for them (the
        // key-unchanged branch below).
        const newKey = isExternalMedia(file) ? file.key : mapped.newKey;

        // Key unchanged — folder-only update, no storage work
        if (file.key === newKey) {
          if (file.folder !== newFolder) {
            noOpUpdates.push({ id: fileId, data: { folder: newFolder } });
          }
          completed++;
          void deps.events.emit(progressEvent, {
            fileId,
            completed,
            total,
            key: file.key,
            context,
            timestamp: new Date(),
          });
          return;
        }

        const newKeysCopied: string[] = [];
        const oldVariantKeys: string[] = [];
        // Resolve THIS file's driver (doc-stored provider, default when
        // absent). Inside the try: an unregistered provider name records a
        // per-file failure instead of failing the whole batch. External
        // records never reach here (key-unchanged branch above).
        let fileDriver: StorageDriver | undefined;
        try {
          fileDriver = deps.registry.resolve(file.provider);
          const writeResult = await copyStorageFile(fileDriver, file.key, newKey);
          newKeysCopied.push(writeResult.key);

          const newVariants: GeneratedVariant[] = [];
          for (const variant of (file.variants || []) as GeneratedVariant[]) {
            const newVarKey = mapVariantKey(variant.key);
            if (variant.key === newVarKey) {
              newVariants.push(variant);
              continue;
            }
            const varResult = await copyStorageFile(fileDriver, variant.key, newVarKey);
            newKeysCopied.push(varResult.key);
            oldVariantKeys.push(variant.key);
            newVariants.push({ ...variant, key: varResult.key, url: varResult.url });
          }

          plans.push({
            fileId,
            oldKey: file.key,
            newKey: writeResult.key,
            driver: fileDriver,
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
            fileId,
            completed,
            total,
            key: writeResult.key,
            context,
            timestamp: new Date(),
          });
        } catch (err) {
          const reason = (err as Error).message;
          failed.push({ id: fileId, reason });
          completed++;
          // Roll back any partial copies for THIS file before bailing out.
          // Without this, a variant-copy failure mid-way would leave the
          // first few new keys orphaned even though no DB update lands.
          // (fileDriver is always assigned when newKeysCopied is non-empty —
          // resolve() runs before the first copy.)
          if (fileDriver) {
            for (const orphan of newKeysCopied) {
              try {
                await fileDriver.delete(orphan);
              } catch {
                /* ignore */
              }
            }
          }
          void deps.events.emit(progressEvent, {
            fileId,
            completed,
            total,
            key: file.key,
            context,
            timestamp: new Date(),
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

  const allUpdates = [...plans.map((p) => ({ id: p.fileId, data: p.updateData })), ...noOpUpdates];

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
        try {
          await plan.driver.delete(key);
        } catch {
          /* ignore rollback failure */
        }
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
        await plan.driver.delete(oldKey);
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
      try {
        await plan.driver.delete(newKey);
      } catch {
        /* ignore rollback failure */
      }
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
