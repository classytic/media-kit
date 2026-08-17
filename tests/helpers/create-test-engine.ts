/**
 * Test engine factory — creates a fully-wired MediaEngine with:
 *   - MongoDB memory server connection
 *   - In-memory storage driver
 *   - No image processing (to avoid Sharp dependency in unit tests)
 *
 * Use in tests like:
 *   const { engine, driver, cleanup } = await createTestEngine({ ... });
 *   await engine.repositories.media.upload(...);
 *   await cleanup();
 */

import mongoose, { type Connection } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { defineMedia } from '../../src/engine/define-media.js';
import type { MediaEngine, MediaRuntime, MediaShape } from '../../src/engine/engine-types.js';
import { MemoryStorageDriver } from './memory-driver.js';

/** Flat test options — split into describe-time shape + bind-time runtime below. */
export interface TestEngineOptions extends Partial<MediaShape & Omit<MediaRuntime, 'driver'>> {}

/**
 * TEST INFRA ONLY — routes a flat config through the real `defineMedia(shape).bind(conn, runtime)`.
 *
 * This is NOT a package shim (the package has no `createMedia`): it lives in tests so call sites
 * that construct an engine — including ones that deliberately probe bad shapes / missing fields —
 * stay readable as a single object. It splits the flat object into the standard shape/runtime
 * halves and forwards to the real blueprint API.
 */
export function bindMediaFlat(
  flat: { connection?: Connection } & Partial<MediaShape & MediaRuntime> = {},
): Promise<MediaEngine> {
  const {
    connection,
    driver,
    providers,
    defaultProvider,
    eventTransport,
    bridges,
    cache,
    logger,
    plugins,
    pagination,
    authorize,
    ...shape
  } = flat;

  const runtime: MediaRuntime = {
    ...(driver !== undefined ? { driver } : {}),
    ...(providers !== undefined ? { providers } : {}),
    ...(defaultProvider !== undefined ? { defaultProvider } : {}),
    ...(eventTransport !== undefined ? { eventTransport } : {}),
    ...(bridges !== undefined ? { bridges } : {}),
    ...(cache !== undefined ? { cache } : {}),
    ...(logger !== undefined ? { logger } : {}),
    ...(plugins !== undefined ? { plugins } : {}),
    ...(pagination !== undefined ? { pagination } : {}),
    ...(authorize !== undefined ? { authorize } : {}),
  };

  // Default to the `replace` collision policy: these suites reuse a single connection across
  // many binds, exactly the case the old unconditional model purge covered. An explicit
  // `forceRecreate` in the flat config still wins.
  return defineMedia({ forceRecreate: true, ...shape }).bind(connection as Connection, runtime);
}

export interface TestEngineHandle {
  engine: MediaEngine;
  driver: MemoryStorageDriver;
  connection: Connection;
  cleanup(): Promise<void>;
}

let sharedMongo: MongoMemoryServer | null = null;
let sharedConnection: Connection | null = null;

async function getSharedConnection(): Promise<Connection> {
  if (sharedConnection && sharedConnection.readyState === 1) {
    return sharedConnection;
  }
  sharedMongo = await MongoMemoryServer.create();
  const uri = sharedMongo.getUri();
  sharedConnection = await mongoose.createConnection(uri).asPromise();
  return sharedConnection;
}

export async function createTestEngine(
  options: TestEngineOptions = {},
): Promise<TestEngineHandle> {
  const connection = await getSharedConnection();
  const driver = new MemoryStorageDriver();

  // Split the flat options into bind-time runtime collaborators vs describe-time shape.
  const { providers, defaultProvider, eventTransport, bridges, cache, logger, plugins, pagination, authorize, ...shape } =
    options;

  const runtime: MediaRuntime = {
    driver,
    ...(providers !== undefined ? { providers } : {}),
    ...(defaultProvider !== undefined ? { defaultProvider } : {}),
    ...(eventTransport !== undefined ? { eventTransport } : {}),
    ...(bridges !== undefined ? { bridges } : {}),
    ...(cache !== undefined ? { cache } : {}),
    ...(logger !== undefined ? { logger } : {}),
    ...(plugins !== undefined ? { plugins } : {}),
    ...(pagination !== undefined ? { pagination } : {}),
    ...(authorize !== undefined ? { authorize } : {}),
  };

  const engine = await defineMedia({
    suppressWarnings: true,
    // The shared connection is reused across the whole suite, so every rebuild re-registers
    // the Media model — opt into mongokit's `replace` policy (test/dev) instead of throwing.
    forceRecreate: true,
    ...shape,
    processing: { enabled: false, ...(shape.processing ?? {}) },
  }).bind(connection, runtime);

  return {
    engine,
    driver,
    connection,
    async cleanup() {
      await engine.close();
      // Drop all collections to reset state between tests
      const collections = await connection.db?.collections();
      if (collections) {
        for (const collection of collections) {
          await collection.deleteMany({});
        }
      }
    },
  };
}

/**
 * Teardown — call in global afterAll to shut down the shared memory server.
 */
export async function teardownTestMongo(): Promise<void> {
  if (sharedConnection) {
    await sharedConnection.close();
    sharedConnection = null;
  }
  if (sharedMongo) {
    await sharedMongo.stop();
    sharedMongo = null;
  }
}

/**
 * Create a minimal test file buffer (1x1 PNG).
 */
export function createTestImageBuffer(): Buffer {
  // 1x1 transparent PNG — generated by sharp itself (the previous
  // hand-crafted bytes carried a malformed zlib stream that older libpng
  // tolerated; sharp 0.35's libpng correctly rejects it).
  return Buffer.from(
    '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489' +
      '0000000970485973000003e8000003e801b57b526b' +
      '0000000d494441540899636060606000000005000187a14ed4' +
      '0000000049454e44ae426082',
    'hex',
  );
}
