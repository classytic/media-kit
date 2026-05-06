# Changelog

Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
adhering to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [3.4.0] — 2026-05-06

### Added — Multi-provider routing, providerMetadata, expiresAt, Cloudinary

#### Multi-provider routing (`DriverRegistry`)

Hosts can now wire multiple storage providers into a single engine and route individual uploads to the correct backend at call time:

```ts
import { CloudinaryProvider } from '@classytic/media-kit/providers/cloudinary';
import { S3Provider } from '@classytic/media-kit/providers/s3';

const engine = await createMedia({
  connection,
  providers: {
    originals: new S3Provider({ bucket: 'originals', region: 'us-east-1' }),
    cdn:       new CloudinaryProvider({ cloudName, apiKey, apiSecret }),
  },
  defaultProvider: 'originals',
});

// Route to CDN for this upload
const media = await engine.repositories.media.upload({
  buffer, filename: 'photo.jpg', mimeType: 'image/jpeg',
  provider: 'cdn',
});

// media.provider === 'cdn' — stored on the document, used for all routing
```

The `media.provider` field is stored on every document and used for all subsequent operations — `hardDelete`, `replace`, `getAssetUrl`, `applyTransforms` — so routing is automatic and transparent. Pre-existing documents without `provider` fall back to the engine's `defaultProvider`.

`engine.registry` exposes the `DriverRegistry` instance. `engine.driver` remains a shorthand for the default driver (backward-compatible).

Single-driver `driver:` config still works unchanged.

#### `providerMetadata`

`StorageDriver.write()` can now return `metadata?: Record<string, unknown>` alongside `key`, `url`, `size`. This is stored on the media document as `providerMetadata`. Built-in providers:

| Provider | Stored metadata |
|---|---|
| ImageKit | `fileId`, `filePath`, `name`, `width?`, `height?`, `fileType?` |
| imgbb | `id`, `displayUrl`, `deleteUrl`, `width?`, `height?` |
| Cloudinary | `publicId`, `resourceType`, `format`, `assetId?`, `etag?`, `width?`, `height?` |
| S3 | `bucket` |

#### `expiresAt` — temporary asset lifetime

Upload inputs now accept `expiresAt?: Date`. Assets with an expiry date are eligible for programmatic purge via `purgeExpired()`. This is intentionally **not** a MongoDB TTL index — code-driven purge ensures storage files are removed before the document:

```ts
// Upload a temporary asset (e.g. upload draft, session-scoped preview)
const media = await engine.repositories.media.upload({
  buffer, filename: 'draft.jpg', mimeType: 'image/jpeg',
  expiresAt: new Date(Date.now() + 24 * 3600_000), // expires in 24 hours
});

// Run from a cron job — purges all assets past their expiresAt
const result = await engine.repositories.media.purgeExpired();
// result.success — IDs purged from storage + DB
// result.failed  — IDs that failed (file/doc may still exist)
// Fires: media:assets.expired event

// Pre-expiry notification window
const expiringSoon = await engine.repositories.media.getExpiringSoon(2); // within 2 hours
```

Fires `media:assets.expired` (`AssetsExpiredPayload`) after each batch with `purgedIds`, `failedIds`, `before`, `purgedCount`, `failedCount`.

#### Cloudinary provider (`@classytic/media-kit/providers/cloudinary`)

New `CloudinaryProvider` — transformation-first media CDN with automatic format negotiation and quality optimisation. No SDK dependency — uses Cloudinary's REST Upload API + Admin API directly via `node:crypto` signed requests.

```ts
import { CloudinaryProvider } from '@classytic/media-kit/providers/cloudinary';

const engine = await createMedia({
  connection,
  driver: new CloudinaryProvider({
    cloudName:   process.env.CLOUDINARY_CLOUD_NAME,
    apiKey:      process.env.CLOUDINARY_API_KEY,
    apiSecret:   process.env.CLOUDINARY_API_SECRET,
    folder:      'my-app/media',
    autoOptimize: true, // f_auto,q_auto on image delivery URLs (default: true)
  }),
  processing: { enabled: false }, // Cloudinary handles optimisation
});
```

- Uploads via `resource_type: auto` — Cloudinary detects image/video/raw from file content
- `getPublicUrl()` includes `f_auto,q_auto` for image URLs when `autoOptimize: true` (default) — automatic WebP/AVIF delivery to supporting browsers
- Key encoding: `publicId\nresourceType` — stable across CDN domain changes
- Implements: `write`, `read`, `delete` (with CDN cache invalidation), `exists`, `stat`, `list`, `getPublicUrl`

