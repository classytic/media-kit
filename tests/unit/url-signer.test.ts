/**
 * Unit tests — createUrlSigner (zero-dep HMAC URL signing).
 *
 * Covers: round-trip, tamper detection on every signed field, expiry,
 * keyring rotation, tokenVersion revocation, claim canonicalization,
 * and timingSafeEqual length-mismatch safety.
 */

import { describe, it, expect } from 'vitest';
import { createUrlSigner } from '../../src/signing/index.js';

/** Parse a signed query string the way a host framework would (decoded). */
function toParams(query: string): Record<string, string> {
  return Object.fromEntries(new URLSearchParams(query));
}

describe('createUrlSigner — construction', () => {
  it('throws without keys or secret', () => {
    expect(() => createUrlSigner({})).toThrow(/signing key is required/);
    expect(() => createUrlSigner({ keys: {} })).toThrow(/signing key is required/);
  });

  it('throws when both keys and secret are provided', () => {
    expect(() => createUrlSigner({ keys: { k1: 'a' }, secret: 'b' })).toThrow(/not both/);
  });

  it('throws on multi-key ring without currentKid', () => {
    expect(() => createUrlSigner({ keys: { k1: 'a', k2: 'b' } })).toThrow(/currentKid/);
  });

  it('throws when currentKid is not in the keyring', () => {
    expect(() => createUrlSigner({ keys: { k1: 'a' }, currentKid: 'k9' })).toThrow(/not in the keyring/);
  });

  it('throws on empty secret for a kid', () => {
    expect(() => createUrlSigner({ keys: { k1: '' } })).toThrow(/empty secret/);
  });

  it('single-secret convenience maps to kid k1', () => {
    const signer = createUrlSigner({ secret: 's3cret' });
    const { query } = signer.sign({ id: 'a1' });
    expect(toParams(query).kid).toBe('k1');
  });
});

