/**
 * Media-asset state machine — the canonical declaration of legal
 * status transitions during the upload + processing lifecycle.
 *
 * Replaces the implicit transition graph that previously lived
 * scattered across [upload.ts](../operations/upload.ts), [presigned.ts](../operations/presigned.ts),
 * and [media.repository.ts](../repositories/media.repository.ts) — each call site invoking
 * `claim()` with hard-coded `{ from, to }` literals. Centralising the
 * graph here:
 *
 *   - Locks the legal-transition table in one place. Adding a state
 *     (`'archived'`, `'review'`, …) is a single-line edit; tsc errors
 *     surface every stale call site.
 *   - Surfaces malformed transitions BEFORE the database round-trip.
 *     `assertAndClaim(MEDIA_MACHINE, ...)` throws `IllegalTransitionError`
 *     synchronously when a developer skips a state (e.g. `pending →
 *     ready`) — currently that just races and produces a confusing
 *     `null`.
 *   - Exposes `validSources(to)` for the multi-source error-path catch
 *     block (replaces the hand-rolled `status: { $in: ['pending',
 *     'processing'] }` literal in the catch handler).
 *
 * **Lifecycle states** — see [CLAUDE.md](../../CLAUDE.md#upload-status-lifecycle):
 *
 * - `pending`    — DB record created, file not yet in storage.
 * - `processing` — file uploaded to storage, image processing in flight.
 * - `ready`      — terminal-shaped (but reachable from `processing`
 *                  again via the post-confirm reprocess path on
 *                  presigned uploads).
 * - `error`      — terminal. Set when any step in the upload pipeline
 *                  throws OR a scan bridge returned `'quarantine'`
 *                  (with `errorMessage: 'Quarantined: <reason>'` —
 *                  quarantine is NOT a separate state per
 *                  [media-kit.types#MediaStatus](../types.ts), it's an
 *                  `error` variant identified by the message prefix).
 *
 * **Transitions:**
 *
 *   pending ──→ processing (regular upload Step 2)
 *   pending ──→ error      (validation / scan reject / Step 2 failure)
 *   processing ──→ ready   (regular upload Step 4 — payload write)
 *   processing ──→ error   (Step 3 / Step 4 failure)
 *   ready ──→ processing   (presigned `confirmUpload` / multipart
 *                           `completeMultipartUpload` post-upload
 *                           reprocessing flag)
 */

import { defineStateMachine } from '@classytic/primitives/state-machine';
import type { MediaStatus } from '../types.js';

export const MEDIA_MACHINE = defineStateMachine<MediaStatus>({
  name: 'Media',
  transitions: {
    pending: ['processing', 'error'],
    processing: ['ready', 'error'],
    ready: ['processing'], // post-confirm reprocess on presigned uploads
    error: [],
  },
});
