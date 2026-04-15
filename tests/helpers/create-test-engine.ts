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
import { createMedia } from '../../src/engine/create-media.js';
import type { MediaEngine, MediaConfig } from '../../src/engine/engine-types.js';
import type { EventTransport } from '../../src/events/transport.js';
import { MemoryStorageDriver } from './memory-driver.js';

export interface TestEngineOptions extends Partial<Omit<MediaConfig, 'connection' | 'driver'>> {
  eventTransport?: EventTransport;
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

  const engine = await createMedia({
    connection,
    driver,
    suppressWarnings: true,
    processing: { enabled: false, ...(options.processing ?? {}) },
    ...options,
  });

  return {
    engine,
    driver,
    connection,
    async cleanup() {
      await engine.dispose();
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
  // 1x1 transparent PNG
  return Buffer.from(
    '89504e470d0a1a0a0000000d4948445200000001000000010806000000' +
      '1f15c4890000000d49444154789c636060606000000005000178a3d6' +
      '440000000049454e44ae426082',
    'hex',
  );
}
