/**
 * TUS resumable uploads — a framework-agnostic server for the
 * [tus.io](https://tus.io/) resumable upload protocol (v1.0.0), the same
 * protocol Supabase Storage exposes. Standard clients — `tus-js-client`,
 * Uppy, tus-py-client — work against it out of the box: a flaky mobile
 * upload resumes from the last confirmed byte instead of restarting.
 *
 * Shape mirrors `AssetTransformService`: plain request objects in, plain
 * response objects out — the host owns the route.
 *
 * ## How it fits media-kit
 *
 * Chunks are staged to a local directory (`stagingDir`) as they arrive; when
 * the final byte lands, the assembled file runs through the NORMAL
 * `repository.upload()` pipeline — validation, scan bridge, hashing/dedup,
 * processing, events — so a TUS upload produces exactly the same media doc
 * as a direct upload. Nothing bypasses the pipeline.
 *
 * ## Durability model
 *
 * Session bookkeeping lives in a pluggable {@link TusSessionStore}
 * (in-memory default). With the default store an app restart forgets
 * in-flight sessions (clients restart the upload — the protocol handles
 * this); bring a persistent store to survive restarts. Staged bytes always
 * live on disk under `stagingDir` — run {@link TusUploadService.sweepExpired}
 * on a cron to reclaim abandoned sessions AND their staged files.
 *
 * @example
 * ```ts
 * import { createTusUpload } from '@classytic/media-kit/resumable';
 *
 * const tus = createTusUpload({
 *   media: engine.repositories.media,
 *   stagingDir: '/var/lib/myapp/tus-staging',
 *   basePath: '/uploads/tus',
 * });
 *
 * // Fastify (any framework works the same way):
 * fastify.addContentTypeParser('application/offset+octet-stream', (_req, _payload, done) => done(null));
 * fastify.all('/uploads/tus', handle);
 * fastify.all('/uploads/tus/:id', handle);
 * async function handle(req, reply) {
 *   const res = await tus.handle(
 *     { method: req.method, uploadId: req.params.id ?? null, headers: req.headers, body: req.raw },
 *     { ctx: { organizationId: req.orgId }, folder: 'uploads' },
 *   );
 *   reply.status(res.status).headers(res.headers).send();
 * }
 * ```
 */

import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, rm, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import type { MediaContext } from '../engine/engine-types';
import type { IMediaDocument, MediaVisibility } from '../types/media.js';
import type { UploadInput } from '../types/uploads.js';

export const TUS_VERSION = '1.0.0';
const TUS_EXTENSIONS = 'creation,expiration,termination';

/** One in-flight resumable upload. */
export interface TusSession {
  readonly id: string;
  /** Total upload size in bytes (Upload-Length). */
  readonly length: number;
  /** Bytes confirmed so far. */
  offset: number;
  /** Decoded Upload-Metadata pairs (filename, filetype, ...). */
  readonly metadata: Record<string, string>;
  readonly createdAt: number;
  readonly expiresAt: number;
  /** Upload options captured at creation (forwarded to `upload()` at completion). */
  readonly upload: {
    readonly folder?: string;
    readonly visibility?: MediaVisibility;
    readonly context?: MediaContext;
  };
}

/**
 * Session bookkeeping port. The in-memory default forgets sessions on
 * restart; implement over Redis/DB for restart-safe resumption. `list()`
 * powers {@link TusUploadService.sweepExpired}.
 *
 * ## Concurrency across replicas
 *
 * A single PATCH must have exactly one writer. Within one process the service
 * enforces this with a local in-flight set. That is NOT enough for a
 * horizontally-scaled deployment: two replicas can each read the same offset,
 * both pass validation, and append concurrently — corrupting the staged
 * object. Implement the {@link TusSessionStore} lock trio (`acquireLock` /
 * `renewLock` / `releaseLock` — the tusd `Locker` pattern over a Redis
 * `SET NX PX` / DB row lock) for a real distributed single-writer guarantee.
 *
 * The lock is **fenced by an ownership token**: `acquireLock` returns a
 * `{ token, expiresAt }` (or `null` if held), and `renewLock` / `releaseLock`
 * both require that token. This closes the lease-expiry hazard — worker A's
 * lease expires mid-upload, worker B acquires with a NEW token, and A's later
 * `releaseLock(id, tokenA)` is a no-op instead of freeing B's lock. Long PATCH
 * bodies renew the lease as bytes flow, so a legitimately slow upload never
 * loses its lock.
 *
 * When no lock is implemented, the service falls back to the process-local set.
 * That is safe ONLY under sticky single-replica routing — so construct with
 * `singleReplica: true` to acknowledge it (silences the boot warning); leaving
 * it unset on a store with no lock logs a one-time warning at first PATCH.
 */
