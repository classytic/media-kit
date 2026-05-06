/**
 * Integration tests — expiresAt + providerMetadata + purgeExpired + getExpiringSoon
 */

import { describe, it, expect, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createMedia } from '../../src/engine/create-media.js';
import { MemoryStorageDriver } from '../helpers/memory-driver.js';
import { teardownTestMongo } from '../helpers/create-test-engine.js';

const BUF = (s: string) => Buffer.from(s, 'utf-8');

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

afterAll(async () => {
  await teardownTestMongo();
  if (connection) { await connection.close(); connection = null; }
  if (mongo) { await mongo.stop(); mongo = null; }
});

beforeEach(async () => {
  await resetCollections();
});

// ── providerMetadata ──────────────────────────────────────────────────────────

describe('providerMetadata', () => {
  it('stores WriteResult.metadata on the media doc as providerMetadata', async () => {
    const conn = await getConnection();

    // MemoryStorageDriver does not return metadata — we inject a wrapper that does
    const base = new MemoryStorageDriver();
    const driver = Object.create(base, {
      write: {
        value: async (...args: Parameters<typeof base.write>) => {
          const result = await base.write(...args);
          return { ...result, metadata: { myCustomKey: 'abc', size: result.size } };
        },
      },
    }) as typeof base;

    const engine = await createMedia({
      connection: conn,
      driver,
      suppressWarnings: true,
      processing: { enabled: false },
    });

    const media = await engine.repositories.media.upload({
      buffer: BUF('hello'),
      filename: 'test.txt',
      mimeType: 'text/plain',
    });

    expect(media.providerMetadata).toBeDefined();
    expect(media.providerMetadata?.myCustomKey).toBe('abc');

    await engine.dispose();
  });

  it('providerMetadata is absent when driver returns no metadata', async () => {
    const conn = await getConnection();
    const engine = await createMedia({
      connection: conn,
      driver: new MemoryStorageDriver(),
      suppressWarnings: true,
      processing: { enabled: false },
    });

    const media = await engine.repositories.media.upload({
      buffer: BUF('hello'),
      filename: 'test.txt',
      mimeType: 'text/plain',
    });

    // MemoryStorageDriver doesn't return metadata — field absent
    expect(media.providerMetadata).toBeUndefined();

    await engine.dispose();
  });
});

// ── expiresAt ─────────────────────────────────────────────────────────────────

describe('expiresAt', () => {
  it('stores expiresAt on upload when provided', async () => {
    const conn = await getConnection();
    const engine = await createMedia({
      connection: conn,
      driver: new MemoryStorageDriver(),
      suppressWarnings: true,
      processing: { enabled: false },
    });

    const expires = new Date(Date.now() + 3600000); // 1 hour from now
    const media = await engine.repositories.media.upload({
      buffer: BUF('temp'),
      filename: 'temp.txt',
      mimeType: 'text/plain',
      expiresAt: expires,
    });

    expect(media.expiresAt).toBeDefined();
    expect(media.expiresAt!.getTime()).toBeCloseTo(expires.getTime(), -2);

    await engine.dispose();
  });

  it('expiresAt is absent when not provided', async () => {
    const conn = await getConnection();
    const engine = await createMedia({
      connection: conn,
      driver: new MemoryStorageDriver(),
      suppressWarnings: true,
      processing: { enabled: false },
    });

    const media = await engine.repositories.media.upload({
      buffer: BUF('normal'),
      filename: 'normal.txt',
      mimeType: 'text/plain',
    });

    expect(media.expiresAt ?? null).toBeNull();

    await engine.dispose();
  });
});

// ── purgeExpired ──────────────────────────────────────────────────────────────

