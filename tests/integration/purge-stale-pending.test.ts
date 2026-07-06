/**
 * Integration tests — purgeStalePending() (crashed/abandoned upload sweep)
 *
 * upload() creates the DB row as status: 'pending' BEFORE writing to storage
 * and flips it to 'ready' at the end — a crash in between strands the row.
 * purgeStalePending() hard-deletes (storage + DB) pending rows older than the
 * cutoff (default 24h). Uses LocalProvider so the "storage object missing"
 * case exercises a real filesystem ENOENT path.
 */

import { describe, it, expect, afterAll, beforeEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createMedia } from '../../src/engine/create-media.js';
import type { MediaEngine } from '../../src/engine/engine-types.js';
import { LocalProvider } from '../../src/providers/local.provider.js';
import { STALE_PENDING_MAX_AGE_MS } from '../../src/repositories/media.repository.js';
import { MEDIA_EVENTS } from '../../src/events/event-constants.js';
import { teardownTestMongo } from '../helpers/create-test-engine.js';

const BUF = (s: string) => Buffer.from(s, 'utf-8');
const HOUR = 60 * 60 * 1000;

let mongo: MongoMemoryServer | null = null;
let connection: mongoose.Connection | null = null;
let baseDir: string | null = null;

async function getConnection(): Promise<mongoose.Connection> {
  if (connection && connection.readyState === 1) return connection;
  mongo = await MongoMemoryServer.create();
  connection = await mongoose.createConnection(mongo.getUri()).asPromise();
  return connection;
}

async function getBaseDir(): Promise<string> {
  if (!baseDir) baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'media-kit-stale-pending-'));
  return baseDir;
}

async function resetCollections(): Promise<void> {
  if (!connection) return;
  const collections = await connection.db?.collections();
  if (collections) for (const c of collections) await c.deleteMany({});
}

async function createEngine(): Promise<{ engine: MediaEngine; driver: LocalProvider }> {
  const conn = await getConnection();
  const driver = new LocalProvider({
    basePath: await getBaseDir(),
    baseUrl: 'http://localhost:3000/uploads',
  });
  const engine = await createMedia({
    connection: conn,
    driver,
    suppressWarnings: true,
    processing: { enabled: false },
  });
  return { engine, driver };
}

/**
 * Seed a media row via the normal upload flow (real stored file, status
 * 'ready'), then rewrite status/createdAt directly on the collection —
 * bypassing mongoose timestamps — to simulate a crashed upload of a given age.
 */
async function seedRow(
  engine: MediaEngine,
  name: string,
  opts: { status: 'pending' | 'ready'; ageMs: number },
): Promise<{ id: string; key: string }> {
  const media = await engine.repositories.media.upload({
    buffer: BUF(`content of ${name}`),
    filename: name,
    mimeType: 'text/plain',
  });
  await engine.models.Media.collection.updateOne(
    { _id: media._id },
    { $set: { status: opts.status, createdAt: new Date(Date.now() - opts.ageMs) } },
  );
  return { id: String(media._id), key: media.key };
}

afterAll(async () => {
  await teardownTestMongo();
  if (connection) { await connection.close(); connection = null; }
  if (mongo) { await mongo.stop(); mongo = null; }
  if (baseDir) { await fs.rm(baseDir, { recursive: true, force: true }); baseDir = null; }
});

beforeEach(async () => {
  await resetCollections();
});

describe('purgeStalePending()', () => {
  it('purges a stale pending row: DB row gone, stored file gone, returns 1', async () => {
    const { engine, driver } = await createEngine();

    const stale = await seedRow(engine, 'crashed.txt', { status: 'pending', ageMs: 25 * HOUR });
    expect(await driver.exists(stale.key)).toBe(true);

    const purged = await engine.repositories.media.purgeStalePending();

    expect(purged).toBe(1);
    expect(await driver.exists(stale.key)).toBe(false);
    const doc = await engine.models.Media.findById(stale.id);
    expect(doc).toBeNull();

    await engine.dispose();
  });

  it('leaves a fresh pending row untouched (default 24h cutoff)', async () => {
    const { engine, driver } = await createEngine();

    const fresh = await seedRow(engine, 'in-flight.txt', { status: 'pending', ageMs: 1 * HOUR });

    const purged = await engine.repositories.media.purgeStalePending();

    expect(purged).toBe(0);
    expect(await driver.exists(fresh.key)).toBe(true);
    const doc = await engine.models.Media.findById(fresh.id);
    expect(doc).not.toBeNull();

    await engine.dispose();
  });

  it('leaves a ready row older than the cutoff untouched', async () => {
    const { engine, driver } = await createEngine();

    const old = await seedRow(engine, 'old-but-ready.txt', { status: 'ready', ageMs: 30 * 24 * HOUR });

    const purged = await engine.repositories.media.purgeStalePending();

    expect(purged).toBe(0);
    expect(await driver.exists(old.key)).toBe(true);
    const doc = await engine.models.Media.findById(old.id);
    expect(doc).not.toBeNull();

    await engine.dispose();
  });

  it('removes the DB row without throwing when the storage object is missing', async () => {
    const { engine, driver } = await createEngine();

    const stale = await seedRow(engine, 'crashed-before-write.txt', { status: 'pending', ageMs: 25 * HOUR });
    // Simulate a crash BEFORE the storage write: remove the blob out-of-band.
    await driver.delete(stale.key);
    expect(await driver.exists(stale.key)).toBe(false);

    const purged = await engine.repositories.media.purgeStalePending();

    expect(purged).toBe(1);
    const doc = await engine.models.Media.findById(stale.id);
    expect(doc).toBeNull();

    await engine.dispose();
  });

  it('respects an explicit olderThan cutoff', async () => {
    const { engine } = await createEngine();

    await seedRow(engine, 'two-hours.txt', { status: 'pending', ageMs: 2 * HOUR });
    await seedRow(engine, 'thirty-minutes.txt', { status: 'pending', ageMs: HOUR / 2 });

    // Aggressive 1h cutoff: only the 2h-old row qualifies.
    const purged = await engine.repositories.media.purgeStalePending(new Date(Date.now() - HOUR));

    expect(purged).toBe(1);
    expect(await engine.models.Media.countDocuments({})).toBe(1);

    await engine.dispose();
  });

  it('publishes media:asset.purged with reason stale_pending', async () => {
    const { engine } = await createEngine();
    const handler = vi.fn();
    await engine.events.subscribe(MEDIA_EVENTS.ASSET_PURGED, handler);

    await seedRow(engine, 'crashed.txt', { status: 'pending', ageMs: 25 * HOUR });
    await engine.repositories.media.purgeStalePending();

    expect(handler).toHaveBeenCalledTimes(1);
    const event = handler.mock.calls[0]?.[0];
    expect(event.payload.count).toBe(1);
    expect(event.payload.reason).toBe('stale_pending');
    expect(event.payload.olderThan).toBeInstanceOf(Date);

    await engine.dispose();
  });

  it('does not publish media:asset.purged when nothing was stale', async () => {
    const { engine } = await createEngine();
    const handler = vi.fn();
    await engine.events.subscribe(MEDIA_EVENTS.ASSET_PURGED, handler);

    await seedRow(engine, 'fresh.txt', { status: 'pending', ageMs: HOUR });
    await engine.repositories.media.purgeStalePending();

    expect(handler).not.toHaveBeenCalled();

    await engine.dispose();
  });

  it('exports a documented 24h default staleness window', () => {
    expect(STALE_PENDING_MAX_AGE_MS).toBe(24 * 60 * 60 * 1000);
  });
});