export interface TusSessionStore {
  create(session: TusSession): void | Promise<void>;
  get(id: string): TusSession | null | Promise<TusSession | null>;
  setOffset(id: string, offset: number): void | Promise<void>;
  delete(id: string): void | Promise<void>;
  list(): TusSession[] | Promise<TusSession[]>;
  /**
   * OPTIONAL cross-replica lock. Atomically acquire an exclusive, token-fenced
   * lease on `id` for `leaseMs`; return the {@link TusLock} on success, or
   * `null` if another holder has it. MUST be atomic (e.g. Redis
   * `SET key <token> NX PX leaseMs` with a freshly minted token) — a
   * `get`-then-`set` is racy and defeats the purpose. Implement the whole trio
   * (`acquireLock` + `renewLock` + `releaseLock`) or none.
   */
  acquireLock?(id: string, leaseMs: number): TusLock | null | Promise<TusLock | null>;
  /**
   * Extend the lease IFF `token` still owns the lock. Returns `true` on renew,
   * `false` if the lock was lost (expired + re-acquired by another worker) —
   * the caller MUST then stop writing. Redis: `if GET id == token then PEXPIRE`.
   */
  renewLock?(id: string, token: string, leaseMs: number): boolean | Promise<boolean>;
  /**
   * Release IFF `token` still owns the lock (fenced). Releasing a lock you no
   * longer own is a no-op — never frees another worker's lease. Redis:
   * `if GET id == token then DEL`.
   */
  releaseLock?(id: string, token: string): void | Promise<void>;
}

/** An ownership-token lease over a TUS session, minted by {@link TusSessionStore.acquireLock}. */
export interface TusLock {
  /** Opaque fencing token — proves ownership on renew/release. */
  readonly token: string;
  /** Lease expiry (epoch ms) — informational; the store enforces it. */
  readonly expiresAt: number;
}

export function createMemoryTusSessionStore(): TusSessionStore {
  const sessions = new Map<string, TusSession>();
  return {
    create(session) {
      sessions.set(session.id, session);
    },
    get(id) {
      return sessions.get(id) ?? null;
    },
    setOffset(id, offset) {
      const s = sessions.get(id);
      if (s) s.offset = offset;
    },
    delete(id) {
      sessions.delete(id);
    },
    list() {
      return [...sessions.values()];
    },
  };
}

/** Plain request object — map your framework's request onto it. */
export interface TusRequest {
  method: string;
  /** Upload id from the route param (`/uploads/tus/:id`), null for the collection route. */
  uploadId?: string | null;
  headers: Record<string, string | string[] | undefined>;
  /** Request body for PATCH — a Node stream, Buffer, or async iterable of bytes. */
  body?: Readable | Uint8Array | AsyncIterable<Uint8Array> | null;
}

/** Plain response object — write status + headers, send no body (except 460 JSON errors upstream). */
export interface TusResponse {
  status: number;
  headers: Record<string, string>;
  /** Set when the final PATCH completed the upload — the created media doc id. */
  mediaId?: string;
}

/** Per-request upload options resolved by the host (auth already done). */
export interface TusHandleOptions {
  /** Tenant/user context forwarded to `upload()` at completion. */
  ctx?: MediaContext;
  /** Target folder (creation requests only). */
  folder?: string;
  /** Visibility (creation requests only). */
  visibility?: MediaVisibility;
}

