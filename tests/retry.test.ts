import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { withRetry, isRetryableError } from '../src/utils/retry';

describe('isRetryableError', () => {
  it('should return true for network errors', () => {
    expect(isRetryableError(new Error('network error'))).toBe(true);
    expect(isRetryableError(new Error('ECONNRESET'))).toBe(true);
    expect(isRetryableError(new Error('ECONNREFUSED'))).toBe(true);
    expect(isRetryableError(new Error('ENOTFOUND'))).toBe(true);
    expect(isRetryableError(new Error('socket hang up'))).toBe(true);
  });

  it('should return true for timeout errors', () => {
    expect(isRetryableError(new Error('timeout exceeded'))).toBe(true);
    expect(isRetryableError(new Error('Request timeout'))).toBe(true);
  });

  it('should return true for throttling errors', () => {
    expect(isRetryableError(new Error('Request was throttled'))).toBe(true);
    expect(isRetryableError(new Error('rate limit exceeded'))).toBe(true);
    expect(isRetryableError(new Error('Slow down'))).toBe(true);
  });

  it('should return true for server errors', () => {
    expect(isRetryableError(new Error('service unavailable'))).toBe(true);
    expect(isRetryableError(new Error('internal server error'))).toBe(true);
    expect(isRetryableError(new Error('HTTP 500'))).toBe(true);
    expect(isRetryableError(new Error('HTTP 502'))).toBe(true);
    expect(isRetryableError(new Error('HTTP 503'))).toBe(true);
    expect(isRetryableError(new Error('HTTP 504'))).toBe(true);
    expect(isRetryableError(new Error('Error 429: Too many requests'))).toBe(true);
  });

  it('should return false for non-retryable errors', () => {
    expect(isRetryableError(new Error('File not found'))).toBe(false);
    expect(isRetryableError(new Error('Access denied'))).toBe(false);
    expect(isRetryableError(new Error('Invalid argument'))).toBe(false);
    expect(isRetryableError(new Error('Validation failed'))).toBe(false);
  });
});

describe('withRetry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should return result on first success', async () => {
    const fn = vi.fn().mockResolvedValue('success');

    const resultPromise = withRetry(fn);
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(result).toBe('success');
    expect(fn).toHaveBeenCalledOnce();
  });

  it('should retry on retryable error and succeed', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error('network error'))
      .mockRejectedValueOnce(new Error('timeout'))
      .mockResolvedValue('success');

    const resultPromise = withRetry(fn, { maxRetries: 3, baseDelay: 100 });

    // First call fails
    await vi.advanceTimersByTimeAsync(0);

    // Wait for first retry delay
    await vi.advanceTimersByTimeAsync(150);

    // Wait for second retry delay
    await vi.advanceTimersByTimeAsync(300);

    const result = await resultPromise;

    expect(result).toBe('success');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('should throw after max retries exhausted', async () => {
    vi.useRealTimers(); // Use real timers for this test

    let attempts = 0;
    const fn = async () => {
      attempts++;
      throw new Error('network error');
    };

    await expect(
      withRetry(fn, { maxRetries: 2, baseDelay: 10, maxDelay: 50 })
    ).rejects.toThrow('network error');

    expect(attempts).toBe(3); // Initial + 2 retries

    vi.useFakeTimers(); // Restore fake timers
  });

  it('should not retry non-retryable errors', async () => {
    vi.useRealTimers(); // Use real timers for this test

    let attempts = 0;
    const fn = async () => {
      attempts++;
      throw new Error('access denied');
    };

    await expect(
      withRetry(fn, { maxRetries: 3 })
    ).rejects.toThrow('access denied');

    expect(attempts).toBe(1); // No retries

    vi.useFakeTimers(); // Restore fake timers
  });

  it('should use custom isRetryable function', async () => {
    const error = new Error('custom error');
    const fn = vi
      .fn()
      .mockRejectedValueOnce(error)
      .mockResolvedValue('success');

    const isRetryable = vi.fn().mockReturnValue(true);

    const resultPromise = withRetry(fn, {
      maxRetries: 1,
      baseDelay: 100,
      isRetryable,
    });

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(150);

    const result = await resultPromise;

    expect(result).toBe('success');
    expect(isRetryable).toHaveBeenCalledWith(error);
  });

  it('should call onRetry callback', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error('network error'))
      .mockResolvedValue('success');

    const onRetry = vi.fn();

    const resultPromise = withRetry(fn, {
      maxRetries: 2,
      baseDelay: 100,
      onRetry,
    });

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(150);

    await resultPromise;

    expect(onRetry).toHaveBeenCalledOnce();
    expect(onRetry).toHaveBeenCalledWith(
      expect.any(Error),
      1,
      expect.any(Number)
    );
  });

  it('should respect maxDelay option', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error('network error'))
      .mockRejectedValueOnce(new Error('network error'))
      .mockRejectedValueOnce(new Error('network error'))
      .mockResolvedValue('success');

    const delays: number[] = [];
    const onRetry = vi.fn((_err, _attempt, delay) => {
      delays.push(delay);
    });

    const resultPromise = withRetry(fn, {
      maxRetries: 3,
      baseDelay: 1000,
      maxDelay: 2000,
      backoffMultiplier: 3,
      onRetry,
    });

    // Run all timers
    await vi.runAllTimersAsync();
    await resultPromise;

    // All delays should be <= maxDelay (2000)
    delays.forEach((delay) => {
      expect(delay).toBeLessThanOrEqual(2000);
    });
  });

  it('should apply exponential backoff', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error('network error'))
      .mockRejectedValueOnce(new Error('network error'))
      .mockResolvedValue('success');

    const delays: number[] = [];
    const onRetry = vi.fn((_err, _attempt, delay) => {
      delays.push(delay);
    });

    const resultPromise = withRetry(fn, {
      maxRetries: 2,
      baseDelay: 100,
      backoffMultiplier: 2,
      maxDelay: 10000,
      onRetry,
    });

    await vi.runAllTimersAsync();
    await resultPromise;

    // First delay should be around 100 (+ up to 30% jitter)
    expect(delays[0]).toBeGreaterThanOrEqual(100);
    expect(delays[0]).toBeLessThanOrEqual(130);

    // Second delay should be around 200 (+ up to 30% jitter)
    expect(delays[1]).toBeGreaterThanOrEqual(200);
    expect(delays[1]).toBeLessThanOrEqual(260);
  });
});

describe('withRetry integration (real timers)', () => {
  it('should work with real async operations', async () => {
    let attempts = 0;
    const fn = async () => {
      attempts++;
      if (attempts < 3) {
        throw new Error('network error');
      }
      return 'success';
    };

    const result = await withRetry(fn, {
      maxRetries: 3,
      baseDelay: 10, // Short delay for test speed
    });

    expect(result).toBe('success');
    expect(attempts).toBe(3);
  });
});
