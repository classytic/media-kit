/**
 * Integration tests — processImage storage-orphan cleanup, end to end.
 *
 * processImage writes storage objects incrementally (`__original` before
 * `processor.process()`, size variants inside the loop) but callers only
 * learn the written keys from its RETURN value. These tests pin down the
 * fix at the repository level:
 *
 *   1. processImage owns cleanup of its own writes on any internal failure
 *      (the documented swallow-fallback leaves ZERO orphaned keys), through
 *      the CORRECT per-provider driver.
 *   2. The `onWrite` collector feeds upload()/replace() rollback lists, so
 *      failures AFTER processImage returns (main write, DB update) roll back
 *      every newly-written key — storage returns to its pre-call state.
 *   3. The presigned reprocess flows (confirmUpload/completeMultipartUpload
 *      with `process: true`) stay non-blocking on processing failure but no
 *      longer strand variant keys the finalising CAS never persisted.
 *
 * Modeled on multi-provider-integrity.test.ts (two drivers under distinct
 * registry keys + deterministic stub ImageAdapter — no sharp).
 */

import { describe, it, expect, afterAll, beforeEach, vi } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createMedia } from '../../src/engine/create-media.js';
import type { MediaEngine } from '../../src/engine/engine-types.js';
import type { ImageAdapter, ProcessedImage, ProcessingOptions, SizeVariant, WriteResult } from '../../src/types.js';
import { MemoryStorageDriver } from '../helpers/memory-driver.js';
import { createTestImageBuffer, teardownTestMongo } from '../helpers/create-test-engine.js';

const PNG = createTestImageBuffer();

/** Deterministic ImageAdapter (same shape as multi-provider-integrity). */
class StubImageAdapter implements ImageAdapter {
  async process(buffer: Buffer, _options: ProcessingOptions): Promise<ProcessedImage> {
    return { buffer, mimeType: 'image/png', width: 100, height: 50 };
  }
  isProcessable(): boolean {
    return true;
  }
  async getDimensions(): Promise<{ width: number; height: number }> {
    return { width: 100, height: 50 };
  }
  async generateVariants(
    buffer: Buffer,
    variants: SizeVariant[],
  ): Promise<Array<ProcessedImage & { variantName: string }>> {
    return variants.map((v) => ({
      buffer,
      mimeType: 'image/png',
      width: v.width ?? 10,
      height: 10,
      variantName: v.name,
    }));
  }
}

/** Memory driver with per-key write-failure injection. */
class SelectiveFailDriver extends MemoryStorageDriver {
  failWrite: ((key: string) => boolean) | null = null;

  async write(key: string, data: Buffer | NodeJS.ReadableStream, contentType: string): Promise<WriteResult> {
    if (this.failWrite?.(key)) throw new Error(`forced write failure: ${key}`);
    return super.write(key, data, contentType);
  }
}

// ── Shared Mongo ─────────────────────────────────────────────────────────────

let mongo: MongoMemoryServer | null = null;
let connection: mongoose.Connection | null = null;

async function getConnection(): Promise<mongoose.Connection> {
  if (connection && connection.readyState === 1) return connection;
  mongo = await MongoMemoryServer.create();
  connection = await mongoose.createConnection(mongo.getUri()).asPromise();
  return connection;
}

async function resetCollections(): Promise<void> {
  if (!connection) return;
  const collections = await connection.db?.collections();
  if (collections) for (const c of collections) await c.deleteMany({});
}

interface Rig {
  engine: MediaEngine;
  primary: SelectiveFailDriver;
  secondary: SelectiveFailDriver;
}

/** Two-provider engine: processing + one size variant ('thumb') + __original. */
async function createRig(): Promise<Rig> {
  const conn = await getConnection();
  const primary = new SelectiveFailDriver();
  const secondary = new SelectiveFailDriver();
  const engine = await createMedia({
    connection: conn,
    providers: { primary, secondary },
    defaultProvider: 'primary',
    suppressWarnings: true,
    processing: {
      enabled: true,
      imageAdapter: new StubImageAdapter(),
      sizes: [{ name: 'thumb', width: 100 }],
      originalHandling: 'keep-variant',
      smartSkip: false,
    },
  });
  return { engine, primary, secondary };
}

