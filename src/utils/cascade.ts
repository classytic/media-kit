/**
 * `withMediaCascade(schema, options)` — owner-doc cascade-delete helper.
 *
 * Wires up `findOneAndDelete` + `deleteOne` + `deleteMany` (query AND document
 * forms) hooks on the OWNER schema so that, when an owner doc is removed, the
 * media documents referenced by the configured fields are also `hardDelete`'d
 * via the engine's `MediaRepository`.
 *
 * Before this helper, every host resource that owned media docs
 * (voice-clip, caption-track, shot, image-post, video-job, etc.) hand-rolled
 * the same `pre/post('findOneAndDelete')` block + `repository.hardDelete(...)`
 * loop. The helper dedupes that into a single declarative call:
 *
 * @example
 * ```ts
 * import { Schema } from 'mongoose';
 * import { withMediaCascade } from '@classytic/media-kit';
 *
 * const VoiceClipSchema = new Schema({
 *   text: String,
 *   audioMediaId:   { type: Schema.Types.ObjectId, ref: 'media' },
 *   captionsMediaId:{ type: Schema.Types.ObjectId, ref: 'media' },
 * });
 *
 * withMediaCascade(VoiceClipSchema, {
 *   repository: mediaEngine.repositories.media,
 *   fields: ['audioMediaId', 'captionsMediaId'],
 *   context: (doc) => ({ organizationId: doc.organizationId }),
 * });
 * ```
 *
 * Cascade timing: POST hooks. The owner delete completes first; media cleanup
 * follows. If the owner delete fails, media is untouched (no half-deletes).
 * If the cascade fails AFTER owner deletion, the owner is gone but media may
 * remain orphaned — `onError: 'log'` (default) keeps the owner delete the
 * source of truth; `onError: 'throw'` propagates the cascade failure to the
 * caller (still post-owner-delete; use for caller-visible reporting only).
 */

import type { Schema } from 'mongoose';
import type { MediaContext } from '../engine/engine-types.js';
import type { MediaRepository } from '../repositories/media.repository.js';

// ============================================================================
// Public types
// ============================================================================

export interface MediaCascadeOptions {
  /**
   * The engine's media repository (typically `engine.repositories.media`).
   * Used to call `hardDelete(id, ctx)` for each cascaded media doc.
   */
  readonly repository: Pick<MediaRepository, 'hardDelete'>;

  /**
   * Owner-doc field names that hold media `_id` references.
   * Each field may store a single id, an array of ids, or `null`/`undefined`.
   * Missing or empty values are skipped silently — the helper only cascades
   * what's actually referenced.
   *
   * @example fields: ['audioMediaId', 'captionsMediaId', 'gallery']
   */
  readonly fields: readonly string[];

  /**
   * Resolve a `MediaContext` from the doc being deleted. Threaded through to
   * `repository.hardDelete(id, ctx)` so tenant-scoped engines apply tenant
   * filters on the cascade. Defaults to `undefined` (no context — equivalent
   * to "called from the engine's tenant-less internals").
   */
  readonly context?: (doc: Record<string, unknown>) => MediaContext | undefined;

  /**
   * What to do when a single cascaded `hardDelete` throws.
   * - `'log'` (default, secure-by-orphan): log the failure and keep going.
   *   The owner doc stays deleted; media may be orphaned.
   * - `'throw'`: rethrow the first cascade error. The owner is already
   *   deleted at this point (we use post hooks) — use this only for
   *   caller-visible reporting, not transactional integrity.
   */
  readonly onError?: 'log' | 'throw';

  /**
   * Optional logger for `onError: 'log'`. Falls back to `console.warn` so
   * media-kit doesn't take a hard dependency on a logger; hosts can inject
   * their own (`fastify.log`, `pino`, etc.).
   */
  readonly logger?: { warn?: (msg: string, meta?: unknown) => void };
}

// ============================================================================
// Internal helpers
// ============================================================================

/**
 * Extract all media `_id` references from a doc across the configured fields.
 * Handles single-id, array-of-ids, ObjectId, and string forms uniformly.
 */
