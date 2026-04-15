# @classytic/media-kit — Agent Guide

> **Read this before touching the package.**

## What this is

A framework-agnostic engine-factory for media management. MongoDB via
`@classytic/mongokit`, pluggable storage, arc-compatible events, and
four bridges (source / scan / cdn / transform) as the extension surface.

## What problem it solves

Every app rewrites the upload → store → process → serve → search pipeline.
media-kit is the primitive: status lifecycle, hash-based dedup, multi-tenant
scoping, soft delete, keyset pagination, and domain verbs on a real mongokit
repository — all composable. Hosts plug AI/CDN/external systems via bridges.

## How hosts activate features

No modes. No feature flags. Pass what you need; what lights up depends on
what's present:

| What the host passes | What lights up |
|---|---|
| `connection + driver` (required) | Upload, query, delete, folder ops, pagination |
| `multiTenancy: { enabled: true }` | `organizationId` scoping on every query |
| `softDelete: { enabled: true }` | `repo.delete()` soft, `restore`, `getDeleted`, TTL GC |
| `deduplication: { enabled: true }` | Hash-based dedup on upload |
| `processing: { enabled: true }` | Sharp processing, variants, ThumbHash |
| `eventTransport` | Arc-compatible glob pub/sub (redis/kafka/memory) |
| `bridges.source` | Polymorphic `sourceId/sourceModel` resolution |
| `bridges.scan` | Upload-time moderation verdicts |
| `bridges.cdn` | URL rewriting via CDN / image service |
| `bridges.transform` | On-the-fly URL-based AI transform ops |

One engine. One `createMedia()` call. No tiers.

## When to use media-kit

- You manage uploaded files in MongoDB and need dedup, variants, soft delete,
  multi-tenancy, and arc-compatible events out of the box.
- You want to **compose** an ImageKit-like stack from primitives (your AI
  choice, your CDN choice, your search backend) without vendor lock-in.
- You need mongokit pagination + keyset scrolling on media list endpoints.

## When to skip media-kit

| Use case | Use instead |
|---|---|
| Fully-hosted DAM with built-in AI / CDN / DAM UI | ImageKit, Cloudinary, Mux |
| One-off file uploads (no DB) | Raw `@aws-sdk/client-s3` or similar |
| Read-only public file serving | CDN + direct storage URLs |
| Non-Mongo data layer | Roll your own on top of the driver contract |

## Boundary — what media-kit owns

**media-kit owns:**
- Media document schema (sanitized filename, hash, status lifecycle,
  variants, focal point, polymorphic source ref)
- Upload pipeline (validate → scan → dedup → process → store → persist)
- Storage driver contract (S3, GCS, Local, Router — all swappable)
- Events via Arc-compatible `EventTransport`
- Dynamic tenant-field type (`'objectId' | 'string'`)
- Soft-delete via mongokit's `softDeletePlugin` (not custom hooks)
- Folder ops (tree, stats, rename, move, subfolders)
- Presigned + multipart + resumable upload flows
- Bridge contracts (SourceBridge, ScanBridge, CdnBridge, TransformBridge)

**media-kit does NOT own:**
- Image AI (bg-remove, upscale, face-detect) — host wires `TransformBridge`
- CDN signing / URL transformation — host wires `CdnBridge`
- Content moderation / NSFW detection — host wires `ScanBridge`
- Search / embeddings — host subscribes to `media:asset.uploaded` and writes
  to mongokit's vector search (or any backend)
- Video transcoding — host provides `VideoAdapter`
- RAW image conversion — host provides `RawAdapter`
- Payment / order / fulfillment — other packages

**Rule:** media-kit's responsibility ends at the Mongoose document +
storage write. Everything after — CDN, AI, search — is host territory.
Events give hosts hooks to integrate cleanly.

## Upload status lifecycle

```
pending → processing → ready
                    ↓
                   error   (on any step failure)
                    ↓
               quarantine   (scan verdict: quarantine → error with reason)
```

