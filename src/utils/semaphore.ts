/**
 * Semaphore with admission control.
 *
 * Limits CONCURRENT operations (the classic role) AND, optionally, bounds the
 * WAITING queue — concurrency limiting alone is not admission control: under
 * overload, unboundedly many queued closures (each retaining an upload buffer)
 * can exhaust memory even while active concurrency stays low. A bounded queue
 * sheds load with an explicit overload error instead.
 *
 * @example
 * ```ts
 * const sem = new Semaphore(5, { maxQueue: 100, acquireTimeoutMs: 30_000 });
 * await sem.run(() => uploadFile(file), { signal: req.signal });
 * ```
 */

/** Slot could not be admitted: the waiting queue is at capacity (shed load). */
export class SemaphoreOverloadError extends Error {
  readonly code = 'media.overloaded';
  readonly status = 503;
  constructor(maxQueue: number) {
    super(`Upload queue is full (max ${maxQueue} waiting) — shedding load`);
    this.name = 'SemaphoreOverloadError';
  }
}

/** Waited too long for a slot, or the caller aborted. */
export class SemaphoreAcquireError extends Error {
  readonly code: 'media.acquire_timeout' | 'media.acquire_aborted';
  readonly status = 503;
  constructor(kind: 'timeout' | 'aborted', detail: string) {
    super(detail);
    this.name = 'SemaphoreAcquireError';
    this.code = kind === 'timeout' ? 'media.acquire_timeout' : 'media.acquire_aborted';
  }
}

export interface SemaphoreOptions {
  /** Max callers allowed to WAIT for a slot. Default `Infinity` (unbounded). */
  maxQueue?: number;
  /** Default max wait before an acquire rejects. Default `undefined` (wait forever). */
  acquireTimeoutMs?: number;
}

export interface SemaphoreAcquireOptions {
  /** Abort the wait (rejects with `SemaphoreAcquireError`). */
  signal?: AbortSignal;
  /** Override the default acquire timeout for this call. */
  timeoutMs?: number;
}

export interface SemaphoreStats {
  /** Max concurrent slots. */
  max: number;
  /** Slots currently held. */
  inUse: number;
  /** Free slots. */
  available: number;
  /** Callers currently waiting for a slot. */
  queued: number;
  /** Queue capacity (`Infinity` when unbounded). */
  maxQueue: number;
  /** Cumulative acquires rejected because the queue was full. */
  rejectedOverload: number;
  /** Cumulative acquires rejected by timeout or abort. */
  rejectedAcquire: number;
}

interface Waiter {
  grant: () => void;
  reject: (err: Error) => void;
  cleanup: () => void;
}

export class Semaphore {
  private available: number;
  private readonly max: number;
  private readonly maxQueue: number;
  private readonly acquireTimeoutMs: number | undefined;
  private readonly queue: Waiter[] = [];
  private rejectedOverload = 0;
  private rejectedAcquire = 0;

  constructor(max: number, options: SemaphoreOptions = {}) {
    this.max = max;
    this.available = max;
    this.maxQueue = options.maxQueue ?? Number.POSITIVE_INFINITY;
    this.acquireTimeoutMs = options.acquireTimeoutMs;
  }

  /**
   * Acquire a slot. Resolves immediately if one is free; otherwise waits — but
   * rejects with {@link SemaphoreOverloadError} if the queue is at capacity, or
   * {@link SemaphoreAcquireError} on timeout / abort.
   */
  async acquire(opts: SemaphoreAcquireOptions = {}): Promise<void> {
    if (opts.signal?.aborted) {
      this.rejectedAcquire++;
      throw new SemaphoreAcquireError('aborted', 'Acquire aborted before start');
    }

    if (this.available > 0) {
      this.available--;
      return;
    }

    if (this.queue.length >= this.maxQueue) {
      this.rejectedOverload++;
      throw new SemaphoreOverloadError(this.maxQueue);
    }

    const timeoutMs = opts.timeoutMs ?? this.acquireTimeoutMs;

    return new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const onAbort = () => settleReject(new SemaphoreAcquireError('aborted', 'Acquire aborted'));

      const cleanup = () => {
        if (timer) clearTimeout(timer);
        opts.signal?.removeEventListener('abort', onAbort);
      };
      const remove = () => {
        const i = this.queue.indexOf(waiter);
        if (i >= 0) this.queue.splice(i, 1);
      };
      const settleReject = (err: Error) => {
        remove();
        cleanup();
        this.rejectedAcquire++;
        reject(err);
      };

      const waiter: Waiter = {
        grant: () => {
          cleanup();
          resolve();
        },
        reject: settleReject,
        cleanup,
      };

      if (timeoutMs !== undefined && Number.isFinite(timeoutMs)) {
        timer = setTimeout(
          () => settleReject(new SemaphoreAcquireError('timeout', `Acquire timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
        timer.unref?.();
      }
      opts.signal?.addEventListener('abort', onAbort, { once: true });

      this.queue.push(waiter);
    });
  }

  /** Release a slot — hands it to the next waiter, or frees it. */
  release(): void {
    const waiter = this.queue.shift();
    if (waiter) {
      waiter.grant(); // transfer the slot directly (available stays 0)
    } else {
      this.available = Math.min(this.available + 1, this.max);
    }
  }

  /** Execute `fn` with automatic acquire/release. Acquire options thread through. */
  async run<T>(fn: () => Promise<T>, opts: SemaphoreAcquireOptions = {}): Promise<T> {
    await this.acquire(opts);
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  /** Point-in-time metrics for observability / overload dashboards. */
  stats(): SemaphoreStats {
    return {
      max: this.max,
      inUse: this.max - this.available,
      available: this.available,
      queued: this.queue.length,
      maxQueue: this.maxQueue,
      rejectedOverload: this.rejectedOverload,
      rejectedAcquire: this.rejectedAcquire,
    };
  }
}
