# Changelog

Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
adhering to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [3.0.0] — 2026-04-15

Full rewrite. **Breaking — no backward compatibility** with v2.x.
v2.1.0 preserved at git tag `v2.1.0` for reference.

### Added

- **Engine-factory pattern** — `createMedia(config)` returns a frozen
  `MediaEngine` with `repositories`, `events`, `models`, `driver`, `bridges`,
  and `dispose()`. Package owns its models — host passes `connection`, not
  a built model. No more `.init(model)`.
- **Repository as API surface** — `MediaRepository` extends mongokit's
  `Repository<IMediaDocument>` directly. All 50+ proxy methods from v2
  removed. Callers use inherited mongokit methods (`getById`, `getAll`,
  `update`, etc.) for CRUD, and domain verbs (`upload`, `hardDelete`,
  `move`, `addTags`, `setFocalPoint`) for media-specific operations.
- **Arc-compatible `EventTransport`** — replaces the custom
  `MediaEventEmitter`. Shape matches `@classytic/arc` exactly; any Arc
  transport (Memory / Redis / Kafka) drops in as `config.eventTransport`.
  Default: `InProcessMediaBus` with exact / `*` / `media.*` glob matching.
- **Event names follow `media:resource.verb`** — 16 constants under
  `MEDIA_EVENTS`. Subscribe glob-style: `engine.events.subscribe('media:asset.*', ...)`.
- **Dynamic `tenantFieldType`** — `'objectId' | 'string'` config drives
  both schema generation and `multiTenantPlugin` casting. Enables
  `$lookup` / `.populate()` for ObjectId-based auth (Better Auth). Requires
  `@classytic/mongokit >=3.6.2`.
- **Bridges** — four host-implemented extension points:
  - `SourceBridge` — polymorphic `sourceId`/`sourceModel` resolution for
    cross-package and microservice media↔entity links. `resolveMany()` for
    N+1-free batch enrichment.
  - `ScanBridge` — upload-time content scanning with `clean` / `reject` /
    `quarantine` verdicts. Reject throws; quarantine stores with
    `status: 'error'` + scan metadata.
  - `CdnBridge` — URL rewriting for main + variant URLs (imgix, CloudFront
    signing, custom). `engine.repositories.media.getAssetUrl(media)`.
  - `TransformBridge` — pluggable URL-param ops (`?op=bg-remove,upscale`).
    Build ImageKit-like on-the-fly AI transforms with any stack (Replicate,
    Fal, OpenAI). `engine.repositories.media.applyTransforms(id, { ops, params })`.
- **Polymorphic source fields** — `sourceId: String` + `sourceModel: String`
  on the schema (indexed). Works for any ID format (ObjectId hex, UUID,
  Stripe ID, external REST IDs) via `SourceBridge`.
- **Soft delete via mongokit's `softDeletePlugin`** — replaces custom
  hook-based implementation. `repo.delete(id)` is soft when enabled;
  `repo.hardDelete(id)` is the domain verb for storage + DB cleanup.
  `repo.restore(id)` and `repo.getDeleted()` inherit from the plugin.
- **Zod v4 config schemas** — exported from `/schemas` subpath. Arc
  auto-converts to OpenAPI via `z.toJSONSchema()`. `mediaConfigSchema`,
  `uploadInputSchema`, `confirmUploadSchema`, etc. All numeric bounds use
  `.int().min(1)` rather than `.positive()` so `z.toJSONSchema()` emits
  numeric `minimum` (portable across OpenAPI 3.0 + draft-2020-12) instead
  of boolean `exclusiveMinimum` (which Fastify AJV rejects).
- **Testing infrastructure** — four tiers per the testing-infrastructure
  spec (unit / integration / e2e / smoke). 368 unit+integration tests,
  22 e2e tests (16 pass + 6 GCS-gated), 16 smoke checks, microbenchmarks.
  `test:unit`, `test:integration`, `test:e2e`, `test:smoke`, `test:bench`.
- **Real provider e2e tests** — verified against a live S3 bucket with
  full engine flow (upload → replace → hardDelete → move → events).
  GCS tests skip gracefully when the key file is missing.
- **Capabilities test** — proves extensibility by building an ImageKit-like
  solution on media-kit primitives (auto-tag, face-detect, embed,
  on-the-fly AI transforms, CDN, source resolution, moderation).
- **`applyTransforms` domain verb** — reads a media's buffer from storage,
  pipes through a named op pipeline, returns the transformed buffer +
  mimeType. The primitive behind `GET /transform/:id?op=...` routes.
- **`resolveSource` / `resolveSourcesMany` / `getAssetUrl` / `getVariantUrls`**
  — bridge-backed domain verbs on the repository.
- **`CLAUDE.md`** — agent-facing guide. "Read this before touching the package."
- **`/schemas` subpath export** — Zod v4 schemas for Arc auto-docs.

### Changed

- **Peer deps bumped.** `@classytic/mongokit >=3.6.2` (was `>=3.3.2`),
  `mongoose >=9.4.1` (was `>=9.3.1`). `zod >=4.0.0` added.
- **Package is ESM-only** (was already; kept).
- **`MediaContext`** replaces `OperationContext` — still accepts `ObjectId`
  or `string` for `userId` / `organizationId` for back-compat in signatures,
  but coerces to string when propagating to events.
- **`hardDelete` is idempotent** under parallel calls. Concurrent calls on
  the same id return `true` once + `false` thereafter (or no-op), never throw.

### Removed

- **`MediaKit` class** — replaced by `MediaEngine` (frozen object). No
  more `new MediaKitImpl()`, no `.init()`, no instance methods.
- **`createMediaSchema` / `MediaSchema` exports** — schema is internal;
  package creates models. Hosts cannot inject a pre-built schema.
- **`MediaEventEmitter`** — replaced by Arc-compatible `EventTransport`.
- **Event names `before:upload` / `after:upload` / `error:upload`** etc. —
  replaced by `media:asset.uploaded` + mongokit `before:create` hooks.
- **50+ proxy methods on the main class** — `getMediaById`, `getAllMedia`,
  `updateMedia`, `deleteMedia`, `searchMedia`, `getByFolder`, `getByMimeType`,
  `findByTag`, etc. Callers use inherited mongokit methods directly.
- **Manual soft-delete hook registration** — uses `softDeletePlugin` now.
- **`softDelete` / `restore` domain verbs** — inherited from `softDeletePlugin`
  (`repo.delete` / `repo.restore` when `softDelete.enabled: true`).

### Migration from v2

v3 is a clean break. Reference `git checkout v2.1.0` for the v2 API.
No codemod is shipped; the mental model is different enough that manual
migration is cleaner. See `CLAUDE.md` and `README.md` for the v3 patterns.