Every upload transitions through this. Orphan variant files are cleaned up
on failure. Hosts subscribe to `media:asset.uploaded` to enrich at `ready`.

## Integration with other packages

### `@classytic/mongokit`

`MediaRepository` extends `Repository<IMediaDocument>` directly. Hosts get
the full mongokit surface — pagination, transactions, plugins, hooks,
aggregation — on top of the media domain verbs. No wrapping.

### `@classytic/arc`

media-kit does NOT import from arc. Integration is structural:
- `events: EventTransport` is shape-identical to arc's `EventTransport`;
  pass `new RedisEventTransport({...})` straight into `createMedia({ eventTransport })`.
- `MediaRepository` extends `Repository<T>`; arc's `createMongooseAdapter()`
  accepts it directly via `defineResource({ adapter: ... })`.
- Zod schemas at `./schemas` convert to OpenAPI via `z.toJSONSchema()` —
  arc auto-generates docs.
- Events use `media:resource.verb` naming — arc's glob subscriptions
  (`media:*`, `media:asset.*`) just work.

### `@classytic/cart` / other packages

media-kit is a leaf — nothing in the commerce graph imports it. Hosts
attach media to products / orders / articles via the polymorphic
`sourceId` + `sourceModel` fields and resolve through `SourceBridge`.

## Repository pattern

`MediaRepository` inherits directly from mongokit's `Repository<T>`:

```ts
export class MediaRepository extends Repository<IMediaDocument> {
  constructor(model, plugins, deps: MediaRepositoryDeps, pagination?) {
    super(model, plugins, pagination);
    // deps: { events, config, driver, processor, bridges, logger }
  }
  // Domain verbs alongside inherited CRUD + pagination + hooks
}
```

No service layer. No proxy methods. Callers use inherited mongokit methods
directly for list/get/update/etc., and domain verbs for upload/delete/move.

## Responses are raw mongokit shapes

media-kit NEVER wraps responses in `{ success, data }` envelopes. Arc's
`BaseController` does that. Shape contract:

| Op | Returns |
|---|---|
| `getById(id)` | `IMediaDocument \| null` |
| `getAll({ page, limit })` | `OffsetPaginationResult<IMediaDocument>` (mongokit shape) |
| `getAll({ sort, limit })` | `KeysetPaginationResult<IMediaDocument>` (mongokit shape) |
| `count(query)` | `number` |
| `exists(query)` | `{ _id } \| null` |
| `upload(input, ctx)` | `IMediaDocument` |
| `hardDelete(id)` | `boolean` |
| `hardDeleteMany(ids)` | `BulkResult` (package-specific for tracking failures) |
| `move(ids, folder)` | `RewriteResult` (package-specific) |

Locked by `tests/integration/mongokit-passthrough.test.ts`.

## Events follow `media:resource.verb`

```ts
MEDIA_EVENTS.ASSET_UPLOADED           = 'media:asset.uploaded'
MEDIA_EVENTS.ASSET_DELETED            = 'media:asset.deleted'
MEDIA_EVENTS.ASSET_REPLACED           = 'media:asset.replaced'
MEDIA_EVENTS.ASSET_MOVED              = 'media:asset.moved'
MEDIA_EVENTS.FOLDER_RENAMED           = 'media:folder.renamed'
// ... (see src/events/event-constants.ts for all 16)
```

Hosts subscribe glob-style; that's the post-upload pipeline:

```ts
await engine.events.subscribe('media:asset.uploaded', async (event) => {
  await autoTag(event.payload.assetId);
  await generateEmbedding(event.payload.assetId);
  await detectFace(event.payload.assetId);
});
```

## Do NOT

- Wrap `Repository<T>` — extend it directly.
- Add arc / fastify / express / nest as dependencies.
- Import from other `@classytic/*` packages (leaf package, no coupling).
- Hardcode `organizationId: { type: String }` or `ObjectId` — it's dynamic
  via `tenantFieldType` engine config.
