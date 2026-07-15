/**
 * Integration tests — multi-provider DATA INTEGRITY
 *
 * Regression suite for three silent-corruption bugs in multi-provider setups:
 *
 *   1. Ops layer hardwired the DEFAULT driver — processImage wrote the
 *      `__original` + size variants to the default provider while the main
 *      file went to `input.provider`'s backend; move()/renameFolder() copied
 *      and deleted every file through the default driver even when the docs
 *      spanned providers.
 *   2. AssetTransformService read bytes via the engine default driver — a
 *      non-default-provider asset 404'd or served from the wrong backend.
 *   3. replace() leaked the newly-written object (main + variants) when the
 *      DB update failed — no storage rollback.
 *
 * Uses two MemoryStorageDrivers under distinct registry keys and a stub
 * ImageAdapter so variant generation is deterministic without sharp.
 */

import { describe, it, expect, afterAll, beforeEach, vi } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createMedia } from '../../src/engine/create-media.js';
import type { MediaEngine } from '../../src/engine/engine-types.js';
import { createAssetTransform } from '../../src/transforms/asset-transform.js';
import { StorageTransformCache } from '../../src/transforms/transform-cache.js';
import type { ImageAdapter, ProcessedImage, ProcessingOptions, SizeVariant } from '../../src/types.js';
import { MemoryStorageDriver } from '../helpers/memory-driver.js';
import { createTestImageBuffer, teardownTestMongo } from '../helpers/create-test-engine.js';

const PNG = createTestImageBuffer();

/**
 * Deterministic ImageAdapter — echoes the input buffer, reports fixed
 * dimensions, and generates one buffer per requested size variant. Lets the
 * suite assert variant PLACEMENT (which driver got the bytes) without sharp.
 */
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
  primary: MemoryStorageDriver;
  secondary: MemoryStorageDriver;
}

