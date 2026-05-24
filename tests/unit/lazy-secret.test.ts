/**
 * Lazy-secret resolver — unit tests for the provider credential primitive.
 *
 * Pinning:
 *   - String literals still validate eagerly (preserves "fail at boot" UX for
 *     misconfigured eager hosts) and resolve synchronously at first use.
 *   - Function form does NOT fire at construct time — defers to first resolve.
 *   - Resolver fires at most once across the provider's lifetime (memoized).
 *   - Concurrent first-resolve calls collapse to a single resolver invocation.
 *   - Empty resolved values throw at use time with the same error label the
 *     eager constructor would have thrown.
 *   - Sync and async resolver functions both supported.
 */

import { describe, expect, it, vi } from 'vitest';
import { LazySecret, validateSecretValue } from '../../src/utils/lazy-secret.js';

describe('validateSecretValue — construct-time validation', () => {
  it('accepts a non-empty string literal', () => {
    expect(() => validateSecretValue('abc123', 'Test: key')).not.toThrow();
  });

  it('rejects an empty string literal with the labelled error', () => {
    expect(() => validateSecretValue('', 'Test: key')).toThrow(/Test: key is required/);
  });

  it('rejects null/undefined', () => {
    expect(() => validateSecretValue(undefined, 'Test: key')).toThrow(/Test: key is required/);
    expect(() => validateSecretValue(null, 'Test: key')).toThrow(/Test: key is required/);
  });

  it('accepts a function resolver WITHOUT firing it', () => {
    const resolver = vi.fn(() => 'abc');
    expect(() => validateSecretValue(resolver, 'Test: key')).not.toThrow();
    expect(resolver).not.toHaveBeenCalled();
  });

  it('accepts an async function resolver WITHOUT firing it', () => {
    const resolver = vi.fn(async () => 'abc');
    expect(() => validateSecretValue(resolver, 'Test: key')).not.toThrow();
    expect(resolver).not.toHaveBeenCalled();
  });

  it('rejects a non-string non-function value', () => {
    expect(() => validateSecretValue(123 as unknown as string, 'Test: key')).toThrow(
      /must be a string or a/,
    );
  });
});

describe('LazySecret — string literal', () => {
  it('resolves synchronously via cached path', async () => {
    const s = new LazySecret('hello', 'Test: key');
    expect(s.isLiteral).toBe(true);
    expect(s.literalValue()).toBe('hello');
    await expect(s.resolve()).resolves.toBe('hello');
  });

  it('throws at resolve time on empty literal (bypass-validateSecretValue path)', async () => {
    const s = new LazySecret('', 'Test: key');
    await expect(s.resolve()).rejects.toThrow(/Test: key is required/);
  });
});

describe('LazySecret — function resolver', () => {
  it('does NOT fire the resolver at construct time', () => {
    const resolver = vi.fn(() => 'abc');
    new LazySecret(resolver, 'Test: key');
    expect(resolver).not.toHaveBeenCalled();
  });

  it('returns false for isLiteral / undefined for literalValue', () => {
    const s = new LazySecret(() => 'abc', 'Test: key');
    expect(s.isLiteral).toBe(false);
    expect(s.literalValue()).toBeUndefined();
  });

  it('fires the resolver on first resolve()', async () => {
    const resolver = vi.fn(() => 'abc');
    const s = new LazySecret(resolver, 'Test: key');
    await expect(s.resolve()).resolves.toBe('abc');
    expect(resolver).toHaveBeenCalledTimes(1);
  });

  it('memoizes across subsequent resolve() calls (resolver fires once)', async () => {
    const resolver = vi.fn(() => 'abc');
    const s = new LazySecret(resolver, 'Test: key');
    await s.resolve();
    await s.resolve();
    await s.resolve();
    expect(resolver).toHaveBeenCalledTimes(1);
  });

  it('supports async resolvers', async () => {
    const resolver = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 10));
      return 'async-key';
    });
    const s = new LazySecret(resolver, 'Test: key');
    await expect(s.resolve()).resolves.toBe('async-key');
    expect(resolver).toHaveBeenCalledTimes(1);
  });

  it('collapses concurrent first-resolve calls to a SINGLE resolver invocation', async () => {
    let pending: ((v: string) => void) | null = null;
    const resolver = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          pending = resolve;
        }),
    );
    const s = new LazySecret(resolver, 'Test: key');
    // Fire 5 concurrent resolves BEFORE the resolver returns.
    const promises = [s.resolve(), s.resolve(), s.resolve(), s.resolve(), s.resolve()];
    // Resolver was invoked exactly ONCE.
    expect(resolver).toHaveBeenCalledTimes(1);
    // Now release the inflight resolver.
    pending!('shared-key');
    await expect(Promise.all(promises)).resolves.toEqual([
      'shared-key',
      'shared-key',
      'shared-key',
      'shared-key',
      'shared-key',
    ]);
  });

  it('throws with the labelled error when the resolver returns empty', async () => {
    const s = new LazySecret(() => '', 'Test: key');
    await expect(s.resolve()).rejects.toThrow(/Test: key resolver returned an empty value/);
  });

  it('throws with the labelled error when the resolver returns null', async () => {
    const s = new LazySecret(() => null as unknown as string, 'Test: key');
    await expect(s.resolve()).rejects.toThrow(/Test: key resolver returned an empty value/);
  });

  it('propagates resolver errors and lets the next call retry', async () => {
    let attempt = 0;
    const resolver = vi.fn(async () => {
      attempt += 1;
      if (attempt === 1) throw new Error('secret-manager-unavailable');
      return 'eventual-key';
    });
    const s = new LazySecret(resolver, 'Test: key');
    await expect(s.resolve()).rejects.toThrow(/secret-manager-unavailable/);
    // Retry works because we never cached the failed attempt.
    await expect(s.resolve()).resolves.toBe('eventual-key');
    expect(resolver).toHaveBeenCalledTimes(2);
  });
});
