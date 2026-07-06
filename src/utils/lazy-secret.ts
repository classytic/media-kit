/**
 * Lazy secret resolver — shared primitive for provider credential handling.
 *
 * Before this helper, every credentialed provider (`ImgbbProvider`,
 * `CloudinaryProvider`, `ImageKitProvider`) demanded an eager string at
 * construct time and threw `'apiKey is required'` from the constructor.
 * That broke a real host pattern: spawn boots a media engine for ALL routes,
 * but only the `/uploads/*` paths actually call the upload pipeline — every
 * other env (test runner, dev preview, partial-deploy worker) had to either
 * smuggle in a real key or pin the engine behind a feature flag.
 *
 * Accepting `() => string | Promise<string>` defers resolution to first use
 * (the actual upload call) so a host with no upload paths exercised never
 * needs the secret at all. The string form stays valid — hosts on the eager
 * path don't have to migrate.
 *
 * Resolved values are memoized — the resolver fires at most once, and any
 * subsequent calls return the cached value. This matches the eager-string
 * contract (one value for the lifetime of the provider) and avoids surprise
 * round-trips to a secret manager on every upload.
 */

/**
 * A credential value. Either a literal string, or a (sync/async) resolver
 * fired on first use. Empty/null/undefined resolved values throw at use
 * time with the same message the eager form throws at construct time.
 */
export type SecretValue = string | (() => string | Promise<string>);

/**
 * Internal helper used by each provider to memoize secret resolution.
 *
 * @example Inside `ImgbbProvider.write()`:
 * ```ts
 * const apiKey = await this.apiKeyResolver.resolve();
 * // ... use apiKey
 * ```
 */
export class LazySecret {
  private cached?: string;
  private inflight?: Promise<string>;

  constructor(
    private readonly value: SecretValue,
    /** Provider-prefixed name used in error messages, e.g. `'ImgbbProvider: apiKey'`. */
    private readonly label: string,
  ) {}

  /**
   * Returns true when the underlying value is a string literal. Useful for
   * keeping eager-validation behavior intact: if a host passes `''` or `null`
   * as a string literal, providers still throw from their constructor — only
   * function form defers resolution.
   */
  get isLiteral(): boolean {
    return typeof this.value !== 'function';
  }

  /**
   * For string literals only — returns the value synchronously, useful for
   * providers that build derived state (e.g. an HTTP basic-auth header) at
   * construct time when the literal form is supplied.
   *
   * Returns `undefined` for function form. Callers MUST handle the undefined
   * case (typically by computing the derived state on first `resolve()`).
   */
  literalValue(): string | undefined {
    return typeof this.value === 'string' ? this.value : undefined;
  }

  /**
   * Resolve the secret. The resolver function (if any) fires at most once
   * across the provider's lifetime — subsequent calls return the cached
   * value. Concurrent calls collapse to a single resolver invocation via the
   * `inflight` promise.
   *
   * Throws when the resolved value is empty/null/undefined, with the same
   * error shape the eager constructors used to throw (`'<label> is required'`).
   */
  async resolve(): Promise<string> {
    if (this.cached !== undefined) return this.cached;
    if (typeof this.value === 'string') {
      // The constructor already validated literals; if we got here with an
      // empty literal, the host bypassed that check (e.g. via a runtime mock)
      // — surface the same error message anyway for consistency.
      if (!this.value) throw new Error(`${this.label} is required`);
      this.cached = this.value;
      return this.cached;
    }
    // Function form: dedupe concurrent calls so a parallel-upload burst
    // doesn't hit a remote secret manager N times. Capture `resolver`
    // outside the IIFE so the function-form narrow survives the closure.
    if (this.inflight) return this.inflight;
    const resolver = this.value;
    this.inflight = (async () => {
      try {
        const resolved = await resolver();
        if (!resolved) {
          throw new Error(`${this.label} resolver returned an empty value — credentials cannot be empty`);
        }
        this.cached = resolved;
        return resolved;
      } finally {
        this.inflight = undefined;
      }
    })();
    return this.inflight;
  }
}

/**
 * Validate a `SecretValue` at construct time without forcing resolution.
 *
 * - String literal: must be non-empty (preserves the pre-lazy "fail loudly at
 *   construct time" contract for hosts using eager strings).
 * - Function form: cannot be null/undefined, but the actual resolver call is
 *   deferred to first use — so a function that throws or returns empty surfaces
 *   at upload time, not boot time. This is the WHOLE point of the helper.
 *
 * @throws when the value is missing / empty string / non-function-non-string.
 */
export function validateSecretValue(value: SecretValue | undefined | null, label: string): void {
  if (value === undefined || value === null) {
    throw new Error(`${label} is required (pass a string or () => string | Promise<string>)`);
  }
  if (typeof value === 'string') {
    if (!value) throw new Error(`${label} is required`);
    return;
  }
  if (typeof value !== 'function') {
    throw new Error(`${label} must be a string or a () => string | Promise<string> resolver, got ${typeof value}`);
  }
  // Function form — defer validation to first use.
}
