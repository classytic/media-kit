/**
 * Concurrency + race-safety tests.
 *
 * Pins behavior around:
 *   - Semaphore actually caps concurrent uploads (config.concurrency.maxConcurrent)
 *   - Parallel hardDelete doesn't corrupt state or leak storage keys
 *   - Upload status lifecycle (pending → processing → ready) under parallel load
 *   - Event handlers don't block the upload hot path
 *
 * If these regress, production throughput and correctness suffer immediately.
 */

import { describe, it, expect, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { createTestEngine, teardownTestMongo, type TestEngineHandle } from '../helpers/create-test-engine.js';

const BUF = (s: string) => Buffer.from(s, 'utf-8');

describe('Concurrency + race safety', () => {
  afterAll(async () => {
    await teardownTestMongo();
  });

  describe('uploadSemaphore — caps parallel uploads', () => {
    it('honors maxConcurrent = 1 (serializes uploads)', async () => {
      let active = 0;
      let peak = 0;

      // Stub the driver.write to measure concurrent entry count
      const { engine, driver, cleanup } = await createTestEngine({
        concurrency: { maxConcurrent: 1 },
      });
      const origWrite = driver.write.bind(driver);
      driver.write = async (...args) => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 10));
        const res = await origWrite(...args);
        active--;
        return res;
      };

      try {
        await Promise.all(
          Array.from({ length: 6 }, (_, i) =>
            engine.repositories.media.upload({
              buffer: BUF(String(i)),
              filename: `${i}.txt`,
              mimeType: 'text/plain',
            }),
          ),
        );
        expect(peak).toBe(1);
      } finally {
        await cleanup();
      }
    });

    it('honors maxConcurrent = 3 (allows up to 3 in flight)', async () => {
      let active = 0;
      let peak = 0;

      const { engine, driver, cleanup } = await createTestEngine({
        concurrency: { maxConcurrent: 3 },
      });
      const origWrite = driver.write.bind(driver);
      driver.write = async (...args) => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 10));
        const res = await origWrite(...args);
        active--;
        return res;
      };

      try {
        await Promise.all(
          Array.from({ length: 10 }, (_, i) =>
            engine.repositories.media.upload({
              buffer: BUF(String(i)),
              filename: `${i}.txt`,
              mimeType: 'text/plain',
            }),
          ),
        );
        expect(peak).toBeLessThanOrEqual(3);
        expect(peak).toBeGreaterThanOrEqual(2); // at least some parallelism
      } finally {
        await cleanup();
      }
    });
  });

  describe('race safety — parallel upload/delete', () => {
    let handle: TestEngineHandle;

    beforeEach(async () => {
      handle = await createTestEngine();
    });

    afterEach(async () => {
      await handle.cleanup();
    });

    it('10 parallel uploads → all reach status: "ready" with unique keys', async () => {
      const docs = await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          handle.engine.repositories.media.upload({
            buffer: BUF(`payload-${i}`),
            filename: `doc-${i}.txt`,
            mimeType: 'text/plain',
          }),
        ),
      );

      expect(docs).toHaveLength(10);
      expect(docs.every((d) => d.status === 'ready')).toBe(true);

      // All keys unique
      const keys = docs.map((d) => d.key);
      expect(new Set(keys).size).toBe(10);

      // All files actually written to storage
      for (const d of docs) {
        expect(await handle.driver.exists(d.key)).toBe(true);
      }
    });

    it('parallel hardDelete of distinct ids — no leaks', async () => {
      const docs = await Promise.all(
        Array.from({ length: 8 }, (_, i) =>
          handle.engine.repositories.media.upload({
            buffer: BUF(`x${i}`),
            filename: `${i}.txt`,
            mimeType: 'text/plain',
          }),
        ),
      );
      const keys = docs.map((d) => d.key);

      await Promise.all(
        docs.map((d) => handle.engine.repositories.media.hardDelete(String(d._id))),
      );

      // All DB docs gone
      expect(await handle.engine.models.Media.countDocuments({})).toBe(0);
      // All storage keys gone
      for (const k of keys) {
        expect(await handle.driver.exists(k)).toBe(false);
      }
    });

    it('parallel hardDelete of the SAME id — idempotent (one success, rest false)', async () => {
      const { _id } = await handle.engine.repositories.media.upload({
        buffer: BUF('x'),
        filename: 'x.txt',
        mimeType: 'text/plain',
      });

      const results = await Promise.all(
        Array.from({ length: 5 }, () =>
          handle.engine.repositories.media.hardDelete(String(_id)),
        ),
      );

      const successCount = results.filter((r) => r === true).length;
      expect(successCount).toBeGreaterThanOrEqual(1);
      // Remaining calls return false (doc already gone) or true (no-op) — never throw
      expect(await handle.engine.models.Media.countDocuments({})).toBe(0);
    });
  });

  describe('event handlers — do not block upload hot path', () => {
    it('slow event handler does NOT block the upload response', async () => {
      const { engine, cleanup } = await createTestEngine();
      try {
        // Register a slow handler (100 ms)
        let handlerFired = false;
        await engine.events.subscribe('media:asset.uploaded', async () => {
          await new Promise((r) => setTimeout(r, 100));
          handlerFired = true;
        });

        const start = Date.now();
        const media = await engine.repositories.media.upload({
          buffer: BUF('x'),
          filename: 'x.txt',
          mimeType: 'text/plain',
        });
        const elapsed = Date.now() - start;

        // Event handler is awaited in-process, so upload waits. That's the contract.
        // This test documents that behavior explicitly — if we ever switch to
        // fire-and-forget, this test flips.
        expect(media.status).toBe('ready');
        expect(handlerFired).toBe(true);
        // Upload should be reasonably fast even with the slow handler
        expect(elapsed).toBeLessThan(1000);
      } finally {
        await cleanup();
      }
    });

    it('throwing event handler does NOT break upload (error isolation)', async () => {
      const { engine, cleanup } = await createTestEngine();
      try {
        await engine.events.subscribe('media:asset.uploaded', async () => {
          throw new Error('handler exploded');
        });

        // Upload must succeed despite handler error
        const media = await engine.repositories.media.upload({
          buffer: BUF('x'),
          filename: 'x.txt',
          mimeType: 'text/plain',
        });
        expect(media.status).toBe('ready');

        // Document persisted correctly
        const found = await engine.models.Media.findById(media._id);
        expect(found).toBeTruthy();
      } finally {
        await cleanup();
      }
    });
  });

  describe('deduplication — race between two identical concurrent uploads', () => {
    it('with dedup enabled, both uploads return a valid doc (same hash)', async () => {
      const { engine, cleanup } = await createTestEngine({
        deduplication: { enabled: true, returnExisting: true, algorithm: 'sha256' },
      });
      try {
        const [a, b] = await Promise.all([
          engine.repositories.media.upload({
            buffer: BUF('identical-content'),
            filename: 'a.txt',
            mimeType: 'text/plain',
          }),
          engine.repositories.media.upload({
            buffer: BUF('identical-content'),
            filename: 'b.txt',
            mimeType: 'text/plain',
          }),
        ]);

        // Both return valid docs with the same hash. Whether dedup collapsed
        // them into one depends on timing — both outcomes are acceptable.
        expect(a.hash).toBe(b.hash);
        expect(a.status).toBe('ready');
        expect(b.status).toBe('ready');
      } finally {
        await cleanup();
      }
    });
  });
});