---

## [3.3.0] — 2026-05-06

### Added — imgbb and ImageKit storage providers

Two new `StorageDriver` implementations ship as opt-in subpath imports — no new peer deps, no impact on existing builds.

**imgbb** (`@classytic/media-kit/providers/imgbb`) — free public image hosting via the imgbb API. Suitable for development, prototyping, or low-volume deployments where a managed CDN is not required. Key encoding: `displayUrl\ndeleteUrl` (composite — both URLs are stored in the single key so `delete()` can reach the imgbb delete endpoint without a second lookup).

```ts
import { ImgbbProvider } from '@classytic/media-kit/providers/imgbb';

const engine = await createMedia({
  connection: mongoose.connection,
  driver: new ImgbbProvider({ apiKey: process.env.IMGBB_API_KEY }),
  processing: { enabled: true }, // sharp still runs; imgbb stores the result
});
```

**ImageKit** (`@classytic/media-kit/providers/imagekit`) — managed CDN with built-in real-time image optimization, transformations, and global delivery. When using ImageKit, set `processing: { enabled: false }` — ImageKit handles compression, format conversion, and resizing on-the-fly via URL transformation parameters (e.g. `url + '?tr=w-400,h-300'`). Key encoding: `fileId\nfilePath` — `fileId` is used for Management API deletes; `filePath` reconstructs the transformation-ready CDN URL via `getPublicUrl(key)`.

```ts
import { ImageKitProvider } from '@classytic/media-kit/providers/imagekit';

const engine = await createMedia({
  connection: mongoose.connection,
  driver: new ImageKitProvider({
    publicKey: process.env.IMAGEKIT_PUBLIC_KEY,
    privateKey: process.env.IMAGEKIT_PRIVATE_KEY,
    urlEndpoint: 'https://ik.imagekit.io/your-id',
    defaultFolder: 'media',
  }),
  processing: { enabled: false }, // ImageKit handles optimization
});
```

Both providers implement the full `StorageDriver` interface: `write`, `read`, `delete`, `exists`, `stat`, `getPublicUrl`, and `list` (ImageKit only — imgbb has no list API). E2E tests against the real ImageKit API ship in `tests/e2e/imagekit-provider.e2e.test.ts`.

---

Adopts `@classytic/primitives` 0.3.1's `defineStateMachine` + `assertAndClaim` for the upload pipeline. Replaces the hand-rolled inline `claim()` calls landed in 3.2.0 with a centralised state-machine declaration that:

- **Locks the legal-transition table** in one declaration ([`src/models/media-state-machine.ts`](src/models/media-state-machine.ts)). Adding a state (`'archived'`, `'review'`, …) becomes a single-line edit; tsc errors propagate to every stale call site.
- **Surfaces malformed transitions BEFORE the database round-trip.** `assertAndClaim` synchronously throws `IllegalTransitionError` if a developer skips a state (e.g. `pending → ready`) — previously that would just race and produce a confusing `null`.
- **Replaces the hand-rolled `$in: ['pending', 'processing']` filter** in the error-path catch handler with `MEDIA_MACHINE.validSources('error')` — reverse-adjacency lookup driven by the state-machine declaration. Adding a future state that can also error (e.g. `'reviewing'`) propagates to every error handler for free.

### Changed — upload pipeline uses `assertAndClaim`

Every status transition in the upload pipeline now routes through `assertAndClaim(MEDIA_MACHINE, repo, id, args)`. Behavioural net-effect is identical to 3.2.0 (same atomic CAS, same `null`-on-race semantics) — the addition is the **synchronous domain check** that catches malformed transitions at the call site instead of at the database.

```ts
// Before (3.2.0):
const claimed = await deps.repository.claim(
  mediaId,
  { from: 'pending', to: 'processing' },
  {},
  context,
);

// After (3.3.0):
const claimed = await assertAndClaim(MEDIA_MACHINE, deps.repository, mediaId, {
  from: 'pending',
  to: 'processing',
  options: context,
});
```

Migrated sites:
- [`src/repositories/media.repository.ts`](src/repositories/media.repository.ts) — inline `_performUpload` (Step 2 + Step 4 + error catch).
- [`src/operations/upload.ts`](src/operations/upload.ts) — `performUpload` operation helper (Step 2 + Step 4 + error catch).
- [`src/operations/presigned.ts`](src/operations/presigned.ts) — `confirmUpload` and `completeMultipartUpload` post-confirm reprocessing (`ready → processing → ready` round-trip plus the failure-revert).