describe('purgeExpired()', () => {
  it('hard-deletes expired assets from storage and DB', async () => {
    const conn = await getConnection();
    const driver = new MemoryStorageDriver();

    const engine = await createMedia({
      connection: conn,
      driver,
      suppressWarnings: true,
      processing: { enabled: false },
    });

    const past = new Date(Date.now() - 1000); // 1 second ago
    const media = await engine.repositories.media.upload({
      buffer: BUF('ephemeral'),
      filename: 'ephemeral.txt',
      mimeType: 'text/plain',
      expiresAt: past,
    });

    expect(await driver.exists(media.key)).toBe(true);

    const result = await engine.repositories.media.purgeExpired();

    expect(result.success).toContain(String(media._id));
    expect(result.failed).toHaveLength(0);
    expect(await driver.exists(media.key)).toBe(false);

    // Verify doc is gone
    const doc = await engine.repositories.media.getById(String(media._id), { throwOnNotFound: false } as any);
    expect(doc).toBeNull();

    await engine.dispose();
  });

  it('does not purge assets that have not expired yet', async () => {
    const conn = await getConnection();
    const driver = new MemoryStorageDriver();

    const engine = await createMedia({
      connection: conn,
      driver,
      suppressWarnings: true,
      processing: { enabled: false },
    });

    const future = new Date(Date.now() + 3600000);
    const media = await engine.repositories.media.upload({
      buffer: BUF('not-yet'),
      filename: 'not-yet.txt',
      mimeType: 'text/plain',
      expiresAt: future,
    });

    const result = await engine.repositories.media.purgeExpired();

    expect(result.success).not.toContain(String(media._id));
    expect(await driver.exists(media.key)).toBe(true);

    await engine.dispose();
  });

  it('does not purge assets without expiresAt', async () => {
    const conn = await getConnection();
    const driver = new MemoryStorageDriver();

    const engine = await createMedia({
      connection: conn,
      driver,
      suppressWarnings: true,
      processing: { enabled: false },
    });

    const media = await engine.repositories.media.upload({
      buffer: BUF('permanent'),
      filename: 'permanent.txt',
      mimeType: 'text/plain',
    });

    const result = await engine.repositories.media.purgeExpired();

    expect(result.success).not.toContain(String(media._id));
    expect(await driver.exists(media.key)).toBe(true);

    await engine.dispose();
  });

  it('purges only assets expired before a custom cutoff', async () => {
    const conn = await getConnection();
    const driver = new MemoryStorageDriver();

    const engine = await createMedia({
      connection: conn,
      driver,
      suppressWarnings: true,
      processing: { enabled: false },
    });

    const yesterday = new Date(Date.now() - 86400000);
    const hourAgo = new Date(Date.now() - 3600000);

    // Expires yesterday (before cutoff)
    const old = await engine.repositories.media.upload({
      buffer: BUF('old'),
      filename: 'old.txt',
      mimeType: 'text/plain',
      expiresAt: yesterday,
    });

    // Expires 30 minutes from now (after cutoff)
    const recent = await engine.repositories.media.upload({
      buffer: BUF('recent'),
      filename: 'recent.txt',
      mimeType: 'text/plain',
      expiresAt: new Date(Date.now() + 1800000),
    });

    // Run purge with cutoff = 1 hour ago
    const result = await engine.repositories.media.purgeExpired(hourAgo);

    expect(result.success).toContain(String(old._id));
    expect(result.success).not.toContain(String(recent._id));
    expect(await driver.exists(old.key)).toBe(false);
    expect(await driver.exists(recent.key)).toBe(true);

    await engine.dispose();
  });

  it('returns BulkResult with purgedIds and fires ASSETS_EXPIRED event', async () => {
    const conn = await getConnection();
    const driver = new MemoryStorageDriver();

    let expiredEvent: unknown = null;
    const engine = await createMedia({
      connection: conn,
      driver,
      suppressWarnings: true,
      processing: { enabled: false },
    });

    await engine.events.subscribe('media:assets.expired', async (event) => {
      expiredEvent = event;
    });

    const past = new Date(Date.now() - 1000);
    const media = await engine.repositories.media.upload({
      buffer: BUF('x'),
      filename: 'x.txt',
      mimeType: 'text/plain',
      expiresAt: past,
    });

    await engine.repositories.media.purgeExpired();

    expect(expiredEvent).not.toBeNull();
    const payload = (expiredEvent as any).payload;
    expect(payload.purgedIds).toContain(String(media._id));
    expect(payload.purgedCount).toBeGreaterThanOrEqual(1);
    expect(payload.failedCount).toBe(0);

    await engine.dispose();
  });
});

// ── getExpiringSoon ───────────────────────────────────────────────────────────

describe('getExpiringSoon()', () => {
  it('returns assets expiring within the given window', async () => {
    const conn = await getConnection();
    const engine = await createMedia({
      connection: conn,
      driver: new MemoryStorageDriver(),
      suppressWarnings: true,
      processing: { enabled: false },
    });

    // Expires in 30 minutes — within a 1-hour window
    const expiringSoon = await engine.repositories.media.upload({
      buffer: BUF('soon'),
      filename: 'soon.txt',
      mimeType: 'text/plain',
      expiresAt: new Date(Date.now() + 1800000),
    });

    // Expires in 3 hours — outside the 1-hour window
    await engine.repositories.media.upload({
      buffer: BUF('later'),
      filename: 'later.txt',
      mimeType: 'text/plain',
      expiresAt: new Date(Date.now() + 10800000),
    });

    // No expiry
    await engine.repositories.media.upload({
      buffer: BUF('never'),
      filename: 'never.txt',
      mimeType: 'text/plain',
    });

    const results = await engine.repositories.media.getExpiringSoon(1);

    const ids = results.map((m) => String(m._id));
    expect(ids).toContain(String(expiringSoon._id));
    expect(ids).not.toContain('later');
    expect(results.length).toBe(1);

    await engine.dispose();
  });

  it('returns empty array when nothing is expiring soon', async () => {
    const conn = await getConnection();
    const engine = await createMedia({
      connection: conn,
      driver: new MemoryStorageDriver(),
      suppressWarnings: true,
      processing: { enabled: false },
    });

    await engine.repositories.media.upload({
      buffer: BUF('x'),
      filename: 'x.txt',
      mimeType: 'text/plain',
    });

    const results = await engine.repositories.media.getExpiringSoon(1);
    expect(results).toHaveLength(0);

    await engine.dispose();
  });
});