- Modify mongokit responses — `getAll` returns mongokit's paginated shape
  verbatim. Arc wraps.
- Use `repo.delete()` to mean "hard delete" when `softDeletePlugin` is on —
  use `repo.hardDelete(id)` (domain verb) or `repo.delete(id, { mode: 'hard' })`.
- Put AI / CDN / search logic inside media-kit — those are bridges or
  event subscriptions.
- Ship any default ImageAdapter / ScanBridge / CdnBridge / TransformBridge
  (except the Sharp-based default ImageAdapter) — hosts compose.
- Rename inherited mongokit methods (`getById`, `getAll`, etc.) as
  `findMedia` / `listMedia` — those are proxy methods, violate PACKAGE_RULES.
- Use MongoDB TTL for business logic — TTL is a GC backstop for soft delete.
- Hardcode `ref: 'Organization'` or any model name — all refs are dynamic.

## Scan verdicts — the quarantine semantics

```ts
scan(buffer, mimeType, filename, ctx) → {
  verdict: 'clean' | 'reject' | 'quarantine',
  reason?: string,
  metadata?: Record<string, unknown>,
}
```

- `reject` → upload throws. Nothing persisted. Host sees the error.
- `quarantine` → upload proceeds, file written to storage, BUT doc has
  `status: 'error'` + `errorMessage: 'Quarantined: <reason>'` + metadata
  stashed under `doc.metadata.scanMetadata`. Manual review UI queries by
  status and renders from stored metadata.
- `clean` → normal flow. `status: 'ready'` at the end.

Thrown scanner errors are treated as `reject` (fail-closed).

## Session threading (for outbox / transactions)

Every domain verb accepts `ctx.session` and threads it through internal
`update` / `create` / `delete` calls (PACKAGE_RULES §17). Hosts wire an
outbox by subscribing to `before:create` / `before:update` mongokit hooks
and writing an outbox row with `ctx.session` in the same transaction.

## Files you should know

| What | Where |
|---|---|
| Engine factory | `src/engine/create-media.ts` |
| Engine config + types | `src/engine/engine-types.ts` |
| Repository (domain verbs) | `src/repositories/media.repository.ts` |
| Repository factory (plugin composition) | `src/repositories/create-repositories.ts` |
| Schema factory (dynamic tenant field) | `src/models/media.schema.ts` |
| Tenant field helper | `src/models/tenant-field.ts` |
| Event transport (arc-compatible shape) | `src/events/transport.ts` |
| Event constants (`media:resource.verb`) | `src/events/event-constants.ts` |
| Typed event payloads | `src/events/event-payloads.ts` |
| In-process bus fallback | `src/events/in-process-bus.ts` |
| Bridge interfaces | `src/bridges/*.bridge.ts` |
| Zod config schemas | `src/validators/*.schema.ts` |
| Storage driver contract | `src/types.ts` (`StorageDriver`) |
| S3 / GCS / Local / Router | `src/providers/` |
| Image processing (Sharp-based) | `src/processing/image.ts` |
| Asset transform service | `src/transforms/asset-transform.ts` |
| Capabilities test (proves extensibility) | `tests/integration/capabilities-imagekit-like.test.ts` |
| Mongokit passthrough lock-in | `tests/integration/mongokit-passthrough.test.ts` |
| Concurrency + race safety | `tests/integration/concurrency.test.ts` |
| Smoke test (dist hygiene) | `tests/smoke/dist-exports.mjs` |

## Test commands

```bash
npm test                 # unit + integration (default)
npm run test:unit        # fastest feedback
npm run test:integration # mongo-memory + memory driver
npm run test:e2e         # real S3 / GCS (gated by env)
npm run test:smoke       # dist exports sanity
npm run test:bench       # microbenchmarks
```
