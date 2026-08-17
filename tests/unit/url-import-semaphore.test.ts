/**
 * Verifies fix: downloadFromUrl performs the fetch/buffering INSIDE the upload
 * semaphore, so N concurrent imports hold at most `maxConcurrent` in-flight
 * download buffers (previously the whole remote file was buffered before any
 * slot was acquired — unbounded memory under concurrent imports).
 *
 * http is mocked: the SSRF guard blocks localhost, so a real local server can't
 * be used here. (The upload half is no longer part of this module — the verb
 * feeds the download into the canonical `repo.upload()`.)
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { Semaphore } from '../../src/utils/semaphore';
import type { DownloadDeps } from '../../src/operations/url-import';

// Track fetch concurrency from inside the mocked transport
const fetchState = { active: 0, maxActive: 0 };

vi.mock('node:http', () => {
  const get = (
    _url: string,
    _opts: unknown,
    cb: (res: NodeJS.ReadableStream & { statusCode: number; headers: Record<string, string> }) => void,
  ) => {
    fetchState.active++;
    fetchState.maxActive = Math.max(fetchState.maxActive, fetchState.active);

    const res = Readable.from(
      (async function* () {
        // Hold the response open long enough for other imports to pile up
        await new Promise((r) => setTimeout(r, 30));
        fetchState.active--;
        yield Buffer.from('remote-file-bytes');
      })(),
    ) as unknown as NodeJS.ReadableStream & { statusCode: number; headers: Record<string, string> };
    res.statusCode = 200;
    res.headers = { 'content-type': 'image/png', 'content-length': '17' };

    queueMicrotask(() => cb(res));

    const req = new EventEmitter() as EventEmitter & { destroy: () => void };
    req.destroy = () => {};
    return req;
  };
  return { default: { get } };
});

const { downloadFromUrl } = await import('../../src/operations/url-import');

function makeDeps(maxConcurrent: number): DownloadDeps {
  return {
    config: { fileTypes: { maxSize: 1024 * 1024 } },
    uploadSemaphore: new Semaphore(maxConcurrent),
  };
}

afterEach(() => {
  fetchState.active = 0;
  fetchState.maxActive = 0;
});

describe('downloadFromUrl — fetch bounded by upload semaphore', () => {
  it('never fetches more than maxConcurrent files at once', async () => {
    const deps = makeDeps(2);
    // 93.184.216.0/24 is a public documentation-adjacent range — passes the
    // SSRF private-IP guard, and IP literals resolve without a DNS query.
    await Promise.all(
      Array.from({ length: 6 }, (_, i) => downloadFromUrl(deps, `http://93.184.216.34/file-${i}.png`)),
    );

    expect(fetchState.maxActive).toBeGreaterThan(0);
    expect(fetchState.maxActive).toBeLessThanOrEqual(2);
  });

  it('still completes all imports (slots are released after each fetch)', async () => {
    const deps = makeDeps(1);
    const results = await Promise.all(
      Array.from({ length: 3 }, (_, i) => downloadFromUrl(deps, `http://93.184.216.34/f-${i}.png`)),
    );
    expect(results).toHaveLength(3);
    expect(fetchState.maxActive).toBe(1);
  });
});
