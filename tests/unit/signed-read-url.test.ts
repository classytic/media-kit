/**
 * `getSignedReadUrl`: GCS V4 signs locally with the service-account key (no network), so the
 * pinned response headers can be asserted on the URL; the router delegates and refuses a driver
 * without the method.
 */
import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { GCSProvider } from '../../src/providers/gcs.provider.js';
import { StorageRouter } from '../../src/providers/router.js';
import { MemoryStorageDriver } from '../helpers/memory-driver.js';

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const credentials = {
  client_email: 'signer@metro-test.iam.gserviceaccount.com',
  private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string,
};

describe('getSignedReadUrl', () => {
  it('GCS V4: response-content-type and response-content-disposition are signed query params', async () => {
    const gcs = new GCSProvider({ bucket: 'metro-media', projectId: 'metro-test', credentials, makePublic: false });
    const url = new URL(
      await gcs.getSignedReadUrl('comms/c1/u1/permit.pdf', 300, {
        responseType: 'application/pdf',
        responseDisposition: 'inline',
      }),
    );
    expect(url.hostname).toBe('storage.googleapis.com');
    expect(url.searchParams.get('response-content-type')).toBe('application/pdf');
    expect(url.searchParams.get('response-content-disposition')).toBe('inline');
    expect(url.searchParams.get('X-Goog-Expires')).toBe('300');
    expect(url.searchParams.get('X-Goog-Signature')).toBeTruthy();
    // Without options: a plain signed read URL.
    const plain = new URL(await gcs.getSignedReadUrl('a/b.png', 60, {}));
    expect(plain.searchParams.has('response-content-type')).toBe(false);
    expect(plain.searchParams.has('response-content-disposition')).toBe(false);
  });

  it('router delegates, and refuses a driver without it', async () => {
    const gcs = new GCSProvider({ bucket: 'metro-media', projectId: 'metro-test', credentials, makePublic: false });
    const router = new StorageRouter({ drivers: { gcs }, default: 'gcs' });
    const url = new URL(await router.getSignedReadUrl('x/y.pdf', 120, { responseType: 'application/pdf' }));
    expect(url.searchParams.get('response-content-type')).toBe('application/pdf');
    const memory = new StorageRouter({ drivers: { mem: new MemoryStorageDriver() }, default: 'mem' });
    await expect(memory.getSignedReadUrl('x/y.pdf', 120, {})).rejects.toThrow('does not support signed read URLs');
  });
});
