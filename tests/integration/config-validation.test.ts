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