/** Two-provider engine with processing + variants ('thumb') + __original. */
async function createRig(): Promise<Rig> {
  const conn = await getConnection();
  const primary = new MemoryStorageDriver();
  const secondary = new MemoryStorageDriver();
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

async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream as AsyncIterable<Buffer | string>) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/** Main key + every variant key of a media doc. */
function docKeys(media: { key: string; variants?: Array<{ key: string }> | undefined }): string[] {
  return [media.key, ...(media.variants ?? []).map((v) => v.key)];
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

// ── Bug 1 — upload/replace variants follow the input provider ────────────────

describe('upload({ provider }) — variants land in the SAME provider as the main file', () => {
  it('writes main + __original + every size variant to the secondary driver only', async () => {
    const { engine, primary, secondary } = await createRig();

    const media = await engine.repositories.media.upload({
      buffer: PNG,
      filename: 'photo.png',
      mimeType: 'image/png',
      provider: 'secondary',
    });

    expect(media.provider).toBe('secondary');
    const variantNames = (media.variants ?? []).map((v) => v.name).sort();
    expect(variantNames).toEqual(['__original', 'thumb']);

    for (const key of docKeys(media)) {
      expect(await secondary.exists(key)).toBe(true);
      expect(await primary.exists(key)).toBe(false);
    }
    // Default driver never touched at all
    expect(primary.size).toBe(0);
    expect(secondary.size).toBe(3); // main + __original + thumb

    await engine.dispose();
  });

  it('regression: default-provider upload keeps everything in the default driver', async () => {
    const { engine, primary, secondary } = await createRig();

    const media = await engine.repositories.media.upload({
      buffer: PNG,
      filename: 'photo.png',
      mimeType: 'image/png',
    });

    expect(media.provider).toBe('primary');
    for (const key of docKeys(media)) {
      expect(await primary.exists(key)).toBe(true);
    }
    expect(primary.size).toBe(3);
    expect(secondary.size).toBe(0);

    await engine.dispose();
  });
});

describe('replace() — provider-correct writes, deletes, and rollback', () => {
  it('replaces a secondary-provider doc entirely within the secondary driver', async () => {
    const { engine, primary, secondary } = await createRig();
    const repo = engine.repositories.media;

    const original = await repo.upload({
      buffer: PNG,
      filename: 'photo.png',
      mimeType: 'image/png',
      provider: 'secondary',
    });
    const oldKeys = docKeys(original);

    const replaced = await repo.replace(String(original._id), {
      buffer: Buffer.concat([PNG, Buffer.from('v2')]),
      filename: 'photo-v2.png',
      mimeType: 'image/png',
    });

    expect(replaced.provider).toBe('secondary');
    // New main + variants exist in secondary
    for (const key of docKeys(replaced)) {
      expect(await secondary.exists(key)).toBe(true);
    }
    // Old main + variants deleted from secondary
    for (const key of oldKeys) {
      expect(await secondary.exists(key)).toBe(false);
    }
    // Default driver never touched
    expect(primary.size).toBe(0);
    expect(secondary.size).toBe(3);

    await engine.dispose();
  });

  // ── Bug 3 — replace() rollback on DB-update failure ──────────────────────
  it('rolls back newly-written keys (main + variants) when the DB update throws', async () => {
    const { engine, primary, secondary } = await createRig();
    const repo = engine.repositories.media;

    const original = await repo.upload({
      buffer: PNG,
      filename: 'photo.png',
      mimeType: 'image/png',
      provider: 'secondary',
    });
    const keysBefore = await allKeys(secondary);

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

    // Every newly-written object rolled back from the CORRECT driver —
    // storage is byte-for-byte what it was before the failed replace.
    expect(await allKeys(secondary)).toEqual(keysBefore);
    expect(primary.size).toBe(0);

    // The doc still points at the OLD (live) object
    const after = await repo.getById(String(original._id), { throwOnNotFound: false });
    expect(after?.key).toBe(original.key);
    expect(await secondary.exists(original.key)).toBe(true);

    await engine.dispose();
  });

  it('rolls back via the correct driver when a DEFAULT-provider replace fails (regression)', async () => {
    const { engine, primary, secondary } = await createRig();
    const repo = engine.repositories.media;

    const original = await repo.upload({ buffer: PNG, filename: 'photo.png', mimeType: 'image/png' });
    const keysBefore = await allKeys(primary);

    const updateSpy = vi.spyOn(repo, 'update').mockRejectedValueOnce(new Error('forced DB failure'));
    try {
      await expect(
        repo.replace(String(original._id), { buffer: PNG, filename: 'p2.png', mimeType: 'image/png' }),
      ).rejects.toThrow('forced DB failure');
    } finally {
      updateSpy.mockRestore();
    }

    expect(await allKeys(primary)).toEqual(keysBefore);
    expect(secondary.size).toBe(0);

    await engine.dispose();
  });
});

// ── Bug 1 — move()/renameFolder() route per file ─────────────────────────────

describe('move() / renameFolder() — per-file driver routing over mixed providers', () => {
  it('move(): each file (and its variants) is copied + deleted within ITS OWN driver', async () => {
    const { engine, primary, secondary } = await createRig();
    const repo = engine.repositories.media;

    const onPrimary = await repo.upload({
      buffer: PNG,
      filename: 'a.png',
      mimeType: 'image/png',
      folder: 'shared',
    });
    const onSecondary = await repo.upload({
      buffer: PNG,
      filename: 'b.png',
      mimeType: 'image/png',
      folder: 'shared',
      provider: 'secondary',
    });

    const result = await repo.move([String(onPrimary._id), String(onSecondary._id)], 'archive');
    expect(result.failed).toEqual([]);
    expect(result.modifiedCount).toBe(2);

    const movedPrimary = await repo.getById(String(onPrimary._id), { throwOnNotFound: false });
    const movedSecondary = await repo.getById(String(onSecondary._id), { throwOnNotFound: false });
    expect(movedPrimary?.folder).toBe('archive');
    expect(movedSecondary?.folder).toBe('archive');

    // Each doc's new keys live in its own driver — zero cross-driver leakage
    for (const key of docKeys(movedPrimary!)) {
      expect(key.startsWith('archive/')).toBe(true);
      expect(await primary.exists(key)).toBe(true);
      expect(await secondary.exists(key)).toBe(false);
    }
    for (const key of docKeys(movedSecondary!)) {
      expect(key.startsWith('archive/')).toBe(true);
      expect(await secondary.exists(key)).toBe(true);
      expect(await primary.exists(key)).toBe(false);
    }

    // Old keys deleted from their own drivers; counts prove no orphans/copies
    for (const key of docKeys(onPrimary)) expect(await primary.exists(key)).toBe(false);
    for (const key of docKeys(onSecondary)) expect(await secondary.exists(key)).toBe(false);
    expect(primary.size).toBe(3);
    expect(secondary.size).toBe(3);

    await engine.dispose();
  });

  it('renameFolder(): mixed-provider folder rename keeps every file in its own driver', async () => {
    const { engine, primary, secondary } = await createRig();
    const repo = engine.repositories.media;

    const onPrimary = await repo.upload({
      buffer: PNG,
      filename: 'a.png',
      mimeType: 'image/png',
      folder: 'gallery',
    });
    const onSecondary = await repo.upload({
      buffer: PNG,
      filename: 'b.png',
      mimeType: 'image/png',
      folder: 'gallery',
      provider: 'secondary',
    });

    const result = await repo.renameFolder('gallery', 'portfolio');
    expect(result.failed).toEqual([]);
    expect(result.modifiedCount).toBe(2);

    const renamedPrimary = await repo.getById(String(onPrimary._id), { throwOnNotFound: false });
    const renamedSecondary = await repo.getById(String(onSecondary._id), { throwOnNotFound: false });

    for (const key of docKeys(renamedPrimary!)) {
      expect(key.startsWith('portfolio/')).toBe(true);
      expect(await primary.exists(key)).toBe(true);
      expect(await secondary.exists(key)).toBe(false);
    }
    for (const key of docKeys(renamedSecondary!)) {
      expect(key.startsWith('portfolio/')).toBe(true);
      expect(await secondary.exists(key)).toBe(true);
      expect(await primary.exists(key)).toBe(false);
    }
    expect(primary.size).toBe(3);
    expect(secondary.size).toBe(3);

    await engine.dispose();
  });
});

// ── operations/upload (the importFromUrl backend) honors `provider` ─────────

describe('operations upload — provider routing (importFromUrl backend)', () => {
  // importFromUrl delegates to operations/upload after its SSRF-guarded
  // fetch (which blocks local test servers — the provider→input threading
  // itself is unit-tested in tests/unit/url-import-provider.test.ts).
  // This exercises the storage-touching half end-to-end.
  it('routes main + variants to the named provider and stamps media.provider', async () => {
    const { engine, primary, secondary } = await createRig();
    const repo = engine.repositories.media;

    const { upload: opUpload } = await import('../../src/operations/upload.js');
    // Reach the internal deps the same way importFromUrl does — via the
    // repository's op-deps bridge (private, accessed for the test).
    const deps = (repo as unknown as { _opDeps: import('../../src/operations/types.js').OperationDeps })._opDeps;

    const media = await opUpload(deps, {
      buffer: PNG,
      filename: 'imported.png',
      mimeType: 'image/png',
      provider: 'secondary',
    });

    expect(media.provider).toBe('secondary');
    for (const key of docKeys(media)) {
      expect(await secondary.exists(key)).toBe(true);
      expect(await primary.exists(key)).toBe(false);
    }
    expect(primary.size).toBe(0);

    await engine.dispose();
  });
});

// ── Bug 2 — AssetTransformService serves from the doc's own provider ─────────

describe('AssetTransformService — per-doc provider routing', () => {
  it('raw serve of a secondary-provider doc streams from the secondary driver only', async () => {
    const { engine, primary, secondary } = await createRig();
    const repo = engine.repositories.media;

    const media = await repo.upload({
      buffer: PNG,
      filename: 'photo.png',
      mimeType: 'image/png',
      provider: 'secondary',
    });

    const primaryRead = vi.spyOn(primary, 'read');
    const secondaryRead = vi.spyOn(secondary, 'read');

    const service = createAssetTransform({ media: engine });
    const res = await service.handle({ fileId: String(media._id), params: {} });

    expect(res.status).toBe(200);
    expect((await streamToBuffer(res.stream)).equals(PNG)).toBe(true);
    expect(secondaryRead).toHaveBeenCalledWith(media.key);
    expect(primaryRead).not.toHaveBeenCalled();

    await engine.dispose();
  });

  it('variant serve of a secondary-provider doc streams from the secondary driver only', async () => {
    const { engine, primary, secondary } = await createRig();
    const repo = engine.repositories.media;

    const media = await repo.upload({
      buffer: PNG,
      filename: 'photo.png',
      mimeType: 'image/png',
      provider: 'secondary',
    });
    const thumb = (media.variants ?? []).find((v) => v.name === 'thumb');
    expect(thumb).toBeDefined();

    const primaryRead = vi.spyOn(primary, 'read');
    const secondaryRead = vi.spyOn(secondary, 'read');

    const service = createAssetTransform({ media: engine });
    const res = await service.handle({ fileId: String(media._id), params: {}, variant: 'thumb' });

    expect(res.status).toBe(200);
    expect(secondaryRead).toHaveBeenCalledWith(thumb!.key);
    expect(primaryRead).not.toHaveBeenCalled();

    await engine.dispose();
  });

  it('regression: without a resolver (manual v2 construction) reads fall back to media.driver', async () => {
    const { engine, primary } = await createRig();
    const repo = engine.repositories.media;

    const media = await repo.upload({ buffer: PNG, filename: 'photo.png', mimeType: 'image/png' });

    const primaryRead = vi.spyOn(primary, 'read');
    // v2-style source: single driver + legacy getById, NO resolveDriver
    const service = createAssetTransform({
      media: { driver: primary, getById: (id: string) => repo.getMediaById(id) },
    });
    const res = await service.handle({ fileId: String(media._id), params: {} });

    expect(res.status).toBe(200);
    expect((await streamToBuffer(res.stream)).equals(PNG)).toBe(true);
    expect(primaryRead).toHaveBeenCalledWith(media.key);

    await engine.dispose();
  });

  it('transform cache stays on ITS OWN driver (engine default) and get/set are consistent', async () => {
    let sharpAvailable = true;
    try {
      await import('sharp');
    } catch {
      sharpAvailable = false;
    }
    if (!sharpAvailable) return; // sharp unavailable — transform path untestable here

    const { engine, primary, secondary } = await createRig();
    const repo = engine.repositories.media;

    const media = await repo.upload({
      buffer: PNG,
      filename: 'photo.png',
      mimeType: 'image/png',
      provider: 'secondary',
    });

    const secondaryRead = vi.spyOn(secondary, 'read');
    const cache = new StorageTransformCache(primary); // engine-default-owned cache
    const service = createAssetTransform({ media: engine, cache });

    const req = { fileId: String(media._id), params: { w: '1', format: 'jpeg' } };
    const first = await service.handle(req);
    expect(first.status).toBe(200);
    // Content-Type must be IN headers — hosts iterate `result.headers`
    // verbatim (the documented integration), so the top-level contentType
    // field alone ships a typeless response.
    expect(first.headers['Content-Type']).toBe('image/jpeg');
    // Source bytes came from the doc's own provider
    expect(secondaryRead).toHaveBeenCalledTimes(1);
    expect(secondaryRead).toHaveBeenCalledWith(media.key);

    // Cache write is fire-and-forget — wait for the __transforms/ key to land
    const cachedKey = await vi.waitFor(async () => {
      const keys = (await allKeys(primary)).filter((k) => k.startsWith('__transforms/'));
      expect(keys.length).toBe(1);
      return keys[0]!;
    });
    expect(cachedKey.startsWith('__transforms/')).toBe(true);
    // Cache lives in the cache's own driver, never the source doc's
    expect((await allKeys(secondary)).some((k) => k.startsWith('__transforms/'))).toBe(false);

    // Second request: served from the cache (same driver it was written to);
    // the source provider is not read again.
    const second = await service.handle(req);
    expect(second.status).toBe(200);
    expect(second.headers['Content-Type']).toBe('image/jpeg'); // cache-hit path too
    expect(secondaryRead).toHaveBeenCalledTimes(1);

    await engine.dispose();
  });
});