export interface TusUploadConfig {
  /** Anything exposing media-kit's `upload()` — `engine.repositories.media`. */
  media: {
    upload(input: UploadInput, ctx?: MediaContext): Promise<IMediaDocument>;
  };
  /**
   * Directory for staged chunks. Use an ABSOLUTE path on a persistent volume
   * (cwd-relative paths break across deploy contexts — same trap as
   * LocalProvider's basePath).
   */
  stagingDir: string;
  /** Public path prefix for the Location header. Default `/uploads/tus`. */
  basePath?: string;
  /** Max upload size in bytes. Default 500 MiB (assembly buffers in memory). */
  maxSize?: number;
  /** Session lifetime. Default 24h (Supabase parity). */
  ttlMs?: number;
  /**
   * OPERATION-level lease for the per-PATCH distributed lock (NOT the session
   * TTL). Held only while a PATCH is appending, auto-renewed as bytes flow, and
   * released on completion. Default 30s. Keep it short — a crashed holder's
   * lock frees after at most this long.
   */
  lockLeaseMs?: number;
  /** Session store. Default in-memory. */
  sessions?: TusSessionStore;
  /**
   * Assert the deployment pins each session to ONE replica (sticky routing).
   * Required to silence the boot warning when the session store implements no
   * distributed lock — with the process-local fallback, cross-replica PATCH
   * concurrency is otherwise unsafe. Ignored when the store implements the lock.
   */
  singleReplica?: boolean;
  /** Warn sink for the no-lock/no-sticky boot warning. Default `console.warn`. */
  logger?: { warn(message: string): void };
  /** Called after the assembled file clears the upload pipeline. */
  onComplete?: (media: IMediaDocument, session: TusSession) => void | Promise<void>;
}

export interface TusUploadService {
  handle(request: TusRequest, options?: TusHandleOptions): Promise<TusResponse>;
  /** Delete expired sessions + their staged files. Run on a cron. Returns count removed. */
  sweepExpired(now?: number): Promise<number>;
}

const DEFAULT_MAX_SIZE = 500 * 1024 * 1024;
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_LOCK_LEASE_MS = 30 * 1000;

/** Internal sentinel: a PATCH stream crossed its remaining-length allowance. */
class TusOverflowError extends Error {
  constructor() {
    super('TUS PATCH body exceeds the remaining upload length');
    this.name = 'TusOverflowError';
  }
}

/** Internal sentinel: the single-writer lock was lost mid-append (lease expired + re-acquired). */
class TusLockLostError extends Error {
  constructor() {
    super('TUS single-writer lock lost during PATCH');
    this.name = 'TusLockLostError';
  }
}

