/**
 * Client-caused refusals reach the wire with their own status and a stable code.
 *
 * Asserted through repo-core's `isHttpError` + `toErrorContract`: that is exactly arc's
 * error-handler path for an `HttpError`-shaped throw (classify step 2), so a code/status
 * seen here is what an arc host serializes. A bare `Error` would read `internal_error` 500.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { isHttpError, toErrorContract } from '@classytic/repo-core/errors';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MEDIA_ERROR_CODES } from '../../src/errors.js';
import { LocalProvider } from '../../src/providers/local.provider.js';
import {
  bindMediaFlat,
  createTestEngine,
  teardownTestMongo,
  type TestEngineHandle,
} from '../helpers/create-test-engine.js';

async function wireOf(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (err) {
    expect(isHttpError(err)).toBe(true);
    return toErrorContract(err);
  }
  throw new Error('expected a rejection');
}

describe('typed errors (RI-11)', () => {
  let handle: TestEngineHandle;

  afterAll(async () => {
    await teardownTestMongo();
  });

  beforeEach(async () => {
    handle = await createTestEngine({ fileTypes: { allowed: ['image/*'], maxSize: 1024 } });
  });

  afterEach(async () => {
    await handle.cleanup();
  });

  it('presign of a disallowed MIME is 415 media.file.type_not_allowed', async () => {
    const wire = await wireOf(handle.engine.repositories.media.getSignedUploadUrl('a.exe', 'application/x-msdownload'));
    expect(wire).toMatchObject({ status: 415, code: MEDIA_ERROR_CODES.FILE_TYPE_NOT_ALLOWED });
    expect(wire.code).toBe('media.file.type_not_allowed');
  });

  it('presign over max size is 413 media.file.too_large', async () => {
    const wire = await wireOf(
      handle.engine.repositories.media.getSignedUploadUrl('a.png', 'image/png', { size: 4096 }),
    );
    expect(wire).toMatchObject({ status: 413, code: MEDIA_ERROR_CODES.FILE_TOO_LARGE });
  });

  it('confirm of a disallowed MIME is 415', async () => {
    const repo = handle.engine.repositories.media;
    const { key } = await repo.getSignedUploadUrl('a.png', 'image/png');
    const wire = await wireOf(repo.confirmUpload({ key, filename: 'a.html', mimeType: 'text/html', size: 9 }));
    expect(wire).toMatchObject({ status: 415, code: 'media.file.type_not_allowed' });
  });

  it('confirm over max size is 413', async () => {
    const repo = handle.engine.repositories.media;
    const { key } = await repo.getSignedUploadUrl('a.png', 'image/png');
    const wire = await wireOf(repo.confirmUpload({ key, filename: 'a.png', mimeType: 'image/png', size: 4096 }));
    expect(wire).toMatchObject({ status: 413, code: 'media.file.too_large' });
  });

  it('confirm of a key with no stored object is 409 media.upload.not_found', async () => {
    const repo = handle.engine.repositories.media;
    const { key } = await repo.getSignedUploadUrl('a.png', 'image/png');
    const wire = await wireOf(repo.confirmUpload({ key, filename: 'a.png', mimeType: 'image/png', size: 9 }));
    expect(wire).toMatchObject({ status: 409, code: 'media.upload.not_found' });
  });

  it('direct upload: disallowed type 415, empty 400, oversize 413', async () => {
    const repo = handle.engine.repositories.media;
    const typed = await wireOf(repo.upload({ buffer: Buffer.from('x'), filename: 'a.txt', mimeType: 'text/plain' }));
    expect(typed).toMatchObject({ status: 415, code: 'media.file.type_not_allowed' });
    const empty = await wireOf(repo.upload({ buffer: Buffer.alloc(0), filename: 'a.png', mimeType: 'image/png' }));
    expect(empty).toMatchObject({ status: 400, code: 'media.file.empty' });
    const big = await wireOf(repo.upload({ buffer: Buffer.alloc(4096, 1), filename: 'a.png', mimeType: 'image/png' }));
    expect(big).toMatchObject({ status: 413, code: 'media.file.too_large' });
  });

  it('unknown media id is 404 media.asset.not_found; bad focal point is 400', async () => {
    const repo = handle.engine.repositories.media;
    const missing = '507f1f77bcf86cd799439099';
    expect(await wireOf(repo.addTags(missing, ['x']))).toMatchObject({ status: 404, code: 'media.asset.not_found' });
    expect(await wireOf(repo.setFocalPoint(missing, { x: 2, y: 0 }))).toMatchObject({
      status: 400,
      code: 'media.focal_point.invalid',
    });
  });
});

describe('LocalProvider presigned PUT: two-phase upload without a bucket (RI-13)', () => {
  let dir: string;
  let handle: TestEngineHandle;

  afterAll(async () => {
    await teardownTestMongo();
  });

  afterEach(async () => {
    await handle?.cleanup();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('presign, PUT through the receiver, then confirm, exactly as against S3/GCS', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'mk-local-presign-'));
    const local = new LocalProvider({
      basePath: dir,
      baseUrl: 'http://localhost:3000/files',
      presign: { enabled: true, uploadUrl: 'http://localhost:3000/media/dev-uploads', secret: 'dev-secret' },
    });
    // The handle supplies the shared connection (and cleanup); the engine under test runs on disk.
    handle = await createTestEngine();
    const engine = await bindMediaFlat({
      connection: handle.connection,
      driver: local,
      suppressWarnings: true,
      processing: { enabled: false },
    });
    const repo = engine.repositories.media;

    const presigned = await repo.getSignedUploadUrl('photo.png', 'image/png');
    const url = new URL(presigned.uploadUrl);
    expect(url.pathname).toBe('/media/dev-uploads');

    // Before the PUT lands, confirm is the client's 409, not a 500.
    const early = await wireOf(
      repo.confirmUpload({ key: presigned.key, filename: 'photo.png', mimeType: 'image/png', size: 9 }),
    );
    expect(early).toMatchObject({ status: 409, code: 'media.upload.not_found' });

    const bytes = Buffer.from('png-bytes');
    const written = await local.acceptSignedUpload({
      query: Object.fromEntries(url.searchParams),
      contentType: presigned.headers?.['Content-Type'] ?? '',
      body: bytes,
    });
    expect(written).toEqual({ key: presigned.key, size: bytes.length });

    const media = await repo.confirmUpload({
      key: presigned.key,
      filename: 'photo.png',
      mimeType: 'image/png',
      size: bytes.length,
    });
    expect(media.status).toBe('ready');
    expect(media.size).toBe(bytes.length);
    await engine.close();
  });
});
