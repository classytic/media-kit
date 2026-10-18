/**
 * `fileTypes.verifyContent` on bytes the API never saw: presigned confirm, multipart
 * completion and derivative PUTs sniff the stored head and refuse HTML/SVG labelled as an
 * inert type with 415 `media.file.content_mismatch`, deleting the object. Memory driver and
 * the real LocalProvider (disk).
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { isHttpError, toErrorContract } from '@classytic/repo-core/errors';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LocalProvider } from '../../src/providers/local.provider.js';
import {
  bindMediaFlat,
  createTestEngine,
  teardownTestMongo,
  type TestEngineHandle,
} from '../helpers/create-test-engine.js';

const HTML = Buffer.from('\n<!doctype html><html><script>alert(document.cookie)</script></html>');
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]), Buffer.from('JFIF-bytes')]);
const fileTypes = { allowed: ['image/*'], maxSize: 1024 * 1024, verifyContent: true };

async function wireOf(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (err) {
    expect(isHttpError(err)).toBe(true);
    return toErrorContract(err);
  }
  throw new Error('expected a rejection');
}

afterAll(async () => {
  await teardownTestMongo();
});

describe('presigned content sniff (memory driver)', () => {
  let handle: TestEngineHandle;
  afterEach(async () => {
    await handle.cleanup();
  });

  it('confirm: HTML labelled image/jpeg is 415 and the object is deleted', async () => {
    handle = await createTestEngine({ fileTypes });
    const repo = handle.engine.repositories.media;
    const { key } = await repo.getSignedUploadUrl('a.jpg', 'image/jpeg');
    handle.driver.simulateExternalUpload(key, HTML, 'image/jpeg');
    const wire = await wireOf(
      repo.confirmUpload({ key, filename: 'a.jpg', mimeType: 'image/jpeg', size: HTML.length }),
    );
    expect(wire).toMatchObject({ status: 415, code: 'media.file.content_mismatch' });
    expect(await handle.driver.exists(key)).toBe(false);
    expect(await repo.count({})).toBe(0);
  });

  it('verifyContent reaches the engine through defineMedia (buffered upload refuses too)', async () => {
    handle = await createTestEngine({ fileTypes });
    expect(handle.engine.config.fileTypes?.verifyContent).toBe(true);
    const wire = await wireOf(
      handle.engine.repositories.media.upload({ buffer: HTML, filename: 'a.jpg', mimeType: 'image/jpeg' }),
    );
    expect(wire).toMatchObject({ status: 415, code: 'media.file.content_mismatch' });
  });

  it('confirm: real JPEG bytes pass', async () => {
    handle = await createTestEngine({ fileTypes });
    const repo = handle.engine.repositories.media;
    const { key } = await repo.getSignedUploadUrl('a.jpg', 'image/jpeg');
    handle.driver.simulateExternalUpload(key, JPEG, 'image/jpeg');
    const media = await repo.confirmUpload({ key, filename: 'a.jpg', mimeType: 'image/jpeg', size: JPEG.length });
    expect(media.status).toBe('ready');
  });

  it('verifyContent off: no read-back, behaviour unchanged', async () => {
    handle = await createTestEngine({ fileTypes: { allowed: ['image/*'] } });
    const repo = handle.engine.repositories.media;
    const { key } = await repo.getSignedUploadUrl('a.jpg', 'image/jpeg');
    handle.driver.simulateExternalUpload(key, HTML, 'image/jpeg');
    let reads = 0;
    const read = handle.driver.read.bind(handle.driver);
    handle.driver.read = async (...args) => {
      reads++;
      return read(...args);
    };
    expect(
      (await repo.confirmUpload({ key, filename: 'a.jpg', mimeType: 'image/jpeg', size: HTML.length })).status,
    ).toBe('ready');
    expect(reads).toBe(0);
  });

  it('multipart completion: HTML parts labelled image/jpeg are 415 and deleted', async () => {
    handle = await createTestEngine({ fileTypes });
    const repo = handle.engine.repositories.media;
    const session = await repo.initiateMultipartUpload({ filename: 'big.jpg', contentType: 'image/jpeg' });
    if (session.type !== 'multipart') throw new Error('expected multipart');
    handle.driver.simulatePartUpload(session.uploadId, 1, HTML);
    const wire = await wireOf(
      repo.completeMultipartUpload({
        key: session.key,
        uploadId: session.uploadId,
        parts: [{ partNumber: 1, etag: 'e1' }],
        filename: 'big.jpg',
        mimeType: 'image/jpeg',
        size: HTML.length,
      }),
    );
    expect(wire).toMatchObject({ status: 415, code: 'media.file.content_mismatch' });
    expect(await handle.driver.exists(session.key)).toBe(false);
  });

  it('derivative PUT: an HTML variant is 415 and deleted', async () => {
    handle = await createTestEngine({ fileTypes });
    const repo = handle.engine.repositories.media;
    const { key } = await repo.getSignedUploadUrl('a.jpg', 'image/jpeg');
    handle.driver.simulateExternalUpload(key, JPEG, 'image/jpeg');
    const [target] = await repo.signDerivativeUploads({
      primaryKey: key,
      derivatives: [{ name: 'thumbnail', contentType: 'image/webp' }],
    });
    if (!target) throw new Error('expected a derivative target');
    handle.driver.simulateExternalUpload(target.upload.key, HTML, 'image/webp');
    const wire = await wireOf(
      repo.confirmUpload({
        key,
        filename: 'a.jpg',
        mimeType: 'image/jpeg',
        size: JPEG.length,
        variants: [{ name: 'thumbnail', key: target.upload.key, mimeType: 'image/webp', size: HTML.length }],
      }),
    );
    expect(wire).toMatchObject({ status: 415, code: 'media.file.content_mismatch' });
    expect(await handle.driver.exists(target.upload.key)).toBe(false);
  });
});

describe('presigned content sniff (LocalProvider on disk)', () => {
  let dir: string;
  let handle: TestEngineHandle;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'mk-sniff-local-'));
    handle = await createTestEngine();
  });

  afterEach(async () => {
    await handle.cleanup();
    await rm(dir, { recursive: true, force: true });
  });

  it('a signed PUT of HTML as image/jpeg is refused at confirm and removed from disk', async () => {
    const local = new LocalProvider({
      basePath: dir,
      baseUrl: 'http://localhost:3000/files',
      presign: { enabled: true, uploadUrl: 'http://localhost:3000/media/dev-uploads', secret: 'dev' },
    });
    const engine = await bindMediaFlat({
      connection: handle.connection,
      driver: local,
      suppressWarnings: true,
      processing: { enabled: false },
      fileTypes,
    });
    const repo = engine.repositories.media;
    const presigned = await repo.getSignedUploadUrl('a.jpg', 'image/jpeg');
    const url = new URL(presigned.uploadUrl);
    await local.acceptSignedUpload({
      query: Object.fromEntries(url.searchParams),
      contentType: 'image/jpeg',
      body: HTML,
    });
    expect(await local.exists(presigned.key)).toBe(true);

    const wire = await wireOf(
      repo.confirmUpload({ key: presigned.key, filename: 'a.jpg', mimeType: 'image/jpeg', size: HTML.length }),
    );
    expect(wire).toMatchObject({ status: 415, code: 'media.file.content_mismatch' });
    expect(await local.exists(presigned.key)).toBe(false);
    await engine.close();
  });
});
