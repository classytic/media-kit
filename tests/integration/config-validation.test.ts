/**
 * Integration tests — createMedia() Zod config validation.
 *
 * Regression for the documented-but-unwired validation. The factory header
 * states "Validate config with Zod" but earlier versions only checked the
 * presence of `connection` and `driver`, letting bad shapes (negative
 * ttlDays, unknown fieldType) drift into resolved config and silently
 * change behaviour. These tests pin the now-active Zod parse step.
 */

import { afterAll, describe, expect, it } from 'vitest';
import mongoose, { type Connection } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createMedia } from '../../src/engine/create-media.js';
import { MemoryStorageDriver } from '../helpers/memory-driver.js';

let mongo: MongoMemoryServer | null = null;
let connection: Connection | null = null;

async function getConnection(): Promise<Connection> {
  if (connection && connection.readyState === 1) return connection;
  mongo = await MongoMemoryServer.create();
  connection = await mongoose.createConnection(mongo.getUri()).asPromise();
  return connection;
}

describe('createMedia() — Zod config validation', () => {
  afterAll(async () => {
    if (connection) await connection.close();
    if (mongo) await mongo.stop();
  });

  it('rejects negative ttlDays at config time', async () => {
    const conn = await getConnection();
    await expect(
      createMedia({
        connection: conn,
        driver: new MemoryStorageDriver(),
        softDelete: { enabled: true, ttlDays: -1 },
      }),
    ).rejects.toThrow();
  });

  it('rejects unknown tenant fieldType', async () => {
    const conn = await getConnection();
    await expect(
      createMedia({
        connection: conn,
        driver: new MemoryStorageDriver(),
        // biome-ignore lint/suspicious/noExplicitAny: deliberate bad-shape test
        tenant: { enabled: true, fieldType: 'wrong' as any },
      }),
    ).rejects.toThrow();
  });

  it('rejects empty allowed list on fileTypes', async () => {
    const conn = await getConnection();
    await expect(
      createMedia({
        connection: conn,
        driver: new MemoryStorageDriver(),
        fileTypes: { allowed: [] },
      }),
    ).rejects.toThrow();
  });

  it('rejects negative concurrency.maxConcurrent', async () => {
    const conn = await getConnection();
    await expect(
      createMedia({
        connection: conn,
        driver: new MemoryStorageDriver(),
        concurrency: { maxConcurrent: 0 },
      }),
    ).rejects.toThrow();
  });

  it('accepts valid config and applies defaults', async () => {
    const conn = await getConnection();
    const engine = await createMedia({
      connection: conn,
      driver: new MemoryStorageDriver(),
      softDelete: { enabled: true },
    });
    expect(engine.config.softDelete?.enabled).toBe(true);
    expect(engine.config.softDelete?.ttlDays).toBe(30); // schema default
    expect(engine.config.softDelete?.ttlIndex).toBe(false); // TTL index is opt-in
    await engine.dispose();
  });

  it('softDelete without ttlIndex creates NO TTL index (schema NOR collection — opt-in contract)', async () => {
    const conn = await getConnection();
    const engine = await createMedia({
      connection: conn,
      driver: new MemoryStorageDriver(),
      softDelete: { enabled: true, ttlDays: 30 },
    });
    // Schema level (buildMediaSchema gate)
    const ttl = engine.models.Media.schema
      .indexes()
      .filter(([, options]) => (options as Record<string, unknown> | undefined)?.expireAfterSeconds !== undefined);
    expect(ttl).toHaveLength(0);
    // Collection level — mongokit's softDeletePlugin({ ttlDays }) creates the
    // TTL index directly on the collection; ttlDays must NOT be forwarded
    // unless ttlIndex: true.
    await engine.models.Media.init();
    await new Promise((resolve) => setTimeout(resolve, 200)); // settle fire-and-forget createIndex
    const collectionIndexes = await engine.models.Media.collection.indexes();
    expect(collectionIndexes.filter((idx) => idx.expireAfterSeconds !== undefined)).toHaveLength(0);
    await engine.dispose();
  });

  it('softDelete.ttlIndex: true creates the deletedAt TTL index (ttlDays window)', async () => {
    const conn = await getConnection();
    const engine = await createMedia({
      connection: conn,
      driver: new MemoryStorageDriver(),
      softDelete: { enabled: true, ttlDays: 30, ttlIndex: true },
    });
    const ttl = engine.models.Media.schema
      .indexes()
      .filter(([, options]) => (options as Record<string, unknown> | undefined)?.expireAfterSeconds !== undefined);
    expect(ttl).toHaveLength(1);
    expect((ttl[0]![0] as Record<string, unknown>).deletedAt).toBe(1);
    expect((ttl[0]![1] as Record<string, unknown>).expireAfterSeconds).toBe(30 * 86400);
    // Collection level: schema index build (Model.init) + plugin createIndex
    // converge on the same spec.
    await engine.models.Media.init();
    const collectionIndexes = await engine.models.Media.collection.indexes();
    const ttlCollection = collectionIndexes.filter((idx) => idx.expireAfterSeconds !== undefined);
    expect(ttlCollection).toHaveLength(1);
    expect(ttlCollection[0]!.expireAfterSeconds).toBe(30 * 86400);
    expect(ttlCollection[0]!.key).toEqual({ deletedAt: 1 });
    await engine.dispose();
  });

  it('still requires connection + driver (zod parse runs after these checks)', async () => {
    await expect(
      // biome-ignore lint/suspicious/noExplicitAny: deliberate missing-field test
      createMedia({ driver: new MemoryStorageDriver() } as any),
    ).rejects.toThrow(/connection is required/);
    const conn = await getConnection();
    await expect(
      // biome-ignore lint/suspicious/noExplicitAny: deliberate missing-field test
      createMedia({ connection: conn } as any),
    ).rejects.toThrow(/driver or providers must be specified/);
  });
});
