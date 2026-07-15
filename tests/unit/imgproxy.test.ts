/**
 * imgproxy URL builder — signature correctness (independent HMAC in the
 * test), option serialization, insecure mode, and the CdnBridge adapter's
 * signed-URL passthrough.
 */

import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createImgproxyUrlBuilder } from '../../src/transforms/index';

const KEY = '736563726574'; // "secret" hex-encoded
const SALT = '68656c6c6f'; // "hello" hex-encoded

/** Independent implementation of imgproxy's documented signature. */
function expectedSignature(path: string): string {
  return createHmac('sha256', Buffer.from(KEY, 'hex'))
    .update(Buffer.concat([Buffer.from(SALT, 'hex'), Buffer.from(path)]))
    .digest('base64url');
}

describe('createImgproxyUrlBuilder', () => {
  it('builds a signed URL: /{sig}/{options}/{base64url-source}.{format}', () => {
    const imgproxy = createImgproxyUrlBuilder({ endpoint: 'https://img.test/', key: KEY, salt: SALT });
    const source = 'https://cdn.example.com/uploads/cat photo.jpg?v=2';
    const url = imgproxy.buildUrl(source, { width: 640, height: 480, quality: 80, format: 'webp' });

    const encoded = Buffer.from(source).toString('base64url');
    const path = `/rs:fit:640:480/q:80/${encoded}.webp`;
    expect(url).toBe(`https://img.test/${expectedSignature(path)}${path}`);
  });

  it('serializes resizing type, dpr, and raw extra options in order', () => {
    const imgproxy = createImgproxyUrlBuilder({ endpoint: 'https://img.test' });
    const url = imgproxy.buildUrl('https://x.test/a.png', {
      width: 100,
      resizingType: 'fill',
      dpr: 2,
      extra: ['blur:5'],
    });
    expect(url).toContain('/rs:fill:100:0/dpr:2/blur:5/');
    expect(url.startsWith('https://img.test/insecure/')).toBe(true); // no key → insecure mode
  });

  it('rejects a key without a salt, and non-hex material', () => {
    expect(() => createImgproxyUrlBuilder({ endpoint: 'https://i.test', key: KEY })).toThrow(/BOTH key and salt/);
    expect(() => createImgproxyUrlBuilder({ endpoint: 'https://i.test', key: 'zz', salt: SALT })).toThrow(/hex/);
  });

  it('asCdnBridge rewrites public URLs but passes signed requests through untouched', async () => {
    const bridge = createImgproxyUrlBuilder({ endpoint: 'https://img.test' }).asCdnBridge({ format: 'webp' });

    const pub = await bridge.transform('uploads/a.jpg', 'https://origin.test/uploads/a.jpg');
    expect(pub).toMatch(/^https:\/\/img\.test\/insecure\//);

    const signed = await bridge.transform('uploads/a.jpg', 'https://origin.test/private-url', { signed: true });
    expect(signed).toBe('https://origin.test/private-url');
  });
});
