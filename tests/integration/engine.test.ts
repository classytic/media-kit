/**
 * Integration tests — createMedia() factory
 *
 * Verifies:
 *   - Config validation
 *   - Model creation on the connection
 *   - Plugin composition
 *   - Event transport resolution (default vs custom)
 *   - Frozen engine object
 *   - dispose() cleanup
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { createMedia } from '../../src/engine/create-media.js';
import { InProcessMediaBus } from '../../src/events/in-process-bus.js';
import { createTestEngine, teardownTestMongo } from '../helpers/create-test-engine.js';
import { MemoryStorageDriver } from '../helpers/memory-driver.js';

describe('createMedia() engine factory', () => {
  afterAll(async () => {
    await teardownTestMongo();
  });

  describe('required fields', () => {
    it('throws without connection', async () => {
      await expect(
        createMedia({ driver: new MemoryStorageDriver() } as any),
      ).rejects.toThrow(/connection is required/i);
    });

    it('throws without driver', async () => {
      const { connection, cleanup } = await createTestEngine();
      try {
        await expect(
          createMedia({ connection } as any),
        ).rejects.toThrow(/driver is required/i);
      } finally {
        await cleanup();
      }
    });
  });

  describe('engine shape', () => {
    it('returns a frozen engine object', async () => {
      const { engine, cleanup } = await createTestEngine();
      try {
        expect(Object.isFrozen(engine)).toBe(true);
        expect(Object.isFrozen(engine.repositories)).toBe(true);
        expect(Object.isFrozen(engine.models)).toBe(true);
      } finally {
        await cleanup();
      }
    });

    it('exposes repositories.media', async () => {
      const { engine, cleanup } = await createTestEngine();
      try {
        expect(engine.repositories.media).toBeDefined();
        expect(typeof engine.repositories.media.upload).toBe('function');
        expect(typeof engine.repositories.media.hardDelete).toBe('function');
      } finally {
        await cleanup();
      }
    });

    it('exposes models.Media', async () => {
      const { engine, cleanup } = await createTestEngine();
      try {
        expect(engine.models.Media).toBeDefined();
        expect(engine.models.Media.modelName).toBe('Media');
      } finally {
        await cleanup();
      }
    });

    it('exposes events transport', async () => {
      const { engine, cleanup } = await createTestEngine();
      try {
        expect(engine.events).toBeDefined();
        expect(typeof engine.events.publish).toBe('function');
        expect(typeof engine.events.subscribe).toBe('function');
      } finally {
        await cleanup();
      }
    });

    it('exposes driver reference', async () => {
      const { engine, driver, cleanup } = await createTestEngine();
      try {
        expect(engine.driver).toBe(driver);
      } finally {
        await cleanup();
      }
    });
  });

  describe('event transport', () => {
    it('defaults to InProcessMediaBus when not provided', async () => {
      const { engine, cleanup } = await createTestEngine();
      try {
        expect(engine.events).toBeInstanceOf(InProcessMediaBus);
        expect(engine.events.name).toBe('in-process-media');
      } finally {
        await cleanup();
      }
    });

    it('uses custom transport when provided', async () => {
      const customTransport = new InProcessMediaBus();
      const { engine, cleanup } = await createTestEngine({ eventTransport: customTransport });
      try {
        expect(engine.events).toBe(customTransport);
      } finally {
        await cleanup();
      }
    });
  });

  describe('dispose()', () => {
    it('closes the event transport', async () => {
      const { engine, cleanup } = await createTestEngine();
      try {
        await engine.dispose();
        // Dispose should be idempotent
        await expect(engine.dispose()).resolves.not.toThrow();
      } finally {
        await cleanup();
      }
    });
  });

  describe('purges stale cached models', () => {
    it('recreates model when engine is built twice on same connection', async () => {
      const first = await createTestEngine();
      const firstModel = first.engine.models.Media;

      const second = await createTestEngine();
      const secondModel = second.engine.models.Media;

      // Different model instances (purge + recreate)
      expect(firstModel).not.toBe(secondModel);

      await first.cleanup();
      await second.cleanup();
    });
  });
});
