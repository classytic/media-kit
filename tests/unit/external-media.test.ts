/**
 * Unit tests — external (reference-only) media helpers + zod schema.
 *
 * Covers:
 *   - assertExternalUrl: absolute http(s) only; javascript:/data:/relative → 400
 *   - assertExternalOriginAllowed: allowlist matching + malformed entries fail closed
 *   - buildExternalKey: sentinel shape, deterministic, reserved namespace
 *   - isExternalMedia: provider-field discriminator
 *   - the sentinel key can NEVER pass assertGeneratedKeyShape (confirmUpload
 *     ownership guard) — external keys can't be claimed via presign confirm
 *   - registerExternalSchema zod bounds
 */

import { describe, it, expect } from 'vitest';
import type { HttpError } from '@classytic/repo-core/errors';
import {
  EXTERNAL_PROVIDER,
  EXTERNAL_KEY_PREFIX,
  isExternalMedia,
  buildExternalKey,
  externalUrlHash,
  assertExternalUrl,
  assertExternalOriginAllowed,
} from '../../src/utils/external';
import { assertGeneratedKeyShape } from '../../src/operations/helpers';
import { registerExternalSchema } from '../../src/validators/upload-input.schema';

const URL_OK = 'https://imagedelivery.net/acct/imgid/public';

function catchHttp(fn: () => unknown): HttpError {
  try {
    fn();
  } catch (err) {
    return err as HttpError;
  }
  throw new Error('expected function to throw');
}

describe('assertExternalUrl', () => {
  it('accepts absolute http and https URLs', () => {
    expect(assertExternalUrl(URL_OK).origin).toBe('https://imagedelivery.net');
    expect(assertExternalUrl('http://cdn.partner.example/a.png').protocol).toBe('http:');
  });

  it.each([
    'javascript:alert(1)',
    'data:image/png;base64,iVBORw0KGgo=',
    'file:///etc/passwd',
    'ftp://host/file.png',
    '/relative/path.png',
    'relative.png',
    '//protocol-relative.example/x.png',
    '',
  ])('rejects %j with 400 media.external.invalid_url', (raw) => {
    const err = catchHttp(() => assertExternalUrl(raw));
    expect(err.status).toBe(400);
    expect(err.code).toBe('media.external.invalid_url');
  });
});

describe('assertExternalOriginAllowed', () => {
  const url = new URL(URL_OK);

  it('no-ops when the allowlist is unset or empty', () => {
    expect(() => assertExternalOriginAllowed(url, undefined)).not.toThrow();
    expect(() => assertExternalOriginAllowed(url, [])).not.toThrow();
  });

  it('accepts a matching origin (path/trailing-slash tolerated in entries)', () => {
    expect(() => assertExternalOriginAllowed(url, ['https://imagedelivery.net'])).not.toThrow();
    expect(() => assertExternalOriginAllowed(url, ['https://imagedelivery.net/'])).not.toThrow();
    expect(() =>
      assertExternalOriginAllowed(url, ['https://other.example', 'https://imagedelivery.net/some/path']),
    ).not.toThrow();
  });

  it('rejects a non-listed origin with 403 media.external.origin_not_allowed', () => {
    const err = catchHttp(() => assertExternalOriginAllowed(url, ['https://cdn.other.example']));
    expect(err.status).toBe(403);
    expect(err.code).toBe('media.external.origin_not_allowed');
  });

  it('scheme and port are part of the origin (http entry does not allow https url)', () => {
    const err = catchHttp(() => assertExternalOriginAllowed(url, ['http://imagedelivery.net']));
    expect(err.code).toBe('media.external.origin_not_allowed');
  });

  it('a malformed allowlist entry never widens the allowlist (fail closed)', () => {
    const err = catchHttp(() => assertExternalOriginAllowed(url, ['not a url']));
    expect(err.code).toBe('media.external.origin_not_allowed');
  });
});

describe('buildExternalKey / externalUrlHash', () => {
  it('is deterministic and namespaced: __external__/<sha256-hex-16-of-url>', () => {
    const key = buildExternalKey(URL_OK);
    expect(key).toBe(`${EXTERNAL_KEY_PREFIX}${externalUrlHash(URL_OK).slice(0, 16)}`);
    expect(key).toMatch(/^__external__\/[0-9a-f]{16}$/);
    expect(buildExternalKey(URL_OK)).toBe(key);
    expect(buildExternalKey('https://elsewhere.example/x')).not.toBe(key);
  });

  it('can NEVER pass the presign confirm ownership guard (assertGeneratedKeyShape)', () => {
    const err = catchHttp(() => assertGeneratedKeyShape(buildExternalKey(URL_OK)));
    expect(err.status).toBe(400);
    expect(err.code).toBe('media.confirm.invalid_key');
  });
});

describe('isExternalMedia', () => {
  it('discriminates on the provider field only', () => {
    expect(isExternalMedia({ provider: EXTERNAL_PROVIDER })).toBe(true);
    expect(isExternalMedia({ provider: 's3' })).toBe(false);
    expect(isExternalMedia({ provider: undefined })).toBe(false);
    expect(isExternalMedia({})).toBe(false);
  });
});

describe('registerExternalSchema (zod)', () => {
  it('accepts a minimal input (url only)', () => {
    expect(registerExternalSchema.parse({ url: URL_OK })).toEqual({ url: URL_OK });
  });

  it('accepts the full input incl. client display hints', () => {
    const parsed = registerExternalSchema.parse({
      url: URL_OK,
      filename: 'hero.png',
      mimeType: 'image/png',
      size: 12345,
      folder: 'landing',
      visibility: 'private',
      tags: ['hero'],
      alt: 'Hero image',
      title: 'Hero',
      metadata: { campaign: 'q3' },
      sourceProvider: 'cloudflare-images',
      width: 1280,
      height: 960,
      thumbhash: '3OcRJYB4d3h/iIeHeEh3eIhw+j2w',
      dominantColor: '#8a6f4b',
    });
    expect(parsed.sourceProvider).toBe('cloudflare-images');
    expect(parsed.width).toBe(1280);
  });

  it.each([
    [{ url: 'javascript:alert(1)' }, 'non-http protocol'],
    [{ url: 'ftp://host/x.png' }, 'ftp protocol'],
    [{ url: '/relative.png' }, 'relative url'],
    [{ url: `https://x.example/${'a'.repeat(2050)}` }, 'url too long'],
    [{ url: URL_OK, size: -1 }, 'negative size'],
    [{ url: URL_OK, size: 1.5 }, 'non-integer size'],
    [{ url: URL_OK, width: 0 }, 'zero width'],
    [{ url: URL_OK, height: 70000 }, 'height above 65535'],
    [{ url: URL_OK, dominantColor: 'red' }, 'non-hex dominantColor'],
    [{ url: URL_OK, thumbhash: 'x'.repeat(200) }, 'thumbhash above 128 chars'],
    [{ url: URL_OK, sourceProvider: '' }, 'empty sourceProvider'],
    [{ url: URL_OK, visibility: 'internal' }, 'unknown visibility'],
    [{}, 'missing url'],
  ])('rejects %j (%s)', (input) => {
    expect(registerExternalSchema.safeParse(input).success).toBe(false);
  });
});
