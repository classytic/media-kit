/**
 * Client-produced derivatives — key derivation and the admission guard.
 *
 * The interesting half is NOT that a thumbnail gets registered; it is that a
 * client cannot register a key this server never signed. A variant row holds a
 * storage KEY, which is a pointer — accepting an arbitrary one would bind an
 * unrelated (possibly another tenant's) object into this record, and the media
 * grid would then happily render it.
 */

import { describe, expect, it } from 'vitest';
import {
  assertDerivativeKey,
  derivativeKey,
  sanitizeDerivativeName,
  toStoredVariants,
} from '../../src/operations/derivatives';

const PRIMARY = 'eternal/products/2026/abc123.avif';

/** Minimal deps — only the driver's public-URL derivation is exercised. */
/**
 * `stat` is part of the fake because admission now VERIFIES the object exists —
 * a signed key proves the client was allowed to write there, not that it did.
 */
const makeDeps = (opts: { missing?: string[]; storageMime?: string; storageSize?: number } = {}) =>
  ({
    driver: {
      getPublicUrl: (key: string) => `https://cdn.example.com/${key}`,
      stat: async (key: string) => {
        if (opts.missing?.includes(key)) throw new Error('NoSuchKey');
        return { size: opts.storageSize ?? 4_000, contentType: opts.storageMime ?? 'image/avif' };
      },
    },
  }) as unknown as Parameters<typeof toStoredVariants>[0];

const deps = makeDeps();

describe('derivativeKey', () => {
  it('places the derivative beside the primary, named by variant', () => {
    expect(derivativeKey(PRIMARY, 'thumbnail', 'avif')).toBe(
      'eternal/products/2026/abc123__thumbnail.avif',
    );
  });

  it('uses the DERIVATIVE format, which may differ from the primary', () => {
    expect(derivativeKey(PRIMARY, 'thumbnail', 'jpg')).toBe(
      'eternal/products/2026/abc123__thumbnail.jpg',
    );
  });

  it('is deterministic — the server can recompute it instead of trusting the client', () => {
    expect(derivativeKey(PRIMARY, 'medium', 'avif')).toBe(derivativeKey(PRIMARY, 'medium', 'avif'));
  });

  it('handles a key with no extension', () => {
    expect(derivativeKey('folder/file', 'thumbnail', 'avif')).toBe('folder/file__thumbnail.avif');
  });

  it('does not mistake a dot in a DIRECTORY for the extension', () => {
    expect(derivativeKey('a.b/c/file.avif', 'thumbnail', 'avif')).toBe(
      'a.b/c/file__thumbnail.avif',
    );
  });
});

describe('sanitizeDerivativeName', () => {
  it('normalises case and trims', () => {
    expect(sanitizeDerivativeName('  ThumbNail ')).toBe('thumbnail');
  });

  /** A name becomes part of an object key, so `/` and `..` are how it becomes a traversal. */
  it('strips path characters rather than letting them reach the key', () => {
    expect(sanitizeDerivativeName('../../etc/passwd')).toBe('etcpasswd');
    expect(sanitizeDerivativeName('a/b')).toBe('ab');
  });

  it('THROWS when nothing usable survives, rather than producing an empty segment', () => {
    expect(() => sanitizeDerivativeName('///')).toThrow(/no usable characters/);
    expect(() => sanitizeDerivativeName('  ')).toThrow(/no usable characters/);
  });
});

describe('assertDerivativeKey — the admission guard', () => {
  const good = {
    name: 'thumbnail',
    key: 'eternal/products/2026/abc123__thumbnail.avif',
    mimeType: 'image/avif',
    size: 4_000,
  };

  it('accepts the key this server would have issued', () => {
    expect(() => assertDerivativeKey(PRIMARY, good)).not.toThrow();
  });

  it('REFUSES a key pointing somewhere else entirely', () => {
    expect(() =>
      assertDerivativeKey(PRIMARY, { ...good, key: 'other-tenant/secret/photo.avif' }),
    ).toThrow(/did not sign/);
  });

  it('REFUSES a key whose extension disagrees with the declared mime', () => {
    expect(() => assertDerivativeKey(PRIMARY, { ...good, mimeType: 'image/webp' })).toThrow(
      /did not sign/,
    );
  });

  it('REFUSES a variant renamed to claim another slot', () => {
    expect(() => assertDerivativeKey(PRIMARY, { ...good, name: 'medium' })).toThrow(/did not sign/);
  });

  it('REFUSES an unsupported derivative format outright', () => {
    expect(() =>
      assertDerivativeKey(PRIMARY, { ...good, mimeType: 'application/zip', key: 'x' }),
    ).toThrow(/not a supported derivative format/);
  });
});

