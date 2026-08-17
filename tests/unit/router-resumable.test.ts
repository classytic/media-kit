/**
 * StorageRouter — resumable-session ownership must survive restart / cross a
 * replica boundary, and must NEVER silently fall back to the default driver
 * (which could abort or query the wrong provider).
 */

import { describe, it, expect } from 'vitest';
import { StorageRouter } from '../../src/providers/router';
import type { StorageDriver, ResumableUploadSession } from '../../src/types';

/** Minimal resumable-capable driver that records which of its methods ran. */
function fakeDriver(name: string, uriHost: string) {
  const calls: { abort: string[]; status: string[] } = { abort: [], status: [] };
  const driver = {
    name,
    async write() {
      return { key: '', size: 0, url: '' };
    },
    async read() {
      throw new Error('nope');
    },
    async delete() {
      return true;
    },
    async exists() {
      return false;
    },
    async stat() {
      return { size: 0, contentType: '', lastModified: new Date() };
    },
    getPublicUrl(key: string) {
      return `${uriHost}/${key}`;
    },
    async createResumableUpload(key: string): Promise<ResumableUploadSession> {
      return {
        uploadUrl: `${uriHost}/session/${key}?upload_id=SECRET`,
        key,
        publicUrl: `${uriHost}/${key}`,
        minChunkSize: 262144,
        expiresAt: new Date(Date.now() + 3600_000),
      };
    },
    async abortResumableUpload(uri: string) {
      calls.abort.push(uri);
    },
    async getResumableUploadStatus(uri: string) {
      calls.status.push(uri);
      return { uploadedBytes: 42 };
    },
  } as unknown as StorageDriver;
  return { driver, calls };
}

function makeRouter() {
  const primary = fakeDriver('primary', 'https://primary.example');
  const secondary = fakeDriver('secondary', 'https://secondary.example');
  const router = new StorageRouter({
    drivers: { primary: primary.driver, secondary: secondary.driver },
    routes: [{ prefix: 'sec/', driver: 'secondary' }],
    default: 'primary',
  });
  return { router, primary, secondary };
}

describe('StorageRouter — resumable ownership', () => {
  it('tags the returned uploadUrl with the owning driver', async () => {
    const { router } = makeRouter();
    const session = await router.createResumableUpload('sec/video.mp4', 'video/mp4');
    expect(session.uploadUrl).toContain('__mkdriver=secondary');
    // the provider-facing part is preserved
    expect(session.uploadUrl).toContain('https://secondary.example/session/sec/video.mp4');
  });

  it('resolves abort/status to the ORIGINAL driver from the tag — even on a FRESH router (restart/replica)', async () => {
    const { router } = makeRouter();
    const session = await router.createResumableUpload('sec/video.mp4', 'video/mp4');

    // Simulate a restart / different replica: a brand-new router with empty map.
    const { router: fresh, primary, secondary } = makeRouter();

    await fresh.abortResumableUpload(session.uploadUrl);
    await fresh.getResumableUploadStatus(session.uploadUrl);

    // Routed to secondary (the tag), NOT the default (primary).
    expect(secondary.calls.abort).toHaveLength(1);
    expect(secondary.calls.status).toHaveLength(1);
    expect(primary.calls.abort).toHaveLength(0);
    expect(primary.calls.status).toHaveLength(0);
    // The provider received the CLEAN uri (tag fragment stripped).
    expect(secondary.calls.abort[0]).not.toContain('__mkdriver');
  });

  it('FAILS EXPLICITLY on an untagged, unknown session — no silent default fallback', async () => {
    const { router, primary } = makeRouter();
    await expect(router.abortResumableUpload('https://x.example/session/opaque')).rejects.toThrow(
      /cannot resolve the storage driver/i,
    );
    // The default driver was never consulted.
    expect(primary.calls.abort).toHaveLength(0);
  });

  it('throws a clear error when the tag names a driver that no longer exists', async () => {
    const { router } = makeRouter();
    await expect(
      router.getResumableUploadStatus('https://x.example/s?upload_id=1#__mkdriver=ghost'),
    ).rejects.toThrow(/unknown driver 'ghost'/);
  });
});
