/**
 * Simple Semaphore for concurrency control
 *
 * Limits the number of concurrent operations to prevent memory crashes
 * and resource exhaustion under high load.
 *
 * @example
 * ```ts
 * const semaphore = new Semaphore(5); // Max 5 concurrent operations
 *
 * async function uploadFile(file) {
 *   await semaphore.acquire();
 *   try {
 *     // Upload logic here
 *   } finally {
 *     semaphore.release();
 *   }
 * }
 * ```
 */
export class Semaphore {
  private available: number;
  private readonly max: number;
  private readonly queue: Array<() => void> = [];

  constructor(max: number) {
    this.max = max;
    this.available = max;
  }

  /**
   * Acquire a slot - waits if all slots are busy
   */
  async acquire(): Promise<void> {
    if (this.available > 0) {
      this.available--;
      return Promise.resolve();
    }

    // Wait in queue
    return new Promise<void>((resolve) => {
      this.queue.push(resolve);
    });
  }

  /**
   * Release a slot - allows next queued operation to proceed
   */
  release(): void {
    const resolve = this.queue.shift();
    if (resolve) {
      // Give slot to next in queue
      resolve();
    } else {
      // No one waiting, increase available
      this.available = Math.min(this.available + 1, this.max);
    }
  }

  /**
   * Execute a function with automatic acquire/release
   */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}
