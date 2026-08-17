/**
 * Shared HTTP policy for storage providers.
 * ==========================================
 * Every provider that talks to a remote API over `fetch()` MUST go through this
 * so a stalled dependency can't hold an upload-semaphore slot forever
 * (eventually wedging all uploads). A bare `fetch()` has no default timeout.
 *
 * Two shapes, because a JSON call and a file stream need different deadlines:
 *
 *   - {@link providerFetch} (→ `metadataFetch` / `uploadFetch`) — a TOTAL
 *     deadline that stays armed through response-body parsing (`res.json()` /
 *     `res.text()`), so a provider that returns headers and then stalls the
 *     body is still bounded. Used for control-plane ops and `write()` (whose
 *     JSON response is small and read immediately).
 *   - {@link streamFetch} — a HEADER deadline to get the response, then an
 *     idle watchdog on the body: a legitimately large `read()` streams for as
 *     long as bytes keep flowing, but a socket that goes silent mid-stream is
 *     aborted after `idleMs`.
 *
 * A caller `signal` composes with the deadline via `AbortSignal.any` (Node ≥20;
 * engines require ≥22). Timeout errors NEVER include the raw URL — query
 * strings can carry secrets (imgbb puts its API key there) — only the redacted
 * origin+path.
 */

/** Default per-tier deadlines (ms). Chosen to be generous but finite. */
export const PROVIDER_TIMEOUTS = {
  /** Body transfers — write POSTs (upload + its JSON response). */
  upload: 120_000,
  /** Control-plane — delete / exists / stat / list / signed-URL / direct-upload. */
  metadata: 30_000,
  /** Max gap between bytes on a streaming read before the socket is deemed stalled. */
  streamIdle: 30_000,
} as const;

/**
 * Redact a request target for error messages: keep scheme/host/path, drop the
 * query string (secrets like `?key=…`) and any userinfo. Never throw.
 */
export function redactUrl(input: string | URL): string {
  try {
    const u = new URL(String(input));
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    // Not a parseable URL — strip anything after `?` as a coarse fallback.
    return String(input).split('?')[0] ?? '<url>';
  }
}

function isTimeout(err: unknown): boolean {
  return (err as { name?: string })?.name === 'TimeoutError';
}

/**
 * `fetch()` with a TOTAL deadline that also bounds response-body parsing.
 *
 * The abort timer stays armed after the headers arrive — so `res.json()` /
 * `res.text()` on the returned `Response` is covered by the same deadline. It
 * is `unref()`d, so a harmless post-completion fire never blocks process exit.
 * DO NOT use this for streaming reads (it would abort a slow-but-progressing
 * download) — use {@link streamFetch}.
 */
export async function providerFetch(
  input: string | URL,
  init: RequestInit | undefined,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new DOMException(`Provider request exceeded ${timeoutMs}ms`, 'TimeoutError'));
  }, timeoutMs);
  timer.unref?.();

  const signal = init?.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal;

  try {
    return await fetch(input, { ...init, signal });
  } catch (err) {
    if (isTimeout(err)) {
      throw new Error(`Provider request timed out after ${timeoutMs}ms: ${redactUrl(input)}`);
    }
    throw err;
  }
  // Timer intentionally NOT cleared: it stays armed to bound the caller's body
  // read, and fires harmlessly (abort on a settled request is a no-op) if the
  // body already completed.
}

/** `providerFetch` at the control-plane deadline (delete/exists/stat/list/signing). */
export function metadataFetch(input: string | URL, init?: RequestInit): Promise<Response> {
  return providerFetch(input, init, PROVIDER_TIMEOUTS.metadata);
}

/** `providerFetch` at the body-transfer deadline (write() + its JSON response). */
export function uploadFetch(input: string | URL, init?: RequestInit): Promise<Response> {
  return providerFetch(input, init, PROVIDER_TIMEOUTS.upload);
}

export interface StreamFetchOptions {
  /** Deadline to receive the response headers (time to first byte). Default `metadata` tier. */
  headerMs?: number;
  /** Max gap between body chunks before the stream is deemed stalled. Default `streamIdle`. */
  idleMs?: number;
}

/**
 * `fetch()` for STREAMING reads: a header deadline to obtain the response, then
 * an idle watchdog on the body. The download may run arbitrarily long as long
 * as bytes keep arriving; a socket that goes silent for `idleMs` is aborted.
 * Returns a `Response` whose `body` is the watchdog-wrapped stream.
 */
export async function streamFetch(
  input: string | URL,
  init?: RequestInit,
  opts?: StreamFetchOptions,
): Promise<Response> {
  const headerMs = opts?.headerMs ?? PROVIDER_TIMEOUTS.metadata;
  const idleMs = opts?.idleMs ?? PROVIDER_TIMEOUTS.streamIdle;

  const controller = new AbortController();
  const signal = init?.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal;

  const headerTimer = setTimeout(() => {
    controller.abort(new DOMException(`Provider response headers exceeded ${headerMs}ms`, 'TimeoutError'));
  }, headerMs);
  headerTimer.unref?.();

  let res: Response;
  try {
    res = await fetch(input, { ...init, signal });
  } catch (err) {
    if (isTimeout(err)) {
      throw new Error(`Provider request timed out after ${headerMs}ms: ${redactUrl(input)}`);
    }
    throw err;
  } finally {
    clearTimeout(headerTimer); // headers arrived (or failed) — switch to the idle watchdog
  }

  if (!res.body) return res;

  // Idle watchdog: reset a per-chunk timer; if no bytes for idleMs, abort the
  // underlying fetch body (via the shared controller), which errors the stream.
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const arm = () => {
    idleTimer = setTimeout(() => {
      controller.abort(new DOMException(`Provider stream idle > ${idleMs}ms`, 'TimeoutError'));
    }, idleMs);
    idleTimer.unref?.();
  };
  const disarm = () => {
    if (idleTimer) clearTimeout(idleTimer);
  };

  const watched = new TransformStream<Uint8Array, Uint8Array>({
    start() {
      arm();
    },
    transform(chunk, ctrl) {
      disarm();
      ctrl.enqueue(chunk);
      arm();
    },
    flush() {
      disarm();
    },
  });

  return new Response(res.body.pipeThrough(watched), {
    status: res.status,
    statusText: res.statusText,
    headers: res.headers,
  });
}
