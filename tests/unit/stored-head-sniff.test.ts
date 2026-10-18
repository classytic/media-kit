/**
 * `readStoredHead`: the ranged head read behind presigned `verifyContent`, per driver.
 * Memory and Local run for real; S3 and GCS are mocked at their client seam to prove the
 * range reaches the storage request. A driver that ignores the range stays bounded.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CONTENT_SNIFF_BYTES, readStoredHead } from '../../src/operations/helpers';
import { GCSProvider } from '../../src/providers/gcs.provider';
import { LocalProvider } from '../../src/providers/local.provider';
import { S3Provider } from '../../src/providers/s3.provider';
import type { StorageDriver } from '../../src/types/storage';
import { MemoryStorageDriver } from '../helpers/memory-driver';

const BIG = Buffer.alloc(CONTENT_SNIFF_BYTES * 3, 0x61);
BIG.write('<!doctype html>', 0, 'latin1');

describe('readStoredHead', () => {
  let dir: string | undefined;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('memory driver: returns exactly the first 4 KB', async () => {
    const driver = new MemoryStorageDriver();
    driver.simulateExternalUpload('uploads/a.jpg', BIG, 'image/jpeg');
    const head = await readStoredHead(driver, 'uploads/a.jpg');
    expect(head.length).toBe(CONTENT_SNIFF_BYTES);
    expect(head.subarray(0, 15).toString('latin1')).toBe('<!doctype html>');
  });

  it('local driver: ranged file read', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'mk-head-'));
    const local = new LocalProvider({ basePath: dir, baseUrl: '/files' });
    await local.write('uploads/a.jpg', BIG, 'image/jpeg');
    const spy = vi.spyOn(local, 'read');
    const head = await readStoredHead(local, 'uploads/a.jpg');
    expect(spy).toHaveBeenCalledWith('uploads/a.jpg', { start: 0, end: CONTENT_SNIFF_BYTES - 1 });
    expect(head.length).toBe(CONTENT_SNIFF_BYTES);
  });

  it('a short object returns all of it', async () => {
    const driver = new MemoryStorageDriver();
    driver.simulateExternalUpload('uploads/s.jpg', Buffer.from([0xff, 0xd8, 0xff]), 'image/jpeg');
    expect((await readStoredHead(driver, 'uploads/s.jpg')).length).toBe(3);
  });

  it('S3: sends GetObject with Range bytes=0-4095', async () => {
    const provider = new S3Provider({ bucket: 'b', region: 'us-east-1' });
    const send = vi.fn(async (_command: { input: Record<string, unknown> }) => ({ Body: Readable.from([BIG]) }));
    (provider as unknown as { client: unknown }).client = { send };
    (provider as unknown as { sdkAvailable: boolean }).sdkAvailable = true;
    const head = await readStoredHead(provider, 'uploads/a.jpg');
    expect(send.mock.calls[0]?.[0].input).toMatchObject({
      Key: 'uploads/a.jpg',
      Range: `bytes=0-${CONTENT_SNIFF_BYTES - 1}`,
    });
    expect(head.length).toBe(CONTENT_SNIFF_BYTES);
  });

  it('GCS: createReadStream({ start: 0, end: 4095 })', async () => {
    const provider = new GCSProvider({ bucket: 'b' });
    const createReadStream = vi.fn(() => Readable.from([BIG.subarray(0, CONTENT_SNIFF_BYTES)]));
    const file = vi.fn(() => ({ createReadStream }));
    (provider as unknown as { storage: unknown }).storage = {};
    (provider as unknown as { bucketInstance: unknown }).bucketInstance = { file };
    const head = await readStoredHead(provider, 'uploads/a.jpg');
    expect(file).toHaveBeenCalledWith('uploads/a.jpg');
    expect(createReadStream).toHaveBeenCalledWith({ start: 0, end: CONTENT_SNIFF_BYTES - 1 });
    expect(head.length).toBe(CONTENT_SNIFF_BYTES);
  });

  it('a driver that ignores the range is still read only up to the head, then destroyed', async () => {
    let produced = 0;
    const endless = new Readable({
      read() {
        produced += 1024;
        this.push(Buffer.alloc(1024, 0x62));
      },
    });
    const driver = { read: async () => endless } as unknown as StorageDriver;
    const head = await readStoredHead(driver, 'uploads/x.bin');
    expect(head.length).toBe(CONTENT_SNIFF_BYTES);
    expect(endless.destroyed).toBe(true);
    expect(produced).toBeLessThan(CONTENT_SNIFF_BYTES * 32);
  });
});
