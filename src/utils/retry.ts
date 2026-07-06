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

/** Node syscall error codes that indicate a transient network failure. */
const RETRYABLE_ERROR_CODES = new Set([
  'ETIMEDOUT',
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'EPIPE',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
]);

/** HTTP status codes worth retrying (transient server-side / throttling). */
const RETRYABLE_STATUS_CODES = new Set([408, 429, 500, 502, 503, 504]);

/** Error shape with the structured signals we probe for (all optional). */
interface StructuredError {
  code?: unknown;
  status?: unknown;
  statusCode?: unknown;
  $retryable?: unknown;
  $metadata?: { httpStatusCode?: unknown };
}

/**
 * Default function to check if an error is retryable.
 *
 * Prefers structured signals — error code (ETIMEDOUT, ECONNRESET, ...),
 * AWS SDK `$retryable` / `$metadata.httpStatusCode`, numeric `status` /
 * `statusCode` / `code` properties — and only falls back to word-boundary
 * message checks when no structured signal is present. Never matches bare
 * digit substrings (a filename containing "500" is not a server error).
 */
export function isRetryableError(error: Error): boolean {
  const err = error as Error & StructuredError;

  // 1. Node syscall / network error codes
  if (typeof err.code === 'string' && RETRYABLE_ERROR_CODES.has(err.code)) {
    return true;
  }

  // 2. AWS SDK v3 marks throttling/transient errors explicitly
  if (err.$retryable) {
    return true;
  }

  // 3. HTTP status from common shapes (AWS `$metadata`, gaxios/got `status`,
  //    node-fetch-style `statusCode`, GCS numeric `code`). A present status
  //    is authoritative — 404/403 etc. must NOT fall through to message checks.
  const status =
    typeof err.status === 'number'
      ? err.status
      : typeof err.statusCode === 'number'
        ? err.statusCode
        : typeof err.$metadata?.httpStatusCode === 'number'
          ? err.$metadata.httpStatusCode
          : typeof err.code === 'number'
            ? err.code
            : undefined;
  if (status !== undefined) {
    return RETRYABLE_STATUS_CODES.has(status);
  }

  // 4. Fallback: word-boundary message/name checks only
  const message = error.message.toLowerCase();
  const name = error.name.toLowerCase();

  if (
    /\btimeout\b|\btimed out\b/.test(message) ||
    /\bnetwork\b/.test(message) ||
    /\beconnreset\b|\beconnrefused\b|\benotfound\b|\betimedout\b|\bepipe\b/.test(message) ||
    /\bsocket hang up\b/.test(message)
  ) {
    return true;
  }

  if (
    /throttl/.test(message) ||
    /throttl/.test(name) ||
    /\brate limit\b|\bslow down\b|\bservice unavailable\b|\binternal server error\b/.test(message)
  ) {
    return true;
  }

  return false;
}

/**
 * Execute a function with automatic retry on failure
 */
export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
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
      const exponentialDelay = baseDelay * backoffMultiplier ** attempt;
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
