/**
 * Verifies fix: importFromUrl performs the fetch/buffering INSIDE the upload
 * semaphore, so N concurrent imports hold at most `maxConcurrent` in-flight
 * download buffers (previously the whole remote file was buffered before any
 * slot was acquired — unbounded memory under concurrent imports).
 *
 * http + upload are mocked: the SSRF guard blocks localhost, so a real local
 * server can't be used here.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { Semaphore } from '../../src/utils/semaphore';
import type { OperationDeps } from '../../src/operations/types';

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

vi.mock('../../src/operations/upload', () => ({
  upload: vi.fn(async () => ({ _id: 'mock-id', filename: 'mock.png', mimeType: 'image/png', size: 17 })),
}));

const { importFromUrl } = await import('../../src/operations/url-import');

function makeDeps(maxConcurrent: number): OperationDeps {
  return {
    config: { fileTypes: { allowed: [], maxSize: 1024 * 1024 } },
    driver: {},
    registry: {},
    repository: {},
    processor: null,
    processorReady: null,
    events: {
      emit: async () => {},
      on: () => () => {},
      removeAllListeners: () => {},
      listenerCount: () => 0,
    },
    uploadSemaphore: new Semaphore(maxConcurrent),
    logger: undefined,
  } as unknown as OperationDeps;
}

afterEach(() => {
  fetchState.active = 0;
  fetchState.maxActive = 0;
});

describe('importFromUrl — fetch bounded by upload semaphore', () => {
  it('never fetches more than maxConcurrent files at once', async () => {
    const deps = makeDeps(2);
    // 93.184.216.0/24 is a public documentation-adjacent range — passes the
    // SSRF private-IP guard, and IP literals resolve without a DNS query.
    await Promise.all(
      Array.from({ length: 6 }, (_, i) => importFromUrl(deps, `http://93.184.216.34/file-${i}.png`)),
    );

    expect(fetchState.maxActive).toBeGreaterThan(0);
    expect(fetchState.maxActive).toBeLessThanOrEqual(2);
  });

  it('still completes all imports (slots are released after each fetch)', async () => {
    const deps = makeDeps(1);
    const results = await Promise.all(
      Array.from({ length: 3 }, (_, i) => importFromUrl(deps, `http://93.184.216.34/f-${i}.png`)),
    );
    expect(results).toHaveLength(3);
    expect(fetchState.maxActive).toBe(1);
  });
});