function collectMediaIds(doc: Record<string, unknown>, fields: readonly string[]): string[] {
  const ids: string[] = [];
  for (const field of fields) {
    const value = doc[field];
    if (value == null) continue;
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item != null) ids.push(String(item));
      }
    } else {
      ids.push(String(value));
    }
  }
  return ids;
}

/**
 * Fire `repository.hardDelete` for every media id referenced by `doc`.
 * Errors are routed through `options.onError`.
 */
async function cascadeForDoc(doc: Record<string, unknown>, options: MediaCascadeOptions): Promise<void> {
  const ids = collectMediaIds(doc, options.fields);
  if (ids.length === 0) return;

  const ctx = options.context?.(doc);
  const onError = options.onError ?? 'log';
  const logger = options.logger ?? { warn: (msg, meta) => console.warn(msg, meta) };

  for (const id of ids) {
    try {
      await options.repository.hardDelete(id, ctx);
    } catch (err) {
      if (onError === 'throw') throw err;
      logger.warn?.('[media-kit/cascade] Failed to hardDelete media during owner cascade', {
        mediaId: id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

// Stash key on the mongoose Query object — survives between pre + post hooks.
// Prefixed with `_mediaCascade` so it can't collide with mongoose internals or
// a host's own stash keys.
const STASH_KEY = '_mediaCascadeDocs';

// ============================================================================
// Public API
// ============================================================================

/**
 * Attach media-cascade hooks to an owner schema. Idempotent: calling twice
 * with the same `fields` set just registers the hooks twice, which is
 * essentially harmless (the second cascade finds zero matches because the
 * media was already deleted by the first) but wastes a Redis round-trip per
 * owner-delete. Call this ONCE per schema.
 */
export function withMediaCascade(schema: Schema, options: MediaCascadeOptions): void {
  if (!options.fields || options.fields.length === 0) {
    throw new Error('[media-kit/cascade] `withMediaCascade` requires at least one field name in `options.fields`.');
  }
  if (!options.repository || typeof options.repository.hardDelete !== 'function') {
    throw new Error(
      '[media-kit/cascade] `withMediaCascade` requires `options.repository.hardDelete` — pass `engine.repositories.media`.',
    );
  }

  // ── findOneAndDelete (query middleware) ──
  // The post hook receives the deleted doc directly as the first arg; no
  // pre-stash needed.
  schema.post('findOneAndDelete', async (doc) => {
    if (doc) await cascadeForDoc(doc as Record<string, unknown>, options);
  });

  // ── deleteOne — query middleware ──
  // `Model.deleteOne({...})` doesn't surface the doc, so we capture it in
  // the pre hook and read it back in the post hook.
  schema.pre('deleteOne', { document: false, query: true }, async function () {
    const filter = (this as unknown as { getFilter: () => unknown }).getFilter();
    const Model = (this as unknown as { model: { findOne: (f: unknown) => { lean: () => Promise<unknown> } } }).model;
    const found = await Model.findOne(filter).lean();
    (this as unknown as Record<string, unknown>)[STASH_KEY] = found ? [found] : [];
  });
  schema.post('deleteOne', { document: false, query: true }, async function () {
    const docs = (this as unknown as Record<string, unknown>)[STASH_KEY] as Record<string, unknown>[] | undefined;
    if (!docs) return;
    for (const doc of docs) await cascadeForDoc(doc, options);
  });

  // ── deleteOne — document middleware (doc.deleteOne()) ──
  schema.post('deleteOne', { document: true, query: false }, async function () {
    await cascadeForDoc(this as unknown as Record<string, unknown>, options);
  });

  // ── deleteMany (query middleware only) ──
  schema.pre('deleteMany', async function () {
    const filter = (this as unknown as { getFilter: () => unknown }).getFilter();
    const Model = (this as unknown as { model: { find: (f: unknown) => { lean: () => Promise<unknown[]> } } }).model;
    const found = await Model.find(filter).lean();
    (this as unknown as Record<string, unknown>)[STASH_KEY] = Array.isArray(found) ? found : [];
  });
  schema.post('deleteMany', async function () {
    const docs = (this as unknown as Record<string, unknown>)[STASH_KEY] as Record<string, unknown>[] | undefined;
    if (!docs) return;
    for (const doc of docs) await cascadeForDoc(doc, options);
  });
}