describe('toStoredVariants', () => {
  const variants = [
    {
      name: 'thumbnail',
      key: 'eternal/products/2026/abc123__thumbnail.avif',
      mimeType: 'image/avif',
      size: 4_000,
      width: 200,
      height: 150,
    },
    {
      name: 'medium',
      key: 'eternal/products/2026/abc123__medium.avif',
      mimeType: 'image/avif',
      size: 40_000,
      width: 800,
      height: 600,
    },
  ];

  it('builds rows whose URL comes from the DRIVER, not the payload', async () => {
    const rows = await toStoredVariants(deps, PRIMARY, variants);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.url).toBe('https://cdn.example.com/eternal/products/2026/abc123__thumbnail.avif');
    expect(rows[0]?.filename).toBe('abc123__thumbnail.avif');
    expect(rows[1]).toMatchObject({ name: 'medium', width: 800, height: 600 });
  });

  /**
   * One bad row fails the whole confirm. Dropping it instead would store a
   * record that is indistinguishable from a client that produced no variants —
   * so the forgery attempt would look exactly like an old browser.
   */
  it('THROWS on any unsigned key rather than dropping that row', async () => {
    await expect(
      toStoredVariants(deps, PRIMARY, [variants[0]!, { ...variants[1]!, key: 'elsewhere/x.avif' }]),
    ).rejects.toThrow(/did not sign/);
  });

  it('REFUSES duplicate variant names', async () => {
    await expect(toStoredVariants(deps, PRIMARY, [variants[0]!, variants[0]!])).rejects.toThrow(
      /duplicate variant name/,
    );
  });

  it('omits width/height when the client did not report them', async () => {
    const rows = await toStoredVariants(deps, PRIMARY, [
      { name: 'thumbnail', key: variants[0]!.key, mimeType: 'image/avif', size: 10 },
    ]);
    expect(rows[0]).not.toHaveProperty('width');
  });

  it('an empty list is an empty list, not an error', async () => {
    await expect(toStoredVariants(deps, PRIMARY, [])).resolves.toEqual([]);
  });

  /**
   * A signed key proves the client was ALLOWED to write there — not that it
   * did. A skipped or failed derivative PUT would otherwise produce a `ready`
   * record whose variant URL 404s forever, and only a browser fetching it ever
   * finds out.
   */
  it('REFUSES a variant whose object is not actually in storage', async () => {
    const d = makeDeps({ missing: [variants[1]!.key] });
    await expect(toStoredVariants(d, PRIMARY, variants)).rejects.toThrow(/no object exists/);
  });

  it('takes size and mime from STORAGE, not from the claim', async () => {
    const d = makeDeps({ storageSize: 1234, storageMime: 'image/avif' });
    const rows = await toStoredVariants(d, PRIMARY, [
      { ...variants[0]!, size: 999_999 },
    ]);
    expect(rows[0]?.size).toBe(1234);
  });
});

/**
 * STATUS is part of the refusal, not decoration.
 *
 * These all threw bare `Error`s, which arc maps to `arc.internal_error` (500) —
 * so a client sending a key the server never signed read as a SERVER fault. It
 * pages an on-call for the guard working exactly as designed, and it tells the
 * caller nothing about what to fix. Proven live: the forgery probe returned 500
 * before this.
 */
describe('refusals carry a CLIENT status, not 500', () => {
  const status = (fn: () => unknown): number | undefined => {
    try {
      fn();
    } catch (e) {
      return (e as { status?: number }).status;
    }
    return undefined;
  };

  it('an unsigned variant key is 422', () => {
    expect(
      status(() =>
        assertDerivativeKey(PRIMARY, {
          name: 'thumbnail',
          key: 'elsewhere/x.avif',
          mimeType: 'image/avif',
          size: 1,
        }),
      ),
    ).toBe(422);
  });

  it('an unsupported derivative format is 400', () => {
    expect(
      status(() =>
        assertDerivativeKey(PRIMARY, {
          name: 'thumbnail',
          key: 'x',
          mimeType: 'application/zip',
          size: 1,
        }),
      ),
    ).toBe(400);
  });

  it('an unusable variant name is 400', () => {
    expect(status(() => sanitizeDerivativeName('///'))).toBe(400);
  });
});