async function allKeys(driver: MemoryStorageDriver): Promise<string[]> {
  const out: string[] = [];
  for await (const key of driver.list('')) out.push(key);
  return out.sort();
}

afterAll(async () => {
  await teardownTestMongo();
  if (connection) {
    await connection.close();
    connection = null;
  }
  if (mongo) {
    await mongo.stop();
    mongo = null;
  }
});

beforeEach(async () => {
  await resetCollections();
});

// ── upload() — internal fallback + post-return rollback ─────────────────────

describe('upload() — processImage partial writes never orphan storage', () => {
  it('variant write fails mid-pipeline → upload still succeeds with ZERO orphans (swallow contract)', async () => {
    const { engine, primary, secondary } = await createRig();
    const repo = engine.repositories.media;

    // __original lands, the 'thumb' variant write fails → processImage falls
    // back to the original (documented contract) and must delete __original.
    secondary.failWrite = (key) => key.includes('-thumb');

    const media = await repo.upload({
      buffer: PNG,
      filename: 'photo.png',
      mimeType: 'image/png',
      provider: 'secondary',
    });

    expect(media.status).toBe('ready');
    // Fallback result records NO variants — and no deleted-key references
    expect(media.variants ?? []).toEqual([]);
    // Storage holds EXACTLY the main object: __original was cleaned up
    expect(await allKeys(secondary)).toEqual([media.key]);
    expect(secondary.getBuffer(media.key)?.equals(PNG)).toBe(true);
    // Cleanup ran through the CORRECT driver — default never touched
    expect(primary.size).toBe(0);

    await engine.dispose();
  });

  it('main write fails after processImage fell back → upload rejects, zero storage keys, doc errored', async () => {
    const { engine, primary, secondary } = await createRig();
    const repo = engine.repositories.media;

    // Everything EXCEPT __original fails: processImage writes __original,
    // fails on 'thumb', cleans __original up, falls back; then the main
    // write fails too and the error propagates out of _performUpload.
    secondary.failWrite = (key) => !key.includes('__original');

    await expect(
      repo.upload({ buffer: PNG, filename: 'photo.png', mimeType: 'image/png', provider: 'secondary' }),
    ).rejects.toThrow(/forced write failure/);

    // A failed upload leaves ZERO storage keys — in EITHER provider
    expect(secondary.size).toBe(0);
    expect(primary.size).toBe(0);

    // The record survives in 'error' state for observability
    const found = (await repo.getAll({ page: 1, limit: 10 })) as { data: Array<{ status?: string }> };
    expect(found.data).toHaveLength(1);
    expect(found.data[0]?.status).toBe('error');

    await engine.dispose();
  });
});

// ── replace() — rollback list fed by the onWrite collector ──────────────────

describe('replace() — partial processImage writes + failure leave storage byte-identical', () => {
  it('processImage partially writes, then the main write fails → old object intact, zero new keys, error propagates', async () => {
    const { engine, primary, secondary } = await createRig();
    const repo = engine.repositories.media;

    const original = await repo.upload({
      buffer: PNG,
      filename: 'photo.png',
      mimeType: 'image/png',
      provider: 'secondary',
    });
    const keysBefore = await allKeys(secondary);
    const bytesBefore = new Map(keysBefore.map((k) => [k, secondary.getBuffer(k)]));

    // New writes: __original lands, 'thumb' fails (processImage cleans up and
    // falls back), then the replacement main write fails → replace() throws.
    secondary.failWrite = (key) => !key.includes('__original') && !keysBefore.includes(key);

    await expect(
      repo.replace(String(original._id), {
        buffer: Buffer.concat([PNG, Buffer.from('v2')]),
        filename: 'photo-v2.png',
        mimeType: 'image/png',
      }),
    ).rejects.toThrow(/forced write failure/);

    // Storage is byte-identical to the pre-replace state
    expect(await allKeys(secondary)).toEqual(keysBefore);
    for (const [key, buf] of bytesBefore) {
      expect(secondary.getBuffer(key)?.equals(buf!)).toBe(true);
    }
    expect(primary.size).toBe(0);

    // The doc is unchanged and still points at the OLD (live) object
    const after = await repo.getById(String(original._id), { throwOnNotFound: false });
    expect(after?.key).toBe(original.key);
    expect((after?.variants ?? []).map((v) => v.key).sort()).toEqual(
      (original.variants ?? []).map((v) => v.key).sort(),
    );

    await engine.dispose();
  });

  it('DB update fails after a PARTIAL processImage fallback → rollback still leaves storage byte-identical', async () => {
    const { engine, primary, secondary } = await createRig();
    const repo = engine.repositories.media;

    const original = await repo.upload({
      buffer: PNG,
      filename: 'photo.png',
      mimeType: 'image/png',
      provider: 'secondary',
    });
    const keysBefore = await allKeys(secondary);

    // 'thumb' write fails → processImage cleans its __original and falls
    // back; the main write SUCCEEDS; then the DB update throws → replace's
    // collector-fed rollback must delete the new main object.
    secondary.failWrite = (key) => key.includes('-thumb') && !keysBefore.includes(key);
    const updateSpy = vi.spyOn(repo, 'update').mockRejectedValueOnce(new Error('forced DB failure'));
    try {
      await expect(
        repo.replace(String(original._id), {
          buffer: Buffer.concat([PNG, Buffer.from('v2')]),
          filename: 'photo-v2.png',
          mimeType: 'image/png',
        }),
      ).rejects.toThrow('forced DB failure');
    } finally {
      updateSpy.mockRestore();
    }

    expect(await allKeys(secondary)).toEqual(keysBefore);
    expect(primary.size).toBe(0);

    await engine.dispose();
  });
});

