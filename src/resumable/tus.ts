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
import type { IMediaDocument, MediaVisibility, UploadInput } from '../types';

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
 */
export interface TusSessionStore {
  create(session: TusSession): void | Promise<void>;
  get(id: string): TusSession | null | Promise<TusSession | null>;
  setOffset(id: string, offset: number): void | Promise<void>;
  delete(id: string): void | Promise<void>;
  list(): TusSession[] | Promise<TusSession[]>;
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
  /** Session store. Default in-memory. */
  sessions?: TusSessionStore;
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
    sessions = createMemoryTusSessionStore(),
    onComplete,
  } = config;

  // One PATCH at a time per upload — concurrent chunk appends would corrupt
  // the staging file. Second writer gets 423 Locked (tusd behavior).
  const inFlight = new Set<string>();

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

  const appendBody = async (id: string, body: NonNullable<TusRequest['body']>): Promise<number> => {
    const file = createWriteStream(stagingPath(id), { flags: 'a' });
    let written = 0;
    try {
      const iterable: AsyncIterable<Uint8Array> | Uint8Array[] =
        body instanceof Uint8Array ? [body] : (body as AsyncIterable<Uint8Array>);
      for await (const chunk of iterable) {
        written += chunk.byteLength;
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
      await appendBody(session.id, new Uint8Array(0));
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
    if (inFlight.has(session.id)) return respond(423);

    inFlight.add(session.id);
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

      const written = await appendBody(session.id, request.body);
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
      inFlight.delete(session.id);
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
