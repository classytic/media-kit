/**
 * The retired tenant keys are REFUSED, not absorbed.
 *
 * `defineMedia` resolves tenancy from `shape.tenant`, so a leftover
 * `multiTenant` / `tenantFieldType` is invisible to it and scoping falls back to
 * the package default instead of what the host asked for — nothing throws, and
 * every read afterwards returns plausible rows from the wrong scope.
 *
 * TypeScript is not the gate: excess-property checking does not fire for a typed
 * variable, a spread, or a shape handed over from a dependency's dist.
 */
import { describe, expect, it } from 'vitest';
import { defineMedia } from '../../src/engine/define-media.js';

/** Compose the way a host does — typed, so no excess-property check fires. */
const shape = (extra: Record<string, unknown>) => extra as never;

describe('media-kit: legacy tenant keys are refused', () => {
  it('REFUSES `multiTenant`', () => {
    expect(() => defineMedia(shape({ multiTenant: { tenantField: 'business' } }))).toThrow(
      /`multiTenant` was renamed/,
    );
  });

  it('REFUSES `multiTenant: false` — a benign spelling of the old key is still the old key', () => {
    expect(() => defineMedia(shape({ multiTenant: false }))).toThrow(/renamed/);
  });

  it('REFUSES `tenantFieldType`', () => {
    expect(() => defineMedia(shape({ tenantFieldType: 'objectId' }))).toThrow(/tenantFieldType/);
  });

  it('states the CONSEQUENCE, not just that a rename happened', () => {
    let message = '';
    try {
      defineMedia(shape({ multiTenant: true }));
    } catch (err) {
      message = String(err);
    }
    expect(message).toMatch(/silently/i);
  });
});
