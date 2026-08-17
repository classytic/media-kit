/**
 * Unit — shared provider HTTP policy (bounded time-to-response-headers).
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  providerFetch,
  uploadFetch,
  metadataFetch,
  streamFetch,
  redactUrl,
  PROVIDER_TIMEOUTS,
} from '../../src/providers/http';

afterEach(() => vi.restoreAllMocks());

describe('redactUrl', () => {
  it('drops the query string (secrets) and keeps origin + path', () => {
    expect(redactUrl('https://api.imgbb.com/1/upload?key=SECRET123')).toBe('https://api.imgbb.com/1/upload');
  });

  it('strips userinfo', () => {
    expect(redactUrl('https://user:pass@host.example/x')).toBe('https://host.example/x');
  });
});

describe('providerFetch', () => {
  it('passes through a fast response unchanged', async () => {
    const body = new Response('ok', { status: 200 });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(body);

    const res = await providerFetch('https://x/y', { method: 'GET' }, 1000);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
  });

  it('rejects with a normalized timeout error when the request never responds', async () => {
    // fetch that only settles when its signal aborts (the stalled-provider case)
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      (_input, init) =>
        new Promise((_resolve, reject) => {
          (init?.signal as AbortSignal | undefined)?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'TimeoutError')),
          );
        }),
    );

    await expect(providerFetch('https://slow/endpoint', undefined, 40)).rejects.toThrow(/timed out after 40ms/);
  });

  it('REDACTS the URL in timeout errors (no query-string secret leak)', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      (_input, init) =>
        new Promise((_resolve, reject) => {
          (init?.signal as AbortSignal | undefined)?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'TimeoutError')),
          );
        }),
    );

    const err = await providerFetch('https://api.imgbb.com/1/upload?key=SUPERSECRET', undefined, 30).catch(
      (e) => e as Error,
    );
    expect(err.message).toContain('https://api.imgbb.com/1/upload');
    expect(err.message).not.toContain('SUPERSECRET');
  });

  it('composes a caller-supplied signal (external abort propagates)', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      (_input, init) =>
        new Promise((_resolve, reject) => {
          (init?.signal as AbortSignal | undefined)?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          );
        }),
    );

    const external = new AbortController();
    const p = providerFetch('https://x', { signal: external.signal }, 10_000);
    external.abort();
    await expect(p).rejects.toThrow();
  });

  it('tiers: upload deadline is longer than metadata', () => {
    expect(PROVIDER_TIMEOUTS.upload).toBeGreaterThan(PROVIDER_TIMEOUTS.metadata);
  });

  it('uploadFetch / metadataFetch resolve through to fetch', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 200 }));
    await uploadFetch('https://u');
    await metadataFetch('https://m', { method: 'HEAD' });
    expect(spy).toHaveBeenCalledTimes(2);
  });
});

describe('streamFetch', () => {
  it('passes a healthy stream through unchanged (bytes preserved)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 }),
    );
    const res = await streamFetch('https://x/file');
    const buf = new Uint8Array(await res.arrayBuffer());
    expect([...buf]).toEqual([1, 2, 3, 4]);
  });

  it('aborts a body that goes idle past idleMs (stalled mid-stream socket)', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2, 3])); // one chunk, then goes silent
          (init?.signal as AbortSignal | undefined)?.addEventListener('abort', () => {
            try {
              controller.error(new DOMException('aborted', 'AbortError'));
            } catch {
              /* already errored */
            }
          });
        },
      });
      return new Response(body, { status: 200 });
    });

    const res = await streamFetch('https://x/file', undefined, { idleMs: 30 });
    const reader = res.body!.getReader();
    await reader.read(); // first chunk arrives fine
    await expect(reader.read()).rejects.toThrow(); // no more bytes → idle watchdog aborts
  });
});
