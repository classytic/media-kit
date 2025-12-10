/**
 * Retry utility with exponential backoff
 *
 * Automatically retries failed operations with increasing delays
 * to handle transient failures (network issues, rate limits, etc.)
 *
 * @example
 * ```ts
 * const result = await withRetry(
 *   () => s3Client.upload(params),
 *   { maxRetries: 3, baseDelay: 100 }
 * );
 * ```
 */

export interface RetryOptions {
  /** Maximum number of retry attempts (default: 3) */
  maxRetries?: number;
  /** Base delay in ms before first retry (default: 100) */
  baseDelay?: number;
  /** Maximum delay in ms between retries (default: 5000) */
  maxDelay?: number;
  /** Multiplier for exponential backoff (default: 2) */
  backoffMultiplier?: number;
  /** Function to determine if error is retryable (default: all errors) */
  isRetryable?: (error: Error) => boolean;
  /** Optional callback on retry attempt */
  onRetry?: (error: Error, attempt: number, delay: number) => void;
}

/**
 * Default function to check if an error is retryable
 * Retries on network errors, timeouts, and rate limits
 */
export function isRetryableError(error: Error): boolean {
  const message = error.message.toLowerCase();
  const name = error.name.toLowerCase();

  // Network errors
  if (
    message.includes('network') ||
    message.includes('timeout') ||
    message.includes('econnreset') ||
    message.includes('econnrefused') ||
    message.includes('enotfound') ||
    message.includes('socket hang up')
  ) {
    return true;
  }

  // AWS/S3 specific retryable errors
  if (
    message.includes('throttl') ||
    message.includes('rate limit') ||
    message.includes('slow down') ||
    message.includes('service unavailable') ||
    message.includes('internal server error') ||
    name.includes('throttl')
  ) {
    return true;
  }

  // GCS specific retryable errors
  if (
    message.includes('429') ||
    message.includes('500') ||
    message.includes('502') ||
    message.includes('503') ||
    message.includes('504')
  ) {
    return true;
  }

  return false;
}

/**
 * Execute a function with automatic retry on failure
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const {
    maxRetries = 3,
    baseDelay = 100,
    maxDelay = 5000,
    backoffMultiplier = 2,
    isRetryable = isRetryableError,
    onRetry,
  } = options;

  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error as Error;

      // Don't retry on last attempt or non-retryable errors
      if (attempt === maxRetries || !isRetryable(lastError)) {
        throw lastError;
      }

      // Calculate delay with exponential backoff + jitter
      const exponentialDelay = baseDelay * Math.pow(backoffMultiplier, attempt);
      const jitter = Math.random() * 0.3 * exponentialDelay; // 0-30% jitter
      const delay = Math.min(exponentialDelay + jitter, maxDelay);

      // Notify callback if provided
      if (onRetry) {
        onRetry(lastError, attempt + 1, delay);
      }

      // Wait before retrying
      await sleep(delay);
    }
  }

  // Should never reach here, but TypeScript needs it
  throw lastError;
}

/**
 * Sleep for specified milliseconds
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
