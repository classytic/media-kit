import { describe, it, expect, vi } from 'vitest';
import { Semaphore, SemaphoreOverloadError, SemaphoreAcquireError } from '../../src/utils/semaphore';

describe('Semaphore', () => {
  describe('constructor', () => {
    it('should create semaphore with specified max slots', () => {
      const sem = new Semaphore(3);
      expect(sem).toBeDefined();
    });
  });

  describe('acquire/release', () => {
    it('should acquire immediately when slots available', async () => {
      const sem = new Semaphore(2);

      // Should resolve immediately
      await sem.acquire();
      await sem.acquire();

      // Release both
      sem.release();
      sem.release();
    });

    it('should wait when all slots are taken', async () => {
      const sem = new Semaphore(1);
      const order: number[] = [];

      // Take the only slot
      await sem.acquire();
      order.push(1);

      // This should wait
      const waitPromise = sem.acquire().then(() => {
        order.push(3);
      });

      // Give time to ensure waitPromise is queued
      await new Promise((r) => setTimeout(r, 10));
      order.push(2);

      // Release to allow waitPromise to proceed
      sem.release();
      await waitPromise;

      expect(order).toEqual([1, 2, 3]);
    });

    it('should process queue in FIFO order', async () => {
      const sem = new Semaphore(1);
      const order: string[] = [];

      await sem.acquire();

      const p1 = sem.acquire().then(() => order.push('first'));
      const p2 = sem.acquire().then(() => order.push('second'));
      const p3 = sem.acquire().then(() => order.push('third'));

      // Release one by one
      sem.release();
      await p1;

      sem.release();
      await p2;

      sem.release();
      await p3;

      expect(order).toEqual(['first', 'second', 'third']);
    });
  });

  describe('run', () => {
    it('should execute function and auto-release on success', async () => {
      const sem = new Semaphore(1);
      const fn = vi.fn().mockResolvedValue('result');

      const result = await sem.run(fn);

      expect(result).toBe('result');
      expect(fn).toHaveBeenCalledOnce();

      // Should be able to acquire again (slot was released)
      await sem.acquire();
      sem.release();
    });

    it('should auto-release on error', async () => {
      const sem = new Semaphore(1);
      const error = new Error('test error');
      const fn = vi.fn().mockRejectedValue(error);

      await expect(sem.run(fn)).rejects.toThrow('test error');

      // Should be able to acquire again (slot was released despite error)
      await sem.acquire();
      sem.release();
    });

    it('should limit concurrent executions', async () => {
      const sem = new Semaphore(2);
      let concurrent = 0;
      let maxConcurrent = 0;

      const task = async (id: number) => {
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await new Promise((r) => setTimeout(r, 50));
        concurrent--;
        return id;
      };

      // Start 5 tasks with max 2 concurrent
      const results = await Promise.all([
        sem.run(() => task(1)),
        sem.run(() => task(2)),
        sem.run(() => task(3)),
        sem.run(() => task(4)),
        sem.run(() => task(5)),
      ]);

      expect(results).toEqual([1, 2, 3, 4, 5]);
      expect(maxConcurrent).toBe(2);
    });
  });

  describe('edge cases', () => {
    it('should handle semaphore with max 1 (mutex)', async () => {
      const sem = new Semaphore(1);
      const results: number[] = [];

      await Promise.all([
        sem.run(async () => {
          await new Promise((r) => setTimeout(r, 20));
          results.push(1);
        }),
        sem.run(async () => {
          await new Promise((r) => setTimeout(r, 10));
          results.push(2);
        }),
      ]);

      // First task finishes before second starts
      expect(results).toEqual([1, 2]);
    });

    it('should not exceed max even with rapid acquire/release', async () => {
      const sem = new Semaphore(3);

      // Acquire 3
      await sem.acquire();
      await sem.acquire();
      await sem.acquire();

      // Release all
      sem.release();
      sem.release();
      sem.release();

      // Extra releases should not increase available beyond max
      sem.release();
      sem.release();

      // Should still only allow 3 concurrent
      await sem.acquire();
      await sem.acquire();
      await sem.acquire();

      // Fourth should wait
      let acquired = false;
      const p = sem.acquire().then(() => {
        acquired = true;
      });

      await new Promise((r) => setTimeout(r, 10));
      expect(acquired).toBe(false);

      sem.release();
      await p;
      expect(acquired).toBe(true);
    });
  });

  describe('admission control', () => {
    it('rejects with SemaphoreOverloadError when the queue is at capacity', async () => {
      const sem = new Semaphore(1, { maxQueue: 1 });
      await sem.acquire(); // fills the only slot
      const waiting = sem.acquire(); // fills the one queue slot
      // Third acquire has nowhere to go → shed load.
      await expect(sem.acquire()).rejects.toBeInstanceOf(SemaphoreOverloadError);
      await expect(sem.acquire()).rejects.toMatchObject({ status: 503, code: 'media.overloaded' });

      sem.release(); // let the queued one through so nothing dangles
      await waiting;
      expect(sem.stats().rejectedOverload).toBe(2);
    });

    it('rejects a waiter that exceeds acquireTimeoutMs', async () => {
      const sem = new Semaphore(1, { acquireTimeoutMs: 20 });
      await sem.acquire();
      await expect(sem.acquire()).rejects.toMatchObject({
        code: 'media.acquire_timeout',
        status: 503,
      });
      expect(sem.stats().queued).toBe(0); // timed-out waiter removed from the queue
    });

    it('rejects a waiter whose signal aborts', async () => {
      const sem = new Semaphore(1);
      await sem.acquire();
      const ac = new AbortController();
      const p = sem.acquire({ signal: ac.signal });
      ac.abort();
      await expect(p).rejects.toBeInstanceOf(SemaphoreAcquireError);
      expect(sem.stats().queued).toBe(0);
    });

    it('an already-aborted signal rejects immediately without queueing', async () => {
      const sem = new Semaphore(1);
      const ac = new AbortController();
      ac.abort();
      await expect(sem.acquire({ signal: ac.signal })).rejects.toMatchObject({
        code: 'media.acquire_aborted',
      });
    });

    it('stats() reports live occupancy + queue depth', async () => {
      const sem = new Semaphore(2, { maxQueue: 5 });
      await sem.acquire();
      await sem.acquire();
      const waiting = sem.acquire(); // queued
      const s = sem.stats();
      expect(s).toMatchObject({ max: 2, inUse: 2, available: 0, queued: 1, maxQueue: 5 });
      sem.release();
      await waiting;
    });

    it('unbounded by default (backward compatible — no rejection)', async () => {
      const sem = new Semaphore(1);
      await sem.acquire();
      // Many waiters queue without rejection.
      const waiters = Array.from({ length: 50 }, () => sem.acquire());
      expect(sem.stats().queued).toBe(50);
      for (let i = 0; i < 50; i++) sem.release();
      await Promise.all(waiters);
    });
  });
});