describe('createUrlSigner — sign/verify round-trip', () => {
  const signer = createUrlSigner({ secret: 'test-secret', defaultTtl: 600 });

  it('round-trips a plain id', () => {
    const { query, expiresAt } = signer.sign({ id: 'abc123' });
    expect(expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
    expect(signer.verify({ id: 'abc123', params: toParams(query) })).toEqual({ ok: true });
  });

  it('round-trips id + variant + claims + tokenVersion', () => {
    const { query } = signer.sign({
      id: 'abc123',
      variant: 'thumbnail',
      claims: { uid: 'user_1', conv: 'c-42' },
      tokenVersion: 3,
    });
    const result = signer.verify({
      id: 'abc123',
      variant: 'thumbnail',
      params: toParams(query),
      expectedTokenVersion: 3,
    });
    expect(result).toEqual({ ok: true });
  });

  it('query has the documented shape: e, kid, v, c.*, sig', () => {
    const { query, expiresAt } = signer.sign({ id: 'x', claims: { b: '2', a: '1' } });
    const params = toParams(query);
    expect(params.e).toBe(String(expiresAt));
    expect(params.kid).toBe('k1');
    expect(params.v).toBe('0');
    expect(params['c.a']).toBe('1');
    expect(params['c.b']).toBe('2');
    expect(params.sig).toMatch(/^[A-Za-z0-9_-]+$/); // base64url
  });

  it('rejects a signature minted for a different id', () => {
    const { query } = signer.sign({ id: 'file-a' });
    expect(signer.verify({ id: 'file-b', params: toParams(query) })).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });

  it('rejects a signature minted for a different variant', () => {
    const { query } = signer.sign({ id: 'file-a', variant: 'thumbnail' });
    expect(signer.verify({ id: 'file-a', variant: 'large', params: toParams(query) })).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
    // ... and dropping the variant entirely also fails
    expect(signer.verify({ id: 'file-a', params: toParams(query) })).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });

  it('rejects a tampered expiry (e is signed)', () => {
    const { query } = signer.sign({ id: 'file-a', expiresIn: 60 });
    const params = toParams(query);
    params.e = String(Number(params.e) + 999999);
    expect(signer.verify({ id: 'file-a', params })).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('rejects a tampered tokenVersion (v is signed)', () => {
    const { query } = signer.sign({ id: 'file-a', tokenVersion: 1 });
    const params = toParams(query);
    params.v = '2';
    expect(signer.verify({ id: 'file-a', params, expectedTokenVersion: 2 })).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });

  it('rejects tampered claims (added, removed, or changed)', () => {
    const { query } = signer.sign({ id: 'file-a', claims: { uid: 'user_1' } });
    const base = toParams(query);

    const changed = { ...base, 'c.uid': 'user_2' };
    expect(signer.verify({ id: 'file-a', params: changed })).toEqual({ ok: false, reason: 'bad_signature' });

    const added = { ...base, 'c.extra': 'x' };
    expect(signer.verify({ id: 'file-a', params: added })).toEqual({ ok: false, reason: 'bad_signature' });

    const removed = { ...base };
    delete removed['c.uid'];
    expect(signer.verify({ id: 'file-a', params: removed })).toEqual({ ok: false, reason: 'bad_signature' });
  });
});

describe('createUrlSigner — expiry', () => {
  const signer = createUrlSigner({ secret: 'test-secret' });

  it('an authentic but expired signature fails with `expired`', () => {
    const { query, expiresAt } = signer.sign({ id: 'file-a', expiresIn: 10 });
    const result = signer.verify({ id: 'file-a', params: toParams(query), now: expiresAt + 1 });
    expect(result).toEqual({ ok: false, reason: 'expired' });
  });

  it('a signature valid at `now` verifies', () => {
    const { query, expiresAt } = signer.sign({ id: 'file-a', expiresIn: 10 });
    expect(signer.verify({ id: 'file-a', params: toParams(query), now: expiresAt })).toEqual({ ok: true });
  });

  it('sign() rejects non-positive expiresIn', () => {
    expect(() => signer.sign({ id: 'x', expiresIn: 0 })).toThrow(/positive/);
    expect(() => signer.sign({ id: 'x', expiresIn: -5 })).toThrow(/positive/);
  });
});

describe('createUrlSigner — keyring rotation', () => {
  it('URLs signed with an old key still verify while it stays in the ring', () => {
    const oldSigner = createUrlSigner({ keys: { k1: 'old-secret' }, currentKid: 'k1' });
    const oldUrl = oldSigner.sign({ id: 'file-a' });

    // Rotate: add k2, sign new URLs with it, keep k1 for N-1 verification.
    const rotated = createUrlSigner({ keys: { k1: 'old-secret', k2: 'new-secret' }, currentKid: 'k2' });
    const newUrl = rotated.sign({ id: 'file-a' });

    expect(toParams(newUrl.query).kid).toBe('k2');
    expect(rotated.verify({ id: 'file-a', params: toParams(newUrl.query) })).toEqual({ ok: true });
    expect(rotated.verify({ id: 'file-a', params: toParams(oldUrl.query) })).toEqual({ ok: true });
  });

  it('a kid absent from the ring fails with `unknown_kid`', () => {
    const signerA = createUrlSigner({ keys: { retired: 'gone-secret' }, currentKid: 'retired' });
    const { query } = signerA.sign({ id: 'file-a' });

    const signerB = createUrlSigner({ keys: { k2: 'new-secret' }, currentKid: 'k2' });
    expect(signerB.verify({ id: 'file-a', params: toParams(query) })).toEqual({
      ok: false,
      reason: 'unknown_kid',
    });
  });
});

describe('createUrlSigner — tokenVersion revocation', () => {
  const signer = createUrlSigner({ secret: 'test-secret' });

  it('mismatched expectedTokenVersion fails with `version_mismatch`', () => {
    const { query } = signer.sign({ id: 'file-a', tokenVersion: 0 });
    expect(signer.verify({ id: 'file-a', params: toParams(query), expectedTokenVersion: 1 })).toEqual({
      ok: false,
      reason: 'version_mismatch',
    });
  });

  it('omitting expectedTokenVersion skips the version check', () => {
    const { query } = signer.sign({ id: 'file-a', tokenVersion: 5 });
    expect(signer.verify({ id: 'file-a', params: toParams(query) })).toEqual({ ok: true });
  });
});

describe('createUrlSigner — canonicalization & robustness', () => {
  const signer = createUrlSigner({ secret: 'test-secret' });

  it('claim insertion order does not affect the signature', () => {
    // Sign with claims in two different insertion orders — same signature.
    const a = signer.sign({ id: 'x', expiresIn: 1000, claims: { alpha: '1', beta: '2', gamma: '3' } });
    const b = signer.sign({ id: 'x', expiresIn: 1000, claims: { gamma: '3', alpha: '1', beta: '2' } });
    expect(toParams(a.query).sig).toBe(toParams(b.query).sig);
  });

  it('claims containing delimiters cannot forge a canonical collision', () => {
    // '\n' and '=' inside keys/values are URI-encoded into the canonical
    // string, so these two claim sets must NOT produce the same signature.
    const a = signer.sign({ id: 'x', expiresIn: 1000, claims: { 'a\nb': 'c' } });
    const b = signer.sign({ id: 'x', expiresIn: 1000, claims: { a: 'b\nc' } });
    expect(toParams(a.query).sig).not.toBe(toParams(b.query).sig);
  });

  it('missing or non-integer e/v/kid/sig params fail with `malformed` (no throw)', () => {
    const { query } = signer.sign({ id: 'file-a' });
    const good = toParams(query);

    for (const key of ['e', 'kid', 'v', 'sig'] as const) {
      const params = { ...good };
      delete params[key];
      expect(signer.verify({ id: 'file-a', params })).toEqual({ ok: false, reason: 'malformed' });
    }
    expect(signer.verify({ id: 'file-a', params: { ...good, e: 'soon' } })).toEqual({
      ok: false,
      reason: 'malformed',
    });
    expect(signer.verify({ id: 'file-a', params: { ...good, v: '1.5' } })).toEqual({
      ok: false,
      reason: 'malformed',
    });
  });

  it('length-mismatched sig is bad_signature, not an exception (timingSafeEqual safety)', () => {
    const { query } = signer.sign({ id: 'file-a' });
    const params = toParams(query);

    expect(() => signer.verify({ id: 'file-a', params: { ...params, sig: 'AAAA' } })).not.toThrow();
    expect(signer.verify({ id: 'file-a', params: { ...params, sig: 'AAAA' } })).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
    expect(signer.verify({ id: 'file-a', params: { ...params, sig: '' } })).toEqual({
      ok: false,
      reason: 'malformed',
    });
  });

  it('unicode ids and claim values round-trip', () => {
    const { query } = signer.sign({ id: 'файл-1', claims: { note: 'köttbullar & fries' } });
    expect(signer.verify({ id: 'файл-1', params: toParams(query) })).toEqual({ ok: true });
    expect(signer.verify({ id: 'файл-2', params: toParams(query) })).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });
});
