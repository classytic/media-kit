/**
 * Storage/DB consistency contract for destructive verbs.
 *
 *   - hardDelete claims a `deleting` tombstone BEFORE touching storage, so a
 *     crash mid-delete leaves a visible tombstone (never a "ready" doc whose
 *     bytes are gone), and purgeStalePending re-drives it to completion.
 *   - destructive verbs REJECT an externally-managed ctx.session (they mutate
 *     object storage, which can't roll back with a host transaction).
 */

import { describe, it, expect, afterAll } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { bindMediaFlat as createMedia } from '../helpers/create-test-engine.js';
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

async function engineWith() {
  const conn = await getConnection();
  const driver = new MemoryStorageDriver();
  const engine = await createMedia({ connection: conn, driver, suppressWarnings: true, processing: { enabled: false } });
  return { engine, driver };
}

describe('destructive verbs — storage/DB consistency', () => {
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

  it('hardDelete removes the doc AND the bytes on the happy path', async () => {
    const { engine, driver } = await engineWith();
    const media = await engine.repositories.media.upload({ buffer: BUF('x'), filename: 'x.txt', mimeType: 'text/plain' });
    expect(await driver.exists(media.key)).toBe(true);

    expect(await engine.repositories.media.hardDelete(String(media._id))).toBe(true);
    expect(await driver.exists(media.key)).toBe(false);
    expect(await engine.repositories.media.getById(String(media._id), { throwOnNotFound: false } as never)).toBeNull();

    await engine.close();
  });

  it('a crash AFTER the tombstone claim leaves a `deleting` doc that the sweep finishes', async () => {
    const { engine, driver } = await engineWith();
    const media = await engine.repositories.media.upload({ buffer: BUF('boom'), filename: 'b.txt', mimeType: 'text/plain' });
    const id = String(media._id);
    const repo = engine.repositories.media;

    // Simulate a crash right after the tombstone claim: the storage delete
    // "fails" (process dies) so the row is stuck in `deleting` with bytes still
    // present — the exact partial state the tombstone exists to make safe.
    const realDelete = driver.delete.bind(driver);
    driver.delete = async () => {
      throw new Error('process crashed mid-delete');
    };
    await expect(repo.hardDelete(id)).rejects.toThrow(/crashed/);

    // The doc is a visible tombstone (NOT "ready" pointing at soon-gone bytes).
    const tombstone = await repo.getById(id, { includeDeleted: true, throwOnNotFound: false } as never);
    expect(tombstone?.status).toBe('deleting');

    // Recover: storage works again; the stale-pending sweep re-drives the
    // tombstone (cutoff in the future so it's considered stale now).
    driver.delete = realDelete;
    const purged = await repo.purgeStalePending(new Date(Date.now() + 60_000));
    expect(purged).toBeGreaterThanOrEqual(1);

    expect(await driver.exists(media.key)).toBe(false);
    expect(await repo.getById(id, { includeDeleted: true, throwOnNotFound: false } as never)).toBeNull();

    await engine.close();
  });

  it('hardDelete rejects an externally-managed ctx.session (400, no storage touched)', async () => {
    const { engine, driver } = await engineWith();
    const media = await engine.repositories.media.upload({ buffer: BUF('keep'), filename: 'k.txt', mimeType: 'text/plain' });

    await expect(
      engine.repositories.media.hardDelete(String(media._id), { session: {} } as never),
    ).rejects.toMatchObject({ status: 400, code: 'media.tx.external_session_unsupported' });

    // The bytes and doc are untouched — the guard fired before any effect.
    expect(await driver.exists(media.key)).toBe(true);

    await engine.close();
  });

  it('replace rejects an externally-managed ctx.session (400)', async () => {
    const { engine } = await engineWith();
    const media = await engine.repositories.media.upload({ buffer: BUF('v1'), filename: 'r.txt', mimeType: 'text/plain' });

    await expect(
      engine.repositories.media.replace(String(media._id), { buffer: BUF('v2'), filename: 'r.txt', mimeType: 'text/plain' }, { session: {} } as never),
    ).rejects.toMatchObject({ status: 400, code: 'media.tx.external_session_unsupported' });

    await engine.close();
  });
});
