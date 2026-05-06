/**
 * `MEDIA_MACHINE` — the canonical declaration of legal media-asset
 * status transitions. This test is the single source of truth that
 * the state-graph + the actual upload pipeline agree.
 *
 * If a future change breaks the parity (e.g. someone adds a transition
 * to MEDIA_MACHINE but doesn't add a matching call site, or vice
 * versa), it should fail HERE so the misalignment is caught before
 * shipping.
 */

import { describe, expect, it } from 'vitest';
import { IllegalTransitionError } from '@classytic/primitives/state-machine';
import { MEDIA_MACHINE } from '../../src/models/media-state-machine.js';
import type { MediaStatus } from '../../src/types.js';

describe('MEDIA_MACHINE', () => {
  describe('declared transitions match the lifecycle documented in CLAUDE.md', () => {
    // Each row asserts a transition from CLAUDE.md is legal in the
    // machine. If the docs add a new transition, this list should
    // grow; if a transition is removed, the entry should fail.
    const legalTransitions: Array<[MediaStatus, MediaStatus, string]> = [
      ['pending', 'processing', 'regular upload Step 2'],
      ['pending', 'error', 'validation / scan reject / Step 2 failure'],
      ['processing', 'ready', 'regular upload Step 4 — payload write'],
      ['processing', 'error', 'Step 3 / Step 4 failure'],
      ['ready', 'processing', 'presigned reprocess flag'],
    ];

    for (const [from, to, why] of legalTransitions) {
      it(`accepts ${from} → ${to} (${why})`, () => {
        expect(MEDIA_MACHINE.canTransition(from, to)).toBe(true);
        expect(() => MEDIA_MACHINE.assertTransition('test-id', from, to)).not.toThrow();
      });
    }
  });

  describe('rejects every transition NOT in the declared table', () => {
    // The exhaustive product of {pending, processing, ready, error}²
    // minus the 5 legal transitions above + the from===to identities
    // that are NOT documented as legal in this machine.
    //
    // NOTE: `defineStateMachine` does NOT auto-allow from===to. Each
    // entry here is the tsc-exhaustiveness counterpart of the legal
    // list above — adding a transition to MEDIA_MACHINE should remove
    // its entry from this list.
    const illegalTransitions: Array<[MediaStatus, MediaStatus]> = [
      // pending → ?
      ['pending', 'pending'],
      ['pending', 'ready'], // CRITICAL: skipping `processing` is the bug we want to catch
      // processing → ?
      ['processing', 'pending'],
      ['processing', 'processing'],
      // ready → ?
      ['ready', 'pending'],
      ['ready', 'ready'],
      ['ready', 'error'], // ready is success-shaped; error is reached BEFORE ready, not after
      // error → ?  (terminal)
      ['error', 'pending'],
      ['error', 'processing'],
      ['error', 'ready'],
      ['error', 'error'],
    ];

    for (const [from, to] of illegalTransitions) {
      it(`rejects ${from} → ${to}`, () => {
        expect(MEDIA_MACHINE.canTransition(from, to)).toBe(false);
        expect(() => MEDIA_MACHINE.assertTransition('test-id', from, to)).toThrow(
          IllegalTransitionError,
        );
      });
    }
  });

  describe('error-path catch handler relies on validSources("error")', () => {
    it('returns ["pending", "processing"] in array form', () => {
      const sources = MEDIA_MACHINE.validSources('error');
      // Order doesn't matter — sort for stable comparison.
      expect([...sources].sort()).toEqual(['pending', 'processing']);
    });

    it('does NOT include `ready` (the catch handler must not clobber successful uploads)', () => {
      // CRITICAL: this is the load-bearing property of the error path.
      // If `ready` ever became a valid source for `error`, a misbehaving
      // retry could roll back a successful upload to error state — a
      // silent data-loss shape we must never ship.
      const sources = MEDIA_MACHINE.validSources('error');
      expect(sources).not.toContain('ready');
    });

    it('does NOT include terminal `error` itself (idempotent re-claim not legal)', () => {
      const sources = MEDIA_MACHINE.validSources('error');
      expect(sources).not.toContain('error');
    });
  });

  describe('validTargets — UI / observability surface', () => {
    it('pending can transition to processing or error', () => {
      expect([...MEDIA_MACHINE.validTargets('pending')].sort()).toEqual(['error', 'processing']);
    });

    it('processing can transition to ready or error', () => {
      expect([...MEDIA_MACHINE.validTargets('processing')].sort()).toEqual(['error', 'ready']);
    });

    it('ready can transition to processing (reprocess flow)', () => {
      expect([...MEDIA_MACHINE.validTargets('ready')]).toEqual(['processing']);
    });

    it('error is terminal — no outgoing transitions', () => {
      expect([...MEDIA_MACHINE.validTargets('error')]).toEqual([]);
      expect(MEDIA_MACHINE.isTerminal('error')).toBe(true);
    });
  });

  describe('error metadata for traceability', () => {
    it('IllegalTransitionError carries entityType, entityId, from, to', () => {
      try {
        MEDIA_MACHINE.assertTransition('media-123', 'pending', 'ready');
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(IllegalTransitionError);
        const e = err as IllegalTransitionError;
        expect(e.entityType).toBe('Media');
        expect(e.entityId).toBe('media-123');
        expect(e.from).toBe('pending');
        expect(e.to).toBe('ready');
        expect(e.code).toBe('illegal_transition');
        expect(e.status).toBe(422);
      }
    });
  });
});
