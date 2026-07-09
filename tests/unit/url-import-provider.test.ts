/**
 * Verifies fix: importFromUrl threads `options.provider` into the upload
 * input (it was declared on ImportOptions but silently dropped, so imports
 * always landed in the DEFAULT provider regardless of the option).
 *
 * http + upload are mocked: the SSRF guard blocks localhost, so a real local
 * server can't be used here (same pattern as url-import-semaphore.test.ts).
 * The storage side of provider routing is covered by
 * tests/integration/multi-provider-integrity.test.ts.
 */

import { describe, it, expect, vi } from 'vitest';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { Semaphore } from '../../src/utils/semaphore';
import type { OperationDeps } from '../../src/operations/types';
import type { UploadInput } from '../../src/types';

vi.mock('node:http', () => {
  const get = (
    _url: string,
    _opts: unknown,
    cb: (res: NodeJS.ReadableStream & { statusCode: number; headers: Record<string, string> }) => void,
  ) => {
    const res = Readable.from([Buffer.from('remote-file-bytes')]) as unknown as NodeJS.ReadableStream & {
      statusCode: number;
      headers: Record<string, string>;
    };
    res.statusCode = 200;
    res.headers = { 'content-type': 'image/png', 'content-length': '17' };
    queueMicrotask(() => cb(res));
    const req = new EventEmitter() as EventEmitter & { destroy: () => void };
    req.destroy = () => {};
    return req;
  };
  return { default: { get } };
});

const uploadSpy = vi.fn(async (_deps: OperationDeps, input: UploadInput) => ({
  _id: 'mock-id',
  filename: input.filename,
  mimeType: input.mimeType,
  size: input.buffer.length,
  provider: input.provider ?? 'primary',
}));

vi.mock('../../src/operations/upload', () => ({
  upload: (deps: OperationDeps, input: UploadInput) => uploadSpy(deps, input),
}));

const { importFromUrl } = await import('../../src/operations/url-import');

function makeDeps(): OperationDeps {
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
    uploadSemaphore: new Semaphore(2),
    logger: undefined,
  } as unknown as OperationDeps;
}

describe('importFromUrl — provider option threading', () => {
  it('forwards options.provider into the upload input', async () => {
    uploadSpy.mockClear();
    await importFromUrl(makeDeps(), 'http://93.184.216.34/pic.png', { provider: 'secondary' });

    expect(uploadSpy).toHaveBeenCalledTimes(1);
    const input = uploadSpy.mock.calls[0]![1];
    expect(input.provider).toBe('secondary');
    expect(input.filename).toBe('pic.png');
  });

  it('leaves provider undefined (default routing) when the option is absent', async () => {
    uploadSpy.mockClear();
    await importFromUrl(makeDeps(), 'http://93.184.216.34/pic.png');

    expect(uploadSpy).toHaveBeenCalledTimes(1);
    expect(uploadSpy.mock.calls[0]![1].provider).toBeUndefined();
  });
});
