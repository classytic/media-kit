/**
 * Verifies: importFromUrlVerb (a) securely downloads, then (b) feeds the bytes
 * into the CANONICAL `repo.upload()` — threading `options.provider` (+ folder /
 * tags / alt / title) into the upload input, and publishing ASSET_IMPORTED.
 *
 * This is the verb-level contract for the scan-bypass fix: URL imports no
 * longer have their own upload pipeline; they route through `repo.upload()`
 * (which owns validation, the malware scan bridge, dedup, and quarantine). The
 * "scan actually runs / rejects" end-to-end proof lives in
 * tests/integration/url-import-scan.test.ts; provider STORAGE routing is
 * covered by tests/integration/multi-provider-integrity.test.ts.
 *
 * http is mocked: the SSRF guard blocks localhost, so a real local server can't
 * be used (same pattern as url-import-semaphore.test.ts).
 */

import { describe, it, expect, vi } from 'vitest';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { Semaphore } from '../../src/utils/semaphore';
import { importFromUrlVerb } from '../../src/repositories/verbs/import.verbs';
import type { MediaRepository } from '../../src/repositories/media.repository';
import type { UploadInput, IMediaDocument } from '../../src/types';

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

/** Minimal fake repository capturing the canonical upload call + published events. */
function fakeRepo() {
  const uploadSpy = vi.fn(
    async (input: UploadInput): Promise<IMediaDocument> =>
      ({
        _id: 'mock-id',
        filename: input.filename,
        mimeType: input.mimeType,
        size: input.buffer.length,
        provider: input.provider ?? 'primary',
        status: 'ready',
      }) as unknown as IMediaDocument,
  );
  const publishSpy = vi.fn(async () => {});
  const repo = {
    _opDeps: {
      config: { fileTypes: { allowed: [], maxSize: 1024 * 1024 } },
      uploadSemaphore: new Semaphore(2),
    },
    upload: uploadSpy,
    events: { publish: publishSpy },
  } as unknown as MediaRepository;
  return { repo, uploadSpy, publishSpy };
}

describe('importFromUrlVerb — routes downloads through the canonical repo.upload()', () => {
  it('threads options.provider (+ filename) into the upload input', async () => {
    const { repo, uploadSpy } = fakeRepo();
    await importFromUrlVerb(repo, 'http://93.184.216.34/pic.png', { provider: 'secondary' });

    expect(uploadSpy).toHaveBeenCalledTimes(1);
    const input = uploadSpy.mock.calls[0]![0] as UploadInput;
    expect(input.provider).toBe('secondary');
    expect(input.filename).toBe('pic.png');
    expect(input.mimeType).toBe('image/png');
    expect(input.buffer.toString()).toBe('remote-file-bytes');
  });

  it('leaves provider unset (default routing) when the option is absent', async () => {
    const { repo, uploadSpy } = fakeRepo();
    await importFromUrlVerb(repo, 'http://93.184.216.34/pic.png');

    const input = uploadSpy.mock.calls[0]![0] as UploadInput;
    expect(input.provider).toBeUndefined();
  });

  it('forwards folder / alt / title / tags and publishes ASSET_IMPORTED', async () => {
    const { repo, uploadSpy, publishSpy } = fakeRepo();
    await importFromUrlVerb(repo, 'http://93.184.216.34/pic.png', {
      folder: 'imports',
      alt: 'an image',
      title: 'Imported',
      tags: ['a', 'b'],
    });

    const input = uploadSpy.mock.calls[0]![0] as UploadInput;
    expect(input.folder).toBe('imports');
    expect(input.alt).toBe('an image');
    expect(input.title).toBe('Imported');
    expect(input.tags).toEqual(['a', 'b']);

    expect(publishSpy).toHaveBeenCalledTimes(1);
    const event = publishSpy.mock.calls[0]![0] as { type: string; payload: { sourceUrl: string } };
    expect(event.type).toBe('media:asset.imported');
    expect(event.payload.sourceUrl).toBe('http://93.184.216.34/pic.png');
  });
});
