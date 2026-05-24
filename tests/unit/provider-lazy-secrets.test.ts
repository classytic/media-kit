/**
 * Provider lazy-secret integration — boot-time construct without keys.
 *
 * Pins the partner-reported pattern:
 *   - Spawn boots a media engine for ALL routes but only `/uploads/*` paths
 *     actually call the upload pipeline. Pre-fix, the provider constructor
 *     forced an eager `apiKey` / `apiSecret` / `privateKey` even though no
 *     upload was happening — spawn boot crashed until shajghor's key was
 *     copied in.
 *   - Post-fix, the resolver form (`() => string | Promise<string>`) defers
 *     credential resolution to the first upload. Spawn can construct the
 *     provider with a resolver that fetches from a secret manager only when
 *     an upload actually fires.
 *
 * These tests prove the constructor does NOT touch the resolver and do NOT
 * hit the provider network — they exercise the construct + boot path only.
 * Actual HTTP behaviour with a resolved secret is covered by the existing
 * integration / e2e tests.
 */

import { describe, expect, it, vi } from 'vitest';
import { ImgbbProvider } from '../../src/providers/imgbb.provider.js';
import { CloudinaryProvider } from '../../src/providers/cloudinary.provider.js';
import { ImageKitProvider } from '../../src/providers/imagekit.provider.js';

// ── ImgbbProvider ────────────────────────────────────────────────────────────

describe('ImgbbProvider — lazy apiKey', () => {
  it('constructs without firing a function resolver', () => {
    const resolver = vi.fn(() => 'key-from-secret-manager');
    new ImgbbProvider({ apiKey: resolver });
    expect(resolver).not.toHaveBeenCalled();
  });

  it('constructs with an async resolver that never runs at boot', () => {
    const resolver = vi.fn(async () => 'key-from-secret-manager');
    new ImgbbProvider({ apiKey: resolver });
    expect(resolver).not.toHaveBeenCalled();
  });

  it('still throws at construct time on a missing apiKey (eager-string contract preserved)', () => {
    expect(() => new ImgbbProvider({ apiKey: '' })).toThrow(/ImgbbProvider: apiKey is required/);
    expect(
      () => new ImgbbProvider({ apiKey: undefined as unknown as string }),
    ).toThrow(/ImgbbProvider: apiKey is required/);
  });

  it('still throws at construct time on null', () => {
    expect(
      () => new ImgbbProvider({ apiKey: null as unknown as string }),
    ).toThrow(/ImgbbProvider: apiKey is required/);
  });
});

// ── CloudinaryProvider ───────────────────────────────────────────────────────

describe('CloudinaryProvider — lazy apiKey + apiSecret', () => {
  it('constructs without firing either resolver', () => {
    const keyResolver = vi.fn(() => 'k');
    const secretResolver = vi.fn(async () => 's');
    new CloudinaryProvider({
      cloudName: 'my-cloud',
      apiKey: keyResolver,
      apiSecret: secretResolver,
    });
    expect(keyResolver).not.toHaveBeenCalled();
    expect(secretResolver).not.toHaveBeenCalled();
  });

  it('still throws at construct time on missing apiKey', () => {
    expect(
      () =>
        new CloudinaryProvider({
          cloudName: 'my-cloud',
          apiKey: '',
          apiSecret: 's',
        }),
    ).toThrow(/CloudinaryProvider: apiKey is required/);
  });

  it('still throws at construct time on missing apiSecret', () => {
    expect(
      () =>
        new CloudinaryProvider({
          cloudName: 'my-cloud',
          apiKey: 'k',
          apiSecret: '',
        }),
    ).toThrow(/CloudinaryProvider: apiSecret is required/);
  });

  it('still throws on missing cloudName (eager — used in synchronous getPublicUrl)', () => {
    expect(
      () =>
        new CloudinaryProvider({
          cloudName: '',
          apiKey: 'k',
          apiSecret: 's',
        }),
    ).toThrow(/CloudinaryProvider: cloudName is required/);
  });

  it('mixes literal + resolver freely', () => {
    const resolver = vi.fn(async () => 'lazy-secret');
    new CloudinaryProvider({
      cloudName: 'my-cloud',
      apiKey: 'eager-key', // literal
      apiSecret: resolver, // lazy
    });
    expect(resolver).not.toHaveBeenCalled();
  });
});

// ── ImageKitProvider ─────────────────────────────────────────────────────────

describe('ImageKitProvider — lazy privateKey', () => {
  it('constructs without firing the resolver', () => {
    const resolver = vi.fn(() => 'pk-from-vault');
    new ImageKitProvider({
      publicKey: 'pub_xxx',
      privateKey: resolver,
      urlEndpoint: 'https://ik.imagekit.io/test',
    });
    expect(resolver).not.toHaveBeenCalled();
  });

  it('still throws at construct time on missing privateKey', () => {
    expect(
      () =>
        new ImageKitProvider({
          publicKey: 'pub',
          privateKey: '',
          urlEndpoint: 'https://ik.imagekit.io/test',
        }),
    ).toThrow(/ImageKitProvider: privateKey is required/);
  });

  it('still throws on missing urlEndpoint (eager — used in synchronous getPublicUrl)', () => {
    expect(
      () =>
        new ImageKitProvider({
          publicKey: 'pub',
          privateKey: 'priv',
          urlEndpoint: '',
        }),
    ).toThrow(/ImageKitProvider: urlEndpoint is required/);
  });
});

// ── End-to-end: resolver IS invoked when the upload path fires ──────────────

describe('Provider lazy resolution — invoked on first upload', () => {
  it('ImgbbProvider calls the resolver on first write() attempt', async () => {
    const resolver = vi.fn(() => 'test-key');
    const provider = new ImgbbProvider({ apiKey: resolver });

    // Stub fetch — return a minimal failure response so we don't actually
    // hit imgbb.com. We only care that the resolver fired BEFORE the fetch
    // request body was built.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ success: false, error: { message: 'stub' } }), {
          status: 200,
        }),
      ),
    );

    try {
      await provider.write('a.png', Buffer.from('x'), 'image/png').catch(() => null);
    } finally {
      vi.unstubAllGlobals();
    }

    expect(resolver).toHaveBeenCalledTimes(1);
  });

  it('ImgbbProvider memoizes — resolver fires once across N uploads', async () => {
    const resolver = vi.fn(() => 'shared-key');
    const provider = new ImgbbProvider({ apiKey: resolver });

    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ success: false, error: { message: 'stub' } }), {
          status: 200,
        }),
      ),
    );

    try {
      await provider.write('a.png', Buffer.from('1'), 'image/png').catch(() => null);
      await provider.write('b.png', Buffer.from('2'), 'image/png').catch(() => null);
      await provider.write('c.png', Buffer.from('3'), 'image/png').catch(() => null);
    } finally {
      vi.unstubAllGlobals();
    }

    expect(resolver).toHaveBeenCalledTimes(1);
  });

  it('Empty resolver result throws on first use (deferred validation)', async () => {
    const resolver = vi.fn(() => '');
    const provider = new ImgbbProvider({ apiKey: resolver });

    // No fetch spy needed — the resolver throws before the request is built.
    await expect(provider.write('a.png', Buffer.from('x'), 'image/png')).rejects.toThrow(
      /ImgbbProvider: apiKey resolver returned an empty value/,
    );
  });
});