The error-path catch handlers all use `MEDIA_MACHINE.validSources('error')` to derive `from` from the state-machine table — no more hand-rolled `$in: [...]`. The reprocess-failure revert path uses the same `processing → ready` transition declared for the success path (the state graph doesn't distinguish "successful reprocess" from "rolled-back reprocess"; both land the row in `ready`).

### Added — `MEDIA_MACHINE` exported from `src/models/media-state-machine.ts`

```ts
import { MEDIA_MACHINE } from '@classytic/media-kit/models/media-state-machine';

// Caller-side state queries:
MEDIA_MACHINE.validTargets('pending'); // ['processing', 'error']
MEDIA_MACHINE.validSources('error');   // ['pending', 'processing']
MEDIA_MACHINE.isTerminal('error');     // true
MEDIA_MACHINE.canTransition('ready', 'processing'); // true (reprocess flow)
```

Hosts wiring custom workflows (re-process queues, manual recovery tooling, observability dashboards) can read the table directly rather than re-encoding it.

### Tests

- New unit suite [`tests/unit/media-state-machine.test.ts`](tests/unit/media-state-machine.test.ts) — 24 tests pinning every documented transition (`pending → processing`, `pending → error`, `processing → ready`, `processing → error`, `ready → processing` reprocess) AND the exhaustive-counterpart "rejects every illegal transition" guard. Includes the load-bearing `validSources('error')` properties: must include `pending` + `processing`, must NOT include `ready` (else a misbehaving retry could roll back a successful upload), must NOT include `error` (no idempotent self-claim).
- All 397 tests pass (was 373 → +24 new state-machine tests).
- `package-contents.test.ts` peer-dep floor bumped to `@classytic/primitives >=0.3.1`.

### Peer deps

- `@classytic/primitives`: bumped from `>=0.1.0` → `>=0.3.1` (uses `defineStateMachine`, `assertAndClaim`, `IllegalTransitionError`, `validSources` — all added in primitives 0.3.1).
- `@classytic/mongokit`: unchanged at `>=3.13.0` (the kit-level `claim()` API is the integration target for primitives' `assertAndClaim`; alignment is structural via primitives' `ClaimableRepo<TDoc>`).
- `@classytic/repo-core`: unchanged at `>=0.4.0`.

### Migration

No host-facing API changes. Existing callers of `upload()`, `confirmUpload()`, `completeMultipartUpload()` see identical inputs and outputs — the state-machine validation runs internally before the database round-trip.

**Behavioural change to be aware of:** if a host previously bypassed media-kit's domain layer and wrote directly to the underlying mongoose model with malformed status values (e.g. `Model.updateOne({ _id }, { status: 'unknown-state' })`), the status field is still mongoose-validated against `MediaStatus = 'pending' | 'processing' | 'ready' | 'error'`. The state machine adds a *transition-graph* validation on top — only legal `from → to` pairs are accepted via `assertAndClaim`. If a host calls `claim()` directly bypassing `assertAndClaim`, the previous "anything goes per claim's contract" behaviour persists. Hosts that want machine-validated transitions on their own writes should use `assertAndClaim(MEDIA_MACHINE, repo, ...)` rather than raw `claim()`.

## [3.2.0] — 2026-05-02

Adopts `@classytic/mongokit` 3.13 + `@classytic/repo-core` 0.4. Two
load-bearing wins: race-safe upload-pipeline state transitions via
`claim()`, and a long-standing plugin-pipeline-bypass bug fix in the tag
/ focal-point domain verbs.

### Fixed — plugin-pipeline bypass on `addTags` / `removeTags` / `setFocalPoint`

These three domain verbs called `this.Model.findOneAndUpdate(...)` (the
raw mongoose method) instead of `this.findOneAndUpdate(...)` (the repo
method). The raw mongoose call **bypasses every plugin** —
`multi-tenant`, `soft-delete`, `audit-log`, `audit-trail`, cache
invalidation, and any host hooks. That's a silent cross-tenant write
surface: a host with `multiTenantPlugin` mounted assumes every write
fires the tenant-scope hook, but these three verbs were silently
short-circuiting it.

Fixed in 3.2.0 — all three now route through `this.findOneAndUpdate`
with the standard options bag (`organizationId`, `session`,
`returnDocument: 'after'`). Hosts get tenant scope + soft-delete +
audit + cache invalidation on tags / focal-point writes for free.

### Changed — upload pipeline uses `claim()` for status transitions

The upload state machine (`pending → processing → ready` / `error`)
used plain `update()` calls for each transition. That's race-
vulnerable:

- A stuck-upload reaper (host-side cron scanning for old `processing`
  records) could race the original processor and double-process the
  file.
- A duplicate retry (host-side or framework-driven) could move a
  `ready` record back to `processing` and clobber its final payload.

Mongokit 3.13's `claim()` is the atomic CAS primitive for state-
machine transitions: `findOneAndUpdate({ _id, [field]: from }, { $set:
{ [field]: to, ...patch } })` in one round-trip, returns `null` on
race-loss. The upload pipeline now uses it for both the
`pending → processing` and `processing → ready` transitions:

```ts
const claimed = await deps.repository.claim(
  mediaId,
  { from: 'pending', to: 'processing' },
  {},
  context,
);
if (!claimed) {
  // Another worker beat us — back off cleanly.
  throw new Error('[media-kit] Failed to claim pending → processing ...');
}
```

Locations migrated:

- `src/repositories/media.repository.ts` — inline `_performUpload` (the
  primary upload path).
- `src/operations/upload.ts` — `performUpload` operation helper (used
  by the `upload()` domain verb).
- `src/operations/presigned.ts` — `confirmUpload` and
  `completeMultipartUpload` post-confirm processing branches (the
  `ready → processing → ready` re-processing flow).

The `processing → ready` claim merges the final payload (filename,
dimensions, thumbhash, dominant color, exif, variants) into the same
`$set` so a partial-failure can't leave a record half-updated.

#### Error-path semantics

`claim()`'s state-field match is exact (single value) — there's no
"from any non-terminal" form. The error path catches failures in
either `pending` or `processing`, so it uses
`findOneAndUpdate({ _id, status: { $in: ['pending', 'processing'] } },
...)` directly (still routed through the plugin pipeline) so we don't
clobber a record that already reached `ready` via an out-of-band
update / misbehaving retry.

### Migration

No host-facing API changes. Existing callers of `upload()`,
`confirmUpload()`, `completeMultipartUpload()`, `addTags()`,
`removeTags()`, `setFocalPoint()` see identical inputs and outputs.

**Behavioral change to be aware of:** if a host previously relied on
the upload state machine being permissive about external state writes
(e.g. manually flipping `status: 'processing' → 'ready'` on a record
mid-upload), the migration now closes that window — the second
transition's `claim()` will return `null` and the upload throws. Hosts
manipulating media status out-of-band should use `claim()` themselves
(or accept that the in-flight upload will fail loudly instead of
silently overwriting).

### Peer deps

- `@classytic/mongokit`: bumped from `>=3.12.0` → `>=3.13.0` (uses
  `Repository.claim()` + `Repository.findOneAndUpdate()` plugin-routed
  surface).
- `@classytic/repo-core`: bumped from `>=0.3.0` → `>=0.4.0` (uses
  `StandardRepo.claim()` contract addition; depends on
  `ClaimTransition` type).

### Tests

- `tests/unit/package-contents.test.ts` updated to expect the new
  peer-dep floors with rationale comments.
- All 373 tests continue passing across 27 files. The migration is
  internal to the repo; public surface unchanged.

## [3.1.0] — 2026-04-23

Migration to `@classytic/primitives` transport; drops the local
`src/events/transport.ts` in favor of the shared `EventTransport` contract
at `@classytic/primitives/events`. Zero behavior change for consumers —
re-exports of `DomainEvent`, `EventHandler`, `EventTransport` from the
media-kit root still resolve.

### Changed

- **`src/events/transport.ts` removed.** `EventTransport` now comes from
  `@classytic/primitives/events`. `src/engine/create-media.ts` imports
  the type directly from primitives; `src/index.ts` re-exports the
  primitives type under the existing export path so existing consumers
  on 3.0.x need no code change.
- **Events helpers / in-process-bus refreshed** to match the primitives
  envelope field order. No wire-format drift.
- **DevDeps:** `@classytic/primitives` moved off `file:` link onto
  `>=0.1.0` now that primitives ships on npm (package-rules compliance).
- **Tests refreshed** — 373 tests across 27 files passing (up from 355).
  Dropped the `tenant-field.test.ts` suite (validated obsolete after the
  3.0 engine-factory split); all real coverage moved into
  `validators.test.ts` + `package-contents.test.ts`.

### Peer deps

- Unchanged: `@classytic/mongokit >=3.11.0`, `@classytic/primitives >=0.1.0`,
  `mongoose >=9.4.1`, `zod >=4.0.0`. Optional peers (sharp, aws-sdk,
  gcs, mime-types) unchanged.

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
