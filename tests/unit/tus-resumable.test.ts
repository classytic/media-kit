/**
 * TUS resumable upload service — protocol pins (tus v1.0.0): creation,
 * chunked PATCH offsets, HEAD resume, version gate, size gate, expiration,
 * termination, concurrent-PATCH lock, and the finalize → upload() handoff.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { createTusUpload, TUS_VERSION, type TusUploadService } from '../../src/resumable/index';
import type { IMediaDocument } from '../../src/types';

const stagingDir = mkdtempSync(join(tmpdir(), 'media-kit-tus-'));
afterAll(() => rmSync(stagingDir, { recursive: true, force: true }));

function fakeMedia() {
  const upload = vi.fn(async (input: { buffer: Buffer; filename: string; mimeType: string }) => {
    return { _id: 'media-1', filename: input.filename, size: input.buffer.length } as unknown as IMediaDocument;
  });
  return { upload };
}

function service(overrides: Partial<Parameters<typeof createTusUpload>[0]> = {}): {
  tus: TusUploadService;
  upload: ReturnType<typeof fakeMedia>['upload'];
} {
  const media = fakeMedia();
  const tus = createTusUpload({ media, stagingDir, basePath: '/tus', ...overrides });
  return { tus, upload: media.upload };
}

const tusHeaders = { 'Tus-Resumable': TUS_VERSION };

async function create(tus: TusUploadService, length: number, metadata?: string) {
  return tus.handle({
    method: 'POST',
    headers: {
      ...tusHeaders,
      'Upload-Length': String(length),
      ...(metadata ? { 'Upload-Metadata': metadata } : {}),
    },
  });
}

function idOf(location: string): string {
  return location.split('/').pop() as string;
}

describe('TUS — protocol surface', () => {
  it('OPTIONS advertises version, extensions, and max size (no version gate)', async () => {
    const { tus } = service({ maxSize: 1024 });
    const res = await tus.handle({ method: 'OPTIONS', headers: {} });
    expect(res.status).toBe(204);
    expect(res.headers['Tus-Version']).toBe('1.0.0');
    expect(res.headers['Tus-Extension']).toContain('creation');
    expect(res.headers['Tus-Max-Size']).toBe('1024');
  });

  it('412s any non-OPTIONS request without a supported Tus-Resumable', async () => {
    const { tus } = service();
    const res = await tus.handle({ method: 'POST', headers: { 'Upload-Length': '10' } });
    expect(res.status).toBe(412);
    expect(res.headers['Tus-Version']).toBe('1.0.0');
  });

  it('creation → 201 with Location + Upload-Expires; missing/oversize length rejected', async () => {
    const { tus } = service({ maxSize: 100 });
    const ok = await create(tus, 10);
    expect(ok.status).toBe(201);
    expect(ok.headers.Location).toMatch(/^\/tus\/[0-9a-f-]{36}$/);
    expect(ok.headers['Upload-Expires']).toBeTruthy();

    expect((await tus.handle({ method: 'POST', headers: tusHeaders })).status).toBe(400);
    const tooBig = await create(tus, 101);
    expect(tooBig.status).toBe(413);
    expect(tooBig.headers['Tus-Max-Size']).toBe('100');
  });
});

describe('TUS — chunked upload lifecycle', () => {
  it('PATCH chunks advance the offset; the final byte runs the upload pipeline', async () => {
    const { tus, upload } = service();
    const body = Buffer.from('hello world!');
    const created = await create(
      tus,
      body.length,
      // filename "cat.jpg", filetype "image/jpeg"
      `filename ${Buffer.from('cat.jpg').toString('base64')},filetype ${Buffer.from('image/jpeg').toString('base64')}`,
    );
    const id = idOf(created.headers.Location);

    const first = await tus.handle({
      method: 'PATCH',
      uploadId: id,
      headers: { ...tusHeaders, 'Content-Type': 'application/offset+octet-stream', 'Upload-Offset': '0' },
      body: body.subarray(0, 5),
    });
    expect(first.status).toBe(204);
    expect(first.headers['Upload-Offset']).toBe('5');
    expect(first.mediaId).toBeUndefined();
    expect(upload).not.toHaveBeenCalled();

    const last = await tus.handle({
      method: 'PATCH',
      uploadId: id,
      headers: { ...tusHeaders, 'Content-Type': 'application/offset+octet-stream', 'Upload-Offset': '5' },
      body: body.subarray(5),
    });
    expect(last.status).toBe(204);
    expect(last.headers['Upload-Offset']).toBe(String(body.length));
    expect(last.mediaId).toBe('media-1');

    // Metadata reached the pipeline; bytes reassembled exactly.
    const input = upload.mock.calls[0][0];
    expect(input.filename).toBe('cat.jpg');
    expect(input.mimeType).toBe('image/jpeg');
    expect(input.buffer.equals(body)).toBe(true);

    // Session is gone after completion.
    const head = await tus.handle({ method: 'HEAD', uploadId: id, headers: tusHeaders });
    expect(head.status).toBe(404);
  });

  it('HEAD reports resume state; offset mismatch → 409 with the real offset', async () => {
    const { tus } = service();
    const created = await create(tus, 10);
    const id = idOf(created.headers.Location);

    await tus.handle({
      method: 'PATCH',
      uploadId: id,
      headers: { ...tusHeaders, 'Content-Type': 'application/offset+octet-stream', 'Upload-Offset': '0' },
      body: Buffer.from('abc'),
    });

    const head = await tus.handle({ method: 'HEAD', uploadId: id, headers: tusHeaders });
    expect(head.status).toBe(200);
    expect(head.headers['Upload-Offset']).toBe('3');
    expect(head.headers['Upload-Length']).toBe('10');
    expect(head.headers['Cache-Control']).toBe('no-store');

    const conflict = await tus.handle({
      method: 'PATCH',
      uploadId: id,
      headers: { ...tusHeaders, 'Content-Type': 'application/offset+octet-stream', 'Upload-Offset': '0' },
      body: Buffer.from('xxx'),
    });
    expect(conflict.status).toBe(409);
    expect(conflict.headers['Upload-Offset']).toBe('3');
  });

  it('PATCH without the offset+octet-stream content type → 415; unknown id → 404', async () => {
    const { tus } = service();
    const created = await create(tus, 4);
    const id = idOf(created.headers.Location);
    const badType = await tus.handle({
      method: 'PATCH',
      uploadId: id,
      headers: { ...tusHeaders, 'Content-Type': 'text/plain', 'Upload-Offset': '0' },
      body: Buffer.from('ab'),
    });
    expect(badType.status).toBe(415);

    const missing = await tus.handle({
      method: 'PATCH',
      uploadId: '00000000-0000-0000-0000-000000000000',
      headers: { ...tusHeaders, 'Content-Type': 'application/offset+octet-stream', 'Upload-Offset': '0' },
      body: Buffer.from('ab'),
    });
    expect(missing.status).toBe(404);
  });

  it('DELETE terminates an in-flight upload', async () => {
    const { tus } = service();
    const id = idOf((await create(tus, 8)).headers.Location);
    expect((await tus.handle({ method: 'DELETE', uploadId: id, headers: tusHeaders })).status).toBe(204);
    expect((await tus.handle({ method: 'HEAD', uploadId: id, headers: tusHeaders })).status).toBe(404);
  });

  it('zero-length uploads complete at creation', async () => {
    const { tus, upload } = service();
    const res = await create(tus, 0);
    expect(res.status).toBe(201);
    expect(res.mediaId).toBe('media-1');
    expect(upload.mock.calls[0][0].buffer.length).toBe(0);
  });
});

describe('TUS — expiration + sweep', () => {
  it('expired sessions answer 410 and sweepExpired reclaims them', async () => {
    const { tus } = service({ ttlMs: -1 }); // born expired
    const id = idOf((await create(tus, 4)).headers.Location);

    const head = await tus.handle({ method: 'HEAD', uploadId: id, headers: tusHeaders });
    expect(head.status).toBe(410);

    const { tus: tus2 } = service({ ttlMs: -1 });
    await create(tus2, 4);
    await create(tus2, 4);
    expect(await tus2.sweepExpired()).toBe(2);
  });

  it('forwards creation options (folder/visibility/ctx) into the pipeline', async () => {
    const { tus, upload } = service();
    const created = await tus.handle(
      { method: 'POST', headers: { ...tusHeaders, 'Upload-Length': '2' } },
      { folder: 'invoices', visibility: 'private', ctx: { organizationId: 'org1' } },
    );
    await tus.handle({
      method: 'PATCH',
      uploadId: idOf(created.headers.Location),
      headers: { ...tusHeaders, 'Content-Type': 'application/offset+octet-stream', 'Upload-Offset': '0' },
      body: Buffer.from('ok'),
    });
    const [input, ctx] = upload.mock.calls[0];
    expect(input.folder).toBe('invoices');
    expect(input.visibility).toBe('private');
    expect(ctx).toEqual({ organizationId: 'org1' });
  });
});