function header(headers: TusRequest['headers'], name: string): string | undefined {
  const value = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

/** Upload-Metadata: comma-separated `key base64value` pairs (value optional). */
function parseMetadata(raw: string | undefined): Record<string, string> {
  const metadata: Record<string, string> = {};
  if (!raw) return metadata;
  for (const pair of raw.split(',')) {
    const [key, encoded] = pair.trim().split(' ');
    if (!key) continue;
    try {
      metadata[key] = encoded ? Buffer.from(encoded, 'base64').toString('utf8') : '';
    } catch {
      /* skip malformed pair */
    }
  }
  return metadata;
}

export function createTusUpload(config: TusUploadConfig): TusUploadService {
  const {
    media,
    stagingDir,
    basePath = '/uploads/tus',
    maxSize = DEFAULT_MAX_SIZE,
    ttlMs = DEFAULT_TTL_MS,
    lockLeaseMs = DEFAULT_LOCK_LEASE_MS,
    singleReplica = false,
    logger,
    onComplete,
  } = config;
  const customStore = config.sessions !== undefined;
  const sessions = config.sessions ?? createMemoryTusSessionStore();

  // One PATCH at a time per upload — concurrent chunk appends would corrupt the
  // staging file. Second writer gets 423 Locked (tusd behavior). Prefer the
  // store's token-fenced cross-replica lock; fall back to a process-local set.
  const inFlight = new Set<string>();
  const hasStoreLock = typeof sessions.acquireLock === 'function';

  // Boot warning: a CUSTOM (possibly distributed) session store with no lock is
  // unsafe across replicas unless routing is sticky. The built-in memory store
  // is inherently single-process, so it never warns.
  let warnedNoLock = false;
  const warnIfUnsafe = (): void => {
    if (hasStoreLock || singleReplica || !customStore || warnedNoLock) return;
    warnedNoLock = true;
    (logger?.warn ?? console.warn)(
      '[tus] The provided TusSessionStore implements no distributed lock (acquireLock/renewLock/releaseLock). ' +
        'Concurrent PATCHes across replicas can corrupt a staged upload. Implement the lock trio, or set ' +
        '`singleReplica: true` to assert sticky single-replica routing and silence this warning.',
    );
  };

  /** A held single-writer lock: a store token, or the local-set fallback marker. */
  type HeldLock = { kind: 'store'; token: string } | { kind: 'local' };

  /** Acquire the single-writer lock for `id`. Returns null if already held. */
  const acquireLock = async (id: string): Promise<HeldLock | null> => {
    if (sessions.acquireLock) {
      const lock = await sessions.acquireLock(id, lockLeaseMs);
      return lock ? { kind: 'store', token: lock.token } : null;
    }
    warnIfUnsafe();
    if (inFlight.has(id)) return null;
    inFlight.add(id);
    return { kind: 'local' };
  };
  /** Extend the lease. Returns false if ownership was lost (caller must stop writing). */
  const renewLock = async (id: string, held: HeldLock): Promise<boolean> => {
    if (held.kind === 'local') return true; // process-local set never expires
    if (!sessions.renewLock) return true; // no renewer → best-effort (lease should exceed op time)
    return sessions.renewLock(id, held.token, lockLeaseMs);
  };
  /** Release the lock, fenced by its token. */
  const releaseLock = async (id: string, held: HeldLock): Promise<void> => {
    if (held.kind === 'store') {
      await sessions.releaseLock?.(id, held.token);
      return;
    }
    inFlight.delete(id);
  };

  const stagingPath = (id: string): string => join(stagingDir, id);

  const baseHeaders = (extra: Record<string, string> = {}): Record<string, string> => ({
    'Tus-Resumable': TUS_VERSION,
    ...extra,
  });

  const respond = (status: number, extra: Record<string, string> = {}, mediaId?: string): TusResponse => ({
    status,
    headers: baseHeaders(extra),
    ...(mediaId !== undefined && { mediaId }),
  });

  const expiresHeader = (session: TusSession): Record<string, string> => ({
    'Upload-Expires': new Date(session.expiresAt).toUTCString(),
  });

  const destroy = async (id: string): Promise<void> => {
    await sessions.delete(id);
    await rm(stagingPath(id), { force: true });
  };

  const appendBody = async (
    id: string,
    body: NonNullable<TusRequest['body']>,
    maxBytes: number,
    lockLost?: () => boolean,
  ): Promise<number> => {
    const file = createWriteStream(stagingPath(id), { flags: 'a' });
    let written = 0;
    try {
      const iterable: AsyncIterable<Uint8Array> | Uint8Array[] =
        body instanceof Uint8Array ? [body] : (body as AsyncIterable<Uint8Array>);
      for await (const chunk of iterable) {
        // Ownership check BEFORE writing each chunk — if the distributed lease
        // expired and another worker took over, stop immediately rather than
        // append to a file a second writer may also be touching.
        if (lockLost?.()) {
          file.destroy();
          throw new TusLockLostError();
        }
        written += chunk.byteLength;
        // Enforce the remaining-length allowance WHILE streaming, so a client
        // that declared a small Upload-Length can't stream an arbitrarily large
        // PATCH body and exhaust disk/bandwidth before the post-hoc length
        // check. Bounds staged growth to at most maxBytes + one chunk.
        if (written > maxBytes) {
          file.destroy();
          throw new TusOverflowError();
        }
        if (!file.write(chunk)) {
          await new Promise<void>((resolve, reject) => {
            file.once('drain', resolve);
            file.once('error', reject);
          });
        }
      }
      await new Promise<void>((resolve, reject) => {
        file.end((err?: Error | null) => (err ? reject(err) : resolve()));
      });
      return written;
    } catch (err) {
      file.destroy();
      throw err;
    }
  };

  const finalize = async (session: TusSession): Promise<IMediaDocument> => {
    const buffer = await readFile(stagingPath(session.id));
    const doc = await media.upload(
      {
        buffer,
        filename: session.metadata.filename || `upload-${session.id}`,
        mimeType: session.metadata.filetype || session.metadata.contentType || 'application/octet-stream',
        ...(session.upload.folder !== undefined && { folder: session.upload.folder }),
        ...(session.upload.visibility !== undefined && { visibility: session.upload.visibility }),
      },
      session.upload.context,
    );
    await destroy(session.id);
    await onComplete?.(doc, session);
    return doc;
  };

  const handleCreate = async (request: TusRequest, options: TusHandleOptions): Promise<TusResponse> => {
    const lengthRaw = header(request.headers, 'Upload-Length');
    if (lengthRaw === undefined) {
      // creation-defer-length is deliberately unsupported — the pipeline
      // needs the size up front for the maxSize gate.
      return respond(400);
    }
    const length = Number(lengthRaw);
    if (!Number.isInteger(length) || length < 0) return respond(400);
    if (length > maxSize) return respond(413, { 'Tus-Max-Size': String(maxSize) });

    const session: TusSession = {
      id: randomUUID(),
      length,
      offset: 0,
      metadata: parseMetadata(header(request.headers, 'Upload-Metadata')),
      createdAt: Date.now(),
      expiresAt: Date.now() + ttlMs,
      upload: {
        ...(options.folder !== undefined && { folder: options.folder }),
        ...(options.visibility !== undefined && { visibility: options.visibility }),
        ...(options.ctx !== undefined && { context: options.ctx }),
      },
    };
    await mkdir(stagingDir, { recursive: true });
    await sessions.create(session);

    // Zero-length uploads complete at creation (spec: no PATCH will follow).
    if (length === 0) {
      await appendBody(session.id, new Uint8Array(0), 0);
      const doc = await finalize(session);
      return respond(201, { Location: `${basePath}/${session.id}`, 'Upload-Offset': '0' }, String(doc._id));
    }

    return respond(201, { Location: `${basePath}/${session.id}`, ...expiresHeader(session) });
  };

  const getLiveSession = async (id: string | null | undefined): Promise<TusSession | 'missing' | 'expired'> => {
    if (!id || !/^[0-9a-f-]{36}$/i.test(id)) return 'missing';
    const session = await sessions.get(id);
    if (!session) return 'missing';
    if (session.expiresAt <= Date.now()) {
      await destroy(id);
      return 'expired';
    }
    return session;
  };

  const handleHead = async (request: TusRequest): Promise<TusResponse> => {
    const session = await getLiveSession(request.uploadId);
    if (session === 'missing') return respond(404, { 'Cache-Control': 'no-store' });
    if (session === 'expired') return respond(410, { 'Cache-Control': 'no-store' });
    return respond(200, {
      'Upload-Offset': String(session.offset),
      'Upload-Length': String(session.length),
      'Cache-Control': 'no-store',
      ...expiresHeader(session),
    });
  };

  const handlePatch = async (request: TusRequest): Promise<TusResponse> => {
    if (header(request.headers, 'Content-Type') !== 'application/offset+octet-stream') {
      return respond(415);
    }
    const session = await getLiveSession(request.uploadId);
    if (session === 'missing') return respond(404);
    if (session === 'expired') return respond(410);

    const claimedOffset = Number(header(request.headers, 'Upload-Offset'));
    if (!Number.isInteger(claimedOffset) || claimedOffset !== session.offset) {
      return respond(409, { 'Upload-Offset': String(session.offset) });
    }
    if (!request.body) return respond(400);
    // Single-writer lock (token-fenced + cross-replica when the store
    // implements it) — a second concurrent PATCH gets 423 Locked.
    const held = await acquireLock(session.id);
    if (!held) return respond(423);

    // Auto-renew the operation lease as the body streams; if a renew ever
    // reports the lock lost, flag it so appendBody stops writing at the next
    // chunk boundary. (No-op for the process-local fallback lock.)
    let lockLost = false;
    const renewTimer =
      held.kind === 'store'
        ? setInterval(
            () => {
              void renewLock(session.id, held).then((ok) => {
                if (!ok) lockLost = true;
              });
            },
            Math.max(1000, Math.floor(lockLeaseMs / 2)),
          )
        : undefined;
    renewTimer?.unref?.();

    try {
      // Staged size is the ground truth — a crash mid-append can leave the
      // store's offset behind the file. Trust the file.
      const staged = await stat(stagingPath(session.id)).then(
        (s) => s.size,
        () => 0,
      );
      if (staged !== session.offset) {
        session.offset = staged;
        await sessions.setOffset(session.id, staged);
        return respond(409, { 'Upload-Offset': String(staged) });
      }

      // Remaining allowance — appendBody aborts mid-stream if the body exceeds
      // it (so an oversized PATCH is rejected without being fully staged).
      const remaining = session.length - session.offset;
      let written: number;
      try {
        written = await appendBody(session.id, request.body, remaining, () => lockLost);
      } catch (err) {
        if (err instanceof TusOverflowError) {
          await destroy(session.id);
          return respond(400);
        }
        if (err instanceof TusLockLostError) {
          // Ownership lost mid-write — do NOT advance the offset. The staged
          // file is authoritative on the client's next PATCH (409 re-sync).
          const size = await stat(stagingPath(session.id)).then(
            (s) => s.size,
            () => session.offset,
          );
          session.offset = size;
          await sessions.setOffset(session.id, size);
          return respond(409, { 'Upload-Offset': String(size) });
        }
        throw err;
      }
      const newOffset = session.offset + written;
      if (newOffset > session.length) {
        await destroy(session.id);
        return respond(400);
      }
      session.offset = newOffset;
      await sessions.setOffset(session.id, newOffset);

      if (newOffset === session.length) {
        const doc = await finalize(session);
        return respond(204, { 'Upload-Offset': String(newOffset) }, String(doc._id));
      }
      return respond(204, { 'Upload-Offset': String(newOffset), ...expiresHeader(session) });
    } finally {
      if (renewTimer) clearInterval(renewTimer);
      await releaseLock(session.id, held);
    }
  };

  const handleDelete = async (request: TusRequest): Promise<TusResponse> => {
    const session = await getLiveSession(request.uploadId);
    if (session === 'missing') return respond(404);
    if (session === 'expired') return respond(410);
    await destroy(session.id);
    return respond(204);
  };

  return {
    async handle(request, options = {}) {
      const method = request.method.toUpperCase();

      if (method === 'OPTIONS') {
        return respond(204, {
          'Tus-Version': TUS_VERSION,
          'Tus-Extension': TUS_EXTENSIONS,
          'Tus-Max-Size': String(maxSize),
        });
      }

      // Spec: every non-OPTIONS request MUST carry a supported Tus-Resumable.
      const clientVersion = header(request.headers, 'Tus-Resumable');
      if (clientVersion !== TUS_VERSION) {
        return respond(412, { 'Tus-Version': TUS_VERSION });
      }

      switch (method) {
        case 'POST':
          return handleCreate(request, options);
        case 'HEAD':
          return handleHead(request);
        case 'PATCH':
          return handlePatch(request);
        case 'DELETE':
          return handleDelete(request);
        default:
          return respond(405, { Allow: 'OPTIONS, POST, HEAD, PATCH, DELETE' });
      }
    },

    async sweepExpired(now = Date.now()) {
      let removed = 0;
      for (const session of await sessions.list()) {
        if (session.expiresAt <= now && !inFlight.has(session.id)) {
          await destroy(session.id);
          removed++;
        }
      }
      return removed;
    },
  };
}