// ── presigned reprocess flows — non-blocking, but never orphaning ────────────

describe('confirmUpload({ process: true }) — reprocess failures leave zero orphaned variants', () => {
  it('variant write fails during reprocess → confirm succeeds, storage holds only the uploaded object', async () => {
    const { engine, primary } = await createRig();
    const repo = engine.repositories.media;

    const presigned = await repo.getSignedUploadUrl('photo.png', 'image/png');
    primary.simulateExternalUpload(presigned.key, PNG, 'image/png');

    // __original lands, 'thumb' write fails → processImage falls back and
    // cleans up; confirm stays non-blocking and the record lands 'ready'.
    primary.failWrite = (key) => key.includes('-thumb');

    const media = await repo.confirmUpload({
      key: presigned.key,
      filename: 'photo.png',
      mimeType: 'image/png',
      size: PNG.length,
      process: true,
    });

    expect(media.status).toBe('ready');
    expect(media.variants ?? []).toEqual([]);
    expect(await allKeys(primary)).toEqual([presigned.key]);

    await engine.dispose();
  });

  it('finalising CAS throws AFTER variants were written → variants deleted, record reverted to ready', async () => {
    const { engine, primary } = await createRig();
    const repo = engine.repositories.media;

    const presigned = await repo.getSignedUploadUrl('photo.png', 'image/png');
    primary.simulateExternalUpload(presigned.key, PNG, 'image/png');

    // processImage succeeds fully (writes __original + thumb); the
    // processing → ready CAS that would persist them throws. Before the fix
    // those two keys were stranded forever — nothing referenced them.
    type ClaimFn = typeof repo.claim;
    const originalClaim = repo.claim.bind(repo) as ClaimFn;
    const claimSpy = vi.spyOn(repo, 'claim');
    claimSpy.mockImplementation(((id, transition, patch, options) => {
      if ((transition as { to?: unknown }).to === 'ready' && patch !== undefined) {
        return Promise.reject(new Error('forced finalise failure'));
      }
      return originalClaim(id, transition, patch, options);
    }) as ClaimFn);

    try {
      const media = await repo.confirmUpload({
        key: presigned.key,
        filename: 'photo.png',
        mimeType: 'image/png',
        size: PNG.length,
        process: true,
      });
      // Non-blocking contract: the file is uploaded and the doc is valid
      expect(String(media._id)).toBeTruthy();
    } finally {
      claimSpy.mockRestore();
    }

    // Every reprocess-written variant was rolled back — only the object the
    // client uploaded remains, and the record is back in 'ready'.
    expect(await allKeys(primary)).toEqual([presigned.key]);
    const doc = await repo.getByQuery({ key: presigned.key });
    expect(doc?.status).toBe('ready');
    expect(doc?.variants ?? []).toEqual([]);

    await engine.dispose();
  });
});
