# Changelog

Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
adhering to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [3.6.0] — 2026-07-09

### Added — deployment `keyPrefix` for shared-bucket multi-tenancy

Hosts running multiple companies in a single S3/GCS/R2 bucket can now
namespace ALL storage keys under a deployment-scoped prefix without changing
folder metadata:

- **`FolderConfig.keyPrefix?: string`** (`types.ts`) — deployment prefix
  prepended to every generated key (originals, variants, thumbnails). Example:
  `keyPrefix: 'acme'` → `acme/products/<ts>-<hex>-photo.jpg`. The `folder`
  metadata stays `products` — the bucket browser and content-type maps are
  unaffected.
- **`normalizeKeyPrefix(keyPrefix?)`** (`operations/helpers.ts`) — trims,
  strips leading/trailing slashes, collapses repeats; exported for testing.
- **`generateKey`** / **`generateScopedKey`** accept an optional `keyPrefix`
  parameter (fully back-compatible; omitting → empty prefix → classic key
  shape).
- All key-generation call sites updated: `upload()`, `replace()`,
  `processImage()` (originals, size variants, thumbnails), presigned
  (`getSignedUploadUrl`, batch PUT, multipart / resumable), and
  `MediaRepository._performUpload` / `importFromUrl`.

**Forward-only, non-breaking.** Keys are minted once at upload and stored on
the doc verbatim; reads and deletes use the stored key. Setting or changing
`keyPrefix` NEVER rekeys existing objects — only new uploads pick up the prefix.

### Tests

- **`tests/unit/key-prefix.test.ts`** — `normalizeKeyPrefix` edge cases +
  `generateKey`/`generateScopedKey` prefix injection and back-compat.

## [3.5.0] — 2026-07-09

The client-processed-upload release: media-kit becomes the fast server-side
half of a WhatsApp-style pipeline. Clients compress with
`@classytic/media-transform`, upload via presigned PUT, and confirm with
client-computed display hints — the server never touches sharp on that path.
Plus the `existsByHash()` dedup handshake, EXTERNAL reference-only records,
a `CloudflareImagesProvider`, and a multi-provider data-integrity fix pass.

### Fixed — multi-provider data integrity

Three silent-corruption bugs when the engine runs with `providers` +
`defaultProvider` and documents live on a non-default provider. Regression
suite: `tests/integration/multi-provider-integrity.test.ts` +
`tests/unit/key-rewrite-provider.test.ts` + `tests/unit/url-import-provider.test.ts`.

- **Ops layer hardwired the default driver (HIGH).** The repository's
  operation-deps bridge pinned `driver: registry.defaultDriver`, so
  `processImage()` wrote the `__original` and size variants to the DEFAULT
  provider while `upload({ provider })` / `replace()` wrote the main file to
  the input provider's backend — variants scattered across buckets, and the
  later variant deletes targeted the wrong one. `upload()`/`replace()` now
  bind the ops deps to the resolved driver (`_opDepsWith(driver)` /
  `withDriver()`), so main file + every variant land in — and are cleaned up
  from — the same provider. `move()`/`renameFolder()` (`executeKeyRewrite`)
  copied/deleted every file through the default driver even though files in
  one folder can span providers; the rewrite engine now resolves the driver
  PER FILE (`file.provider`, default when absent) for copies, old-key
  deletes, and both rollback phases. An unregistered provider name fails
  only that file; external records keep their DB-only branch.
  `importFromUrl()`'s documented-but-dropped `provider` option is now wired
  through to the upload (and the operations upload path stamps
  `media.provider` + routes variants like the repository path).
- **Transform serving ignored the doc's provider (HIGH).**
  `AssetTransformService` read bytes via the engine default driver, so a
  non-default-provider asset 404'd or served from the wrong backend.
  `MediaTransformSource` (and the service config) gained an optional
  `resolveDriver?: (media) => StorageDriver`; `MediaEngine` now exposes it
  (`registry.resolve(media.provider ?? defaultName)`), so
  `createAssetTransform({ media: engine })` routes raw serves, variant
  serves, range reads, and transform source reads per doc with zero host
  wiring. Hosts constructing the service manually without a resolver keep
  the old single-`driver` behavior. The transform CACHE deliberately stays
  on the driver it was constructed with (typically the engine default):
  it is engine-owned derived data, get/set always use the same driver, and
  cache keys embed the file id — documented in the guide.
- **`replace()` leaked the new object when the DB update failed (MEDIUM).**
  `replace()` wrote the new object first and updated the DB second, with no
  rollback — a failed update stranded the new main file (and its variants)
  in storage forever. It now mirrors `executeKeyRewrite`'s storage-DB
  consistency contract: on main-write or DB-update failure, every
  newly-written key is best-effort deleted through the CORRECT driver, the
  old object stays live (the doc still references it), and the error
  rethrows. The external-media guard still rejects before any write.
- Presigned flows (`getSignedUploadUrl`, batch PUT, multipart/resumable)
  intentionally remain default-provider — the presign URL and the
  confirm-time existence/stat checks must hit the same driver, so there is
  no per-call `provider` option (documented in `src/operations/presigned.ts`
  and the storage-providers guide). `confirmUpload()` /
  `completeMultipartUpload()` now stamp `provider: <defaultProvider>` on the
  created doc so per-doc routing survives a later `defaultProvider` change.

### Fixed — `processImage` orphaned partial writes on mid-pipeline failure (MEDIUM)

Sibling of the multi-provider data-integrity section above — same storage-DB
consistency contract, applied INSIDE the processing pipeline. `processImage()`
writes storage objects incrementally (the `__original` variant BEFORE
`processor.process()` runs, size variants inside the generation loop, video
thumbnails), but callers only learned the written keys from its RETURN value,
and its documented failure contract swallows ("On processing failure, returns
the original buffer unchanged"). A mid-pipeline failure therefore leaked in
two shapes: the swallow-fallback left `__original` + earlier variants behind
as an inconsistent partial variant set (or, in the presigned reprocess flows,
stranded them outright when the finalising `processing → ready` CAS threw or
lost its race — nothing referenced those keys, a permanent leak), and any
rethrow path would strand keys invisible to caller-side rollback
(`_performUpload`'s catch and `replace()`'s rollback list were fed only from
the return value). Regression suite:
`tests/unit/process-image-cleanup.test.ts` +
`tests/integration/process-image-orphans.test.ts`.

- **Cleanup is owned at the source.** `processImage` tracks every
  successfully-written key and, on ANY internal failure — rethrow or
  swallow-fallback — best-effort deletes them through `deps.driver` (the
  per-provider-bound driver from the fix above, so cleanup hits the SAME
  backend the writes did), drops them from the returned variants list, and
  resets the fallback result to the true original (buffer, mime type,
  filename; dimensions re-derived from the original). The fallback now
  honors its contract exactly: original unchanged, zero variants, zero
  orphaned keys. Cleanup failures log warnings and never mask the original
  error.
- **`ProcessImageParams.onWrite?: (key: string) => void`** — fires at write
  time for every written key, in write order. `replace()` and the upload
  pipelines (`MediaRepository._performUpload` AND the operations/upload path
  behind `importFromUrl`) feed their rollback lists from the collector, so a
  failure AFTER processImage returns but before the DB write lands rolls
  back every newly-written key (re-deleting a key processImage already
  cleaned internally is a best-effort no-op). Internal-ownership cleanup
  stays the primary mechanism; the collector covers the caller's
  post-return window.
- **Upload rollback also covers the regenerated main key.** When a format
  conversion changes the extension, the main object is written under a NEW
  key while the pending doc still references the create-time key — on a
  failed `processing → ready` CAS that object was a permanent orphan. The
  catch now deletes the written main object whenever the error-state doc
  never came to reference it (when the keys match, the doc points at a live
  object and purge/hard-delete flows own it).
- **Presigned reprocess flows no longer strand variants.**
  `confirmUpload()` / `completeMultipartUpload()` with `process: true` stay
  non-blocking on processing failure, but variant keys written by a
  reprocess whose finalising CAS threw or lost its claim race are now
  deleted instead of leaking.

### Added — client-computed display hints on `confirmUpload` / `completeMultipartUpload` / `upload`

Composition gap for client-processed uploads (`@classytic/media-transform`
compresses in the browser, PUTs via presigned URL, confirms with `process`
absent): the server never runs sharp in that flow, so the record had NO
width/height/thumbhash/dominantColor — hosts either paid for `process: true`
(re-download + sharp, defeating the point) or lost the placeholder metadata.

- `ConfirmUploadInput`, `CompleteMultipartInput` and `UploadInput` gain
  optional `width` / `height` (int, 1–65535), `thumbhash` (base64, ≤128
  chars) and `dominantColor` (`#rrggbb`) — validated by
  `confirmUploadSchema` / `completeMultipartSchema` / `uploadInputSchema`.
- Persisted on the created doc; `aspectRatio` is derived server-side
  (`width / height`, the same unrounded convention `processImage` uses) when
  both dimensions are present. New shared helper `deriveAspectRatio()` in
  `operations/helpers`.
- Trust model: DISPLAY HINTS only — accepted because the server skips
  processing in that flow; worst case a lying client wrongs its own tenant's
  placeholder rendering. Server-computed values ALWAYS win: `process: true`
  (confirm/multipart) and the `upload()` pipeline overwrite the hints
  whenever processing actually ran (`processed.X ?? input.X` precedence on
  the buffer path — hints land only when processing is
  skipped/disabled/processor absent).

### Added — `existsByHash()` pre-upload dedup handshake

WhatsApp's "forward is instant": the client hashes FIRST (SHA-256 via
`crypto.subtle.digest`), asks the server, and on a hit skips the upload
entirely. Media-kit previously deduped only AFTER receiving the bytes.

- `MediaRepository.existsByHash(hash, ctx?) → { exists, media? }` — returns
  the doc on a hit so the host can reference it directly (same
  `returnExisting` semantics as upload-time dedup, moved before the bytes
  travel).
- Tenant-scoped through the same plugin-routed read as `getByHash()` — NEVER
  cross-tenant: a global answer would be an existence oracle leaking
  "someone, somewhere uploaded this file". The same content under another
  tenant reports `exists: false` by design. Hosts must require auth on the
  proxying endpoint.
- For the handshake to ever hit, stored hashes must be real content hashes —
  confirm presigned uploads with `hashStrategy: 'sha256'` or dedup through
  server `upload()` (the default presign confirm stores a key-derived
  placeholder hash).

### Added — `registerExternal()`: EXTERNAL / reference-only media records

Register media that lives on a third party (a Cloudflare Images delivery
URL, an existing CDN asset, a partner's hosted image) as a first-class media
record — tenancy, visibility, folders, tags, listing, events — WITHOUT
media-kit owning the bytes.

- **`MediaRepository.registerExternal(input, ctx?)`** — input:
  `{ url (required); filename?; mimeType?; size?; folder?; visibility?;
  tags?; alt?; title?; metadata?; sourceProvider?; width?/height?/thumbhash?/
  dominantColor? }` (the same client display-hint bundle as `confirmUpload`).
  Creates a `status: 'ready'` record through the normal tenant-stamped create
  path; visibility follows the standard precedence (explicit > `byFolder` >
  `default`); `aspectRatio` derived from the hints; `sourceProvider`
  (freeform label, default `'external'`) stored on
  `providerMetadata.sourceProvider`. Emits the new
  `media:asset.externalRegistered` event (`AssetExternalRegisteredPayload`).
- **Record shape:** `provider: 'external'` is the canonical discriminator
  (exported: `EXTERNAL_PROVIDER`, `isExternalMedia()`); the stored `key` is
  the sentinel `__external__/<sha256-hex-16-of-url>` in the package's
  reserved `__` namespace (exported: `EXTERNAL_KEY_PREFIX`,
  `buildExternalKey()`) — a namespace marker, never a storage location, and
  shaped so `assertGeneratedKeyShape` can never accept it (presign
  `confirmUpload` cannot claim external keys). `hash` = full SHA-256 of the
  URL string, so `existsByHash(sha256(url))` answers "is this URL already
  registered?" per tenant. Registering the same URL twice creates two records
  by design (both DB-only deletes — harmless).
- **Validation, no fetching:** the URL must be absolute http(s) — `javascript:`
  / `data:` / relative → 400 `media.external.invalid_url`. The URL is NEVER
  fetched at register time (reference registry, not an importer —
  `importFromUrl()` keeps the SSRF machinery for re-hosting). Optional engine
  config `external: { allowedOrigins?: string[] }` rejects other origins with
  403 `media.external.origin_not_allowed` (entries origin-normalized;
  malformed entries fail closed). Zod: `registerExternalSchema` (validators +
  `/schemas` subpath), `externalConfigSchema` wired into `mediaConfigSchema`.
- **Every storage-op call site is external-aware:**
  - `hardDelete()` (and therefore `purgeDeleted` / `purgeExpired` /
    `purgeStalePending` / `deleteFolder` sweeps) is **DB-only** for external
    records — no driver resolution, no `driver.delete`.
  - `AssetTransformService.handle()`: raw serve of an external record →
    **302 redirect** to the stored URL (the private-media auth gate still
    runs FIRST, so private external records require a valid signature or
    `authorize()` approval before the URL is disclosed); transform/variant
    requests → 400 `media.serve.external_no_bytes` with the URL in the error
    body — hosts should use `media.url` directly for external records.
  - `getContextPayload()` → 400 `media.context.external` (fetch `media.url`
    yourself — media-kit deliberately won't fetch arbitrary stored URLs
    server-side, that would be an SSRF surface; routing through url-import's
    pinned fetch is a possible future opt-in).
  - `replace()` / `applyTransforms()` → 400 `media.external.no_bytes`.
  - `move()` / `renameFolder()` (key-rewrite path) treat external records as
    **DB-only folder updates** — the sentinel key is never rewritten into
    storage copy/delete ops (`RewritableFile` gained an optional `provider`
    field; `executeKeyRewrite` short-circuits).
  - `getAssetUrl()` / `getSignedAssetUrl()` work unchanged (they never read
    bytes; a signed serve URL for a private external record resolves to the
    gated 302).
- Docs: "Registering externally-hosted media" in
  `docs/guides/upload-profiles.mdx`; README verb table; skill section.
- Tests: `tests/unit/external-media.test.ts` (URL/origin validation, sentinel
  shape, confirm-guard rejection, zod bounds) +
  `tests/integration/external-media.test.ts` (record shape, tenancy,
  visibility precedence, storage-op safety with driver spies, serve matrix).

### Added — `CloudflareImagesProvider` (`/providers/cloudflare-images`) + Cloudflare R2 recipe

New zero-dependency storage driver for **Cloudflare Images** (native `fetch`
+ `node:crypto`, no SDK), following the imgbb/Cloudinary API-hosted provider
pattern (`LazySecret` apiToken, delivery-URL proxy reads, feature-detected
optional ops). New subpath export `./providers/cloudflare-images`.

- **Config:** `{ accountId, apiToken, accountHash, defaultVariant? = 'public',
  signing?: { key } }`. `apiToken` accepts the lazy resolver form.
- **Public mode (default):** `write()` uploads with a Cloudflare **custom ID
  equal to the generated key** — CF custom IDs support path-like values
  (≤1024 chars, subpaths, no leading/trailing slash, not a UUID), which
  media-kit keys always satisfy, so keys are preserved verbatim (no composite
  encoding). `getSignedUploadUrl()` creates a one-time direct-creator-upload
  URL carrying the same custom ID, so the presign → `confirmUpload()` flow
  keeps the generated key and its tenant binding. ⚠ Client contract differs
  from S3/GCS: the one-time `uploadURL` takes a `multipart/form-data` POST
  with a `file` field, NOT a raw PUT. `expiresIn` clamps to CF's window
  (2 min – 6 h).
- **Private mode (`signing.key` from dashboard → Images → Keys):** uploads
  set `requireSignedURLs: true`; CF forbids custom IDs on signed images, so
  stored keys are CF UUIDs. `getSignedUrl()` /
  `getSignedVariantUrl()` mint CF's documented HMAC-SHA256 `?exp=…&sig=…`
  delivery tokens (hex over `pathname?params`). `getSignedUploadUrl()`
  **throws a clear unsupported error** in this mode — the UUID key cannot
  pass `confirmUpload()`'s generated-key-shape check; use server `upload()`.
- **Honest platform caveats (documented, not papered over):** images only
  (≤10 MB, ≤100 MP); `stat()` size/contentType describe the served
  `defaultVariant` (details API has no byte size — a delivery HEAD fills it
  in); `read()` streams the variant rendition and emulates byte-range locally
  when the CDN ignores `Range` (undocumented on `imagedelivery.net`);
  `list`/`copy`/`move`/multipart stay `undefined`.
- **Extensions:** `getVariantUrl(key, variant)` (named or flexible-variant
  strings like `w=400,sharpen=3`) and `getSignedVariantUrl()`.
- **Cloudflare R2 needs no new provider** — documented recipe (README table +
  `docs/api/providers.mdx`): `S3Provider` with
  `endpoint: https://<ACCOUNT_ID>.r2.cloudflarestorage.com` (jurisdiction
  buckets via `<ACCOUNT_ID>.<jurisdiction>.r2.cloudflarestorage.com`),
  `region: 'auto'`, `forcePathStyle: true`, no `acl` (R2 has none). Presigned
  PUT/GET confirmed (1 s – 7 days, S3 domain only, not custom domains);
  S3 multipart confirmed; public delivery via custom domain or rate-limited
  `r2.dev` dev URL + `publicUrl`.
- Unit tests: `tests/unit/cloudflare-images-provider.test.ts` — mocked global
  fetch, exact-token assertion for the signed-URL scheme, error-envelope
  mapping, expiry clamping, unsupported-op errors.

### Docs

- New guide: `docs/guides/upload-profiles.mdx` — three named config bundles
  (**chat**: client-processed via `@classytic/media-transform` + presigned
  PUT + confirm with client hints + `existsByHash` handshake, originals
  discarded; **cms**: server sharp pipeline, `__original` kept, on-read
  transforms; **document**: the general byte-exact data-bucket posture,
  validation only) and the explicit **video policy** (media-kit stores +
  byte-range serves video, never transcodes; `videoAdapter` is
  thumbnails/metadata only — renditions belong to native clients or an
  external service). Positions media-kit as a provider-agnostic blob/data
  bucket with image processing as optional enrichment. Linked from README,
  `docs/README.mdx`, and the skill.
- New guide: `docs/guides/react-media-integration.mdx` — host-route recipe for
  `@classytic/react-media` clients: the 4 multipart endpoint handlers
  (initiate / sign-more-parts / complete / status) with arc-style Fastify
  implementations and the exact field mapping (`uploadUrl` → `url`,
  `expiresIn` seconds → `expiresAt` ISO), the single-PUT small-file
  alternative, the live-HLS recipe (`createHlsSegmentProvider` ↔
  `generateBatchPutUrls` for segments + driver-level signing for the
  stable-key `init.mp4`/`manifest.json` + one `registerExternal` for the
  finished asset), the three integration rules (tenant continuity
  initiate↔complete, forwarding media-transform display hints through
  `/complete`, presign-orphan / segment bucket lifecycle rule), and the
  layered abandoned-session defense (`pagehide` `sendBeacon` → beacon-friendly
  abort route → `purgeStalePending()` + lifecycle rules as the guarantee;
  segment PUTs as the live-HLS heartbeat). Linked from README,
  `docs/README.mdx`, and the skill.

## [3.4.0] — 2026-07-06

The next release after 3.3.1. Two bodies of work land together: **private
media serving** (visibility + HMAC-signed proxy URLs + LLM-context helpers)
and a **security/hardening audit pass**. Most of it is additive
(`visibility` defaults to `'public'`, which serves exactly as before), but a
few changes are breaking — read the section immediately below first.

### ⚠️ BREAKING CHANGES (low-impact, internal package)

1. **Default exports removed.** All `export default` statements are gone
   (`createMedia` and its root `default` re-export, every provider,
   `ImageProcessor`, `computeFileHash`, `generateAltText`). Named exports are
   unchanged — switch `import createMedia from '@classytic/media-kit'` to
   `import { createMedia } from '@classytic/media-kit'`. (No default-import
   usages existed in the repo's own tests/docs.)
2. **Presign key format changed** (tenant binding). Keys minted under a tenant
   context now embed a `__t-<orgId>` segment, and `confirmUpload()` /
   `completeMultipartUpload()` enforce a tenant-match matrix. A presigned key
   minted *before* this release confirms only via a tenantless caller — affects
   only uploads in-flight across the upgrade window. See the tenant-key section.
3. **`confirmUpload()` rejects client-supplied `key`/`url` it used to accept.**
   This is the cross-tenant security fix below — it only "breaks" callers that
   were relying on registering arbitrary keys (i.e. exploiting the hole).

Behavior changes that are NOT breaking but worth noting on upgrade: the
soft-delete Mongo TTL index now defaults **off** (existing collections keep
their old `deletedAt` TTL index until dropped — see the migration note in the
cleanup section), and cache invalidation now actually fires (it was silently a
no-op before this release).

### Added — `visibility` on the media document

- `visibility: 'public' | 'private'` (default `'public'`, indexed) and
  `tokenVersion: number` (default `0`, the signed-URL revocation counter) on
  the schema and `IMedia`. Docs created before 3.4.0 lack both fields; reads
  treat absent as public / version 0.
- Engine config `visibility: { default?, byFolder? }` — per-upload `visibility`
  overrides `byFolder` rules (longest segment-aware folder-prefix match, so a
  rule for `invoices` covers `invoices/2026`), which override `default`.
  Stamped by `upload()`, `replace()` (preserves existing unless overridden) and
  `confirmUpload()`. `uploadInputSchema` / `confirmUploadSchema` accept the
  enum.
- `StorageWriteOptions` — optional 4th parameter to `StorageDriver.write()`
  (backward-compatible; drivers may ignore it). Private uploads pass
  `{ acl: 'private' }`; `S3Provider` applies it per-object (overriding the
  provider-level `acl`). GCS has no per-object ACL under uniform bucket-level
  access — privacy there is bucket IAM (documented, not hacked around).

### Security — tenant-bound presign keys (key-format change)

Client-completed upload flows (`getSignedUploadUrl`, `generateBatchPutUrls`,
`initiateMultipartUpload` incl. the resumable fallback) now accept a context
and, when it carries a tenant, mint keys as
`<folder>/__t-<orgId>/<timestamp>-<random>-<name>.<ext>` (the `__` prefix is
the package's reserved namespace, like `__transforms/`; a host folder named
`t-shirts` can never collide). Confirm-time (`confirmUpload`,
`completeMultipartUpload`) enforces an exact-match binding matrix BEFORE any
DB/storage call — 403 `media.confirm.tenant_mismatch` when: the segment
doesn't match the caller's org, a tenant-scoped caller submits a segmentless
key, or a tenantless caller submits an org-bound key. Tenantless presign →
tenantless confirm is unchanged (segmentless keys, single-tenant hosts
unaffected). This closes the residual 3.4.0 hole where a leaked UNCONFIRMED
key could be claimed by whoever held it — knowing a key is no longer enough.
`completeMultipartUpload` additionally gained the same shape +
key-in-use guards as `confirmUpload` and now stamps `visibility` /
`tokenVersion` (it previously skipped both). The tenant segment is stripped
before the doc's `folder` field is derived, so `visibility.byFolder` rules
and folder listings are unaffected. **Presign key format change** — approved
while the package is internal; keys minted before this release confirm only
via tenantless callers.

### Added — `/signing` subpath: zero-dep HMAC URL signing

- `createUrlSigner({ keys | secret, currentKid?, defaultTtl? })` — pure
  `node:crypto`, no imports from the rest of the package (usable standalone in
  edge workers). `sign()` returns `{ query, expiresAt }` with
  `e=<exp>&kid=<kid>&v=<tokenVersion>[&c.<claim>=...]&sig=<base64url HMAC-SHA256>`;
  the signature covers EVERY externally supplied parameter (id, variant,
  expiry, kid, tokenVersion, sorted claims — components URI-encoded in the
  canonical string so delimiters can't collide). `verify()` returns
  `{ ok: true } | { ok: false, reason: 'expired' | 'bad_signature' |
  'unknown_kid' | 'version_mismatch' | 'malformed' }`, uses
  `crypto.timingSafeEqual` (length mismatch → `bad_signature`, never a throw),
  and resolves keys by `kid` — keep N-1 old keys in the ring for rotation.
- Why package HMAC: storage-native presigning caps at 7 days (S3 SigV4 / GCS
  V4) and only exists on S3/GCS. The HMAC proxy works on every driver (Local,
  Cloudinary, ImageKit, imgbb included) and supports arbitrary TTLs — required
  for URLs handed to LLM providers, which re-fetch them anonymously on every
  chat-history replay.

### Added — auth gate in `AssetTransformService`

- `TransformRequest` gains `variant?`, `query?` (decoded request query — carries
  the signature fields) and `principal?` (opaque host session object). The
  service can now serve a specific variant's bytes (`/media/content/:id/:variant`);
  signatures are bound to the variant.
- Service config (and `MediaTransformSource`) gains `signing?` + `authorize?` —
  both default to the engine's, so `createAssetTransform({ media: engine })` is
  fully wired. The gate runs BEFORE any storage read:
  public → unchanged; valid signature (checked against the doc's current
  `tokenVersion`) → serve; else `authorize(request, media)` → serve on `true`;
  else `403` with JSON body `{ error: { code } }` — `media.serve.link_expired`
  for authentic-but-expired signatures, `media.serve.forbidden` otherwise.
  Denials are RETURNED as `TransformResponse` (status 403), not thrown, so
  hosts that pipe `handle()` results verbatim get correct semantics for free.
- Fail-closed: a THROWING `authorize` denies with 403 (never 500) — an erroring
  authorizer must not leak bytes nor become a probing oracle.
- Private cache policy: signed hits get
  `Cache-Control: private, max-age=min(remaining signature TTL, 3600)` (the URL
  is the credential — holder-side caching within its own validity leaks
  nothing; the 1h cap bounds revocation staleness). Session (`authorize`) hits
  get `private, no-store` (ambient-credential responses must not be cached).
  Private responses never carry `public` / `immutable`.

### Added — repository verbs

- `getSignedAssetUrl(idOrDoc, { variant?, expiresIn?, claims? }, ctx?)` — mints
  `${signing.servePath}/${id}[/variant]?<signed query>`. Requires engine
  `signing` config (`{ keys | secret, servePath, ... }`); throws typed
  `HttpError` `media.signing.not_configured` otherwise. When a `CdnBridge` is
  configured the minted URL routes through
  `bridges.cdn.transform(key, url, { signed: true, ... })` — bridge wins
  (CloudFront offload).
- `revokeAccess(idOrDoc, ctx?)` — `$inc tokenVersion` through the normal
  plugin-routed update (tenant scoping + cache invalidation fire), instantly
  invalidating all outstanding signed URLs.
- `getContextPayload(idOrDoc, { as?, maxDimension?, maxBytes? }, ctx?)` — the
  LLM-context path: streams with a hard cap (default 25MB → typed 413
  `media.context.too_large`), downscales images whose long edge exceeds
  `maxDimension` (default 1568px — Anthropic's token sweet spot; hard limits
  10MB / 8000px) when sharp is available, returns
  `{ data: base64 | dataUrl | Buffer, contentType, bytes }`. Byte-stable output
  is prompt-cache-friendly; Bedrock/Vertex are base64-only. Works regardless of
  visibility.
- Engine: `createMedia({ signing, visibility, authorize })` constructs ONE
  `UrlSigner` shared by repo + transform service and exposes
  `engine.signing` / `engine.authorize`.

### Added — `purgeStalePending()` (crashed-upload sweep)

- `purgeStalePending(olderThan?, ctx?)` on `MediaRepository` — hard-deletes
  (storage + DB) `status: 'pending'` rows older than the cutoff (default 24h,
  exported as `STALE_PENDING_MAX_AGE_MS`). `upload()` creates the row as
  `'pending'` before the storage write and flips it to `'ready'` at the end;
  a crash in between stranded the row forever — there was no sweep. Cron-safe,
  idempotent, tenant-scoped like `purgeDeleted()`; a missing storage object
  (crash before the write) is tolerated and the DB row is still removed.
  Emits `media:asset.purged` with the new optional payload field
  `reason: 'stale_pending'` (`AssetPurgedPayload.reason` — absent on
  `purgeDeleted()` events, so existing subscribers are unaffected).
- Documented the presign-orphan gap alongside it: abandoned PRESIGNED uploads
  leave unconfirmed bucket objects with NO DB row (`confirmUpload()` creates
  the row), invisible to any DB-driven sweep. The remedy is a
  storage-lifecycle rule on the upload prefix (S3
  `AbortIncompleteMultipartUpload` + expiration rule scoped to the presign
  folder; GCS lifecycle age rule) — media-kit deliberately does not implement
  bucket GC.

### Changed — soft-delete Mongo TTL index is now opt-in (`softDelete.ttlIndex`)

- New `SoftDeleteConfig.ttlIndex?: boolean` (default **false**). The schema
  now creates the `deletedAt` TTL index ONLY when `ttlIndex: true` (the
  `ttlDays > 0` requirement stays), and `ttlDays` is only forwarded to
  mongokit's `softDeletePlugin` (which creates the same index at the
  COLLECTION level) under the same gate. `ttlDays` keeps its existing role as
  `purgeDeleted()`'s default cutoff.
- Migration: hosts that relied on the implicit TTL index must either set
  `softDelete: { ..., ttlIndex: true }` (and accept/lifecycle-cover the
  orphaned blobs) or — recommended — schedule a `purgeDeleted()` cron. Note
  Mongoose does not drop existing indexes: databases that already have the
  TTL index keep it until `syncIndexes()`/manual drop.

### Fixed — soft-delete TTL index orphaned storage blobs

- The previously unconditional TTL index (created whenever
  `softDelete.enabled && ttlDays > 0`, via BOTH the schema declaration and
  mongokit `softDeletePlugin`'s collection-level `createIndex`) let Mongo's
  TTL sweeper delete the
  DOCUMENT with no hooks — the storage object (S3/GCS/local file) and its
  variants were orphaned forever, and the sweeper raced the proper
  `purgeDeleted()` path (same `ttlDays` window, but storage + DB together).
  Defaulting the index OFF makes `purgeDeleted()` the single cleanup path.
- Latent since multi-tenancy: `injectTenantField()` prepended the tenant key
  to the schema-declared TTL index, producing a compound TTL index MongoDB
  rejects ("TTL indexes are single-field indexes") — the schema-level index
  silently failed to build under tenant scoping (background index errors are
  swallowed) and only the plugin's collection-level index ever existed.
  `injectTenantField()` now skips TTL indexes, so `ttlIndex: true` builds a
  valid single-field `deletedAt` TTL index under tenant scoping too.
- Also latent: the unnamed TTL index auto-named itself `deletedAt_1`,
  colliding with the path-level `deletedAt: { index: true }` index of the
  same name (IndexOptionsConflict, again swallowed in background builds).
  The TTL index is now explicitly named `media_deletedAt_ttl` so both
  coexist — i.e. `ttlIndex: true` is the first configuration under which the
  schema-level TTL index actually builds.

### Docs

- New "Cleanup & data hygiene" section (README + `docs/api/media-kit.mdx`)
  listing the three sweeps — `purgeDeleted()`, `purgeExpired()`,
  `purgeStalePending()` — with cron recommendations, the presign-orphan
  lifecycle-rule guidance, and the `ttlIndex` default change.
- New guide: `docs/guides/private-media.mdx` — private bucket + proxy pattern,
  dual auth (session for own-UI list views, signed URLs for
  embeds/LLMs/share links), key rotation, revocation, the three chat-history
  strategies + prompt-caching caveat, arc integration recipe, and the
  `@classytic/access` composition recipe (bridge via `authorize`, never an
  import — which is also why the field is `visibility` and the subpath is
  `/signing`, avoiding concept collision with that package).

## Audit hardening

### Security — `confirmUpload` no longer trusts the client-supplied `key` / `url` (HIGH)

Pre-3.4.0, `confirmUpload()` accepted any `key` string and stored any `url`
verbatim. A caller could register (and later `hardDelete()`, destroying the
storage object) arbitrary keys — including another tenant's files. Now:

- **Key shape validation** — the submitted key must have exactly the shape
  `getSignedUploadUrl()`'s server-side `generateKey()` produces
  (`<folder>/<ms-timestamp>-<12 hex>-<sanitized name>.<ext>` under a
  normalized folder). Traversal segments, backslashes, URLs, and hand-crafted
  basenames are rejected with a 400 `HttpError`
  (`code: 'media.confirm.invalid_key'`). Exposed as
  `assertGeneratedKeyShape()` from `operations/helpers`.
- **Ownership guard** — a key already registered to ANY media record (any
  tenant, including soft-deleted rows) cannot be confirmed again: 403
  `HttpError` (`code: 'media.confirm.key_in_use'`), via the new internal
  `MediaRepository.isKeyRegistered()` (deliberately unscoped probe).
  Confirming an *unconfirmed* foreign key would additionally require guessing
  the 48-bit random + exact ms timestamp embedded in every generated key.
- **URL derived server-side** — the stored `url` is now ALWAYS
  `driver.getPublicUrl(key)`. A client-supplied `url` is only validated
  (absolute http(s), origin must match the storage origin; `javascript:` /
  `data:` / malformed input → 400 `HttpError`
  (`code: 'media.confirm.invalid_url'`)) and then discarded.
  `confirmUploadSchema.url` tightened to `z.url()`.

### Removed — default exports (potentially breaking)

All `export default` statements were removed: `S3Provider`, `GCSProvider`,
`LocalProvider`, `CloudinaryProvider`, `ImageKitProvider`, `ImgbbProvider`,
`StorageRouter`, `createMedia` (and its `default` re-export from the package
root), `ImageProcessor`, `computeFileHash`, `generateAltText`.
**Removed — potentially breaking for consumers using default imports (named
exports unchanged)**: switch `import X from '@classytic/media-kit/...'` to
`import { X } from '@classytic/media-kit/...'`.

### Fixed — S3/GCS retry no longer re-sends a consumed stream body (MEDIUM)

`S3Provider.write()` retried by re-sending one `PutObjectCommand` instance;
after a transient failure a stream `Body` was already (partially) consumed and
the retry uploaded truncated/empty data. Buffer bodies are now retried with
the command rebuilt fresh per attempt; stream bodies get exactly one attempt.
`GCSProvider.write()` had the same defect on its stream path
(`pipeline(data, writable)` inside `withRetry`) and is fixed the same way —
Buffer saves stay retried, stream pipelines are single-shot.

### Fixed — unescaped filename in `Content-Disposition` (MEDIUM)

`AssetTransformService` interpolated raw filenames into
`Content-Disposition: attachment; filename="..."` — quotes/CR-LF enabled
header injection and non-ASCII names were emitted verbatim. New
`contentDispositionAttachment()` helper (`src/utils/content-disposition.ts`)
implements RFC 6266/5987: control chars stripped, quotes/backslashes
neutralized in the ASCII fallback, and non-ASCII names carried in
`filename*=UTF-8''<percent-encoded>`.

### Fixed — upload policy now enforced at presign time (MEDIUM)

`getSignedUploadUrl()` and `generateBatchPutUrls()` previously signed URLs for
any content type/size, bypassing `fileTypes.allowed` / `maxSize` until (maybe)
confirm time. Both now reject disallowed content types before signing, and
accept an optional declared `size` (new `options.size` /
`BatchPresignInput.files[].size`) checked against `maxSize`. The declared size
is still re-verified from storage at confirm time.

### Changed — retry classification prefers structured signals (LOW)

`isRetryableError()` now checks, in order: Node syscall codes (`ETIMEDOUT`,
`ECONNRESET`, `EPIPE`, ...), AWS SDK `$retryable` / `$metadata.httpStatusCode`,
numeric `status` / `statusCode` / `code` in {408, 429, 500, 502, 503, 504} —
a present status is authoritative (404/403 never retry) — and only then
word-boundary message checks. Bare substrings like `'500'` no longer match, so
an error naming `IMG_500.jpg` is not retried.

### Changed — `importFromUrl` download bounded by the upload semaphore (LOW)

The remote fetch/buffering now runs inside `concurrency.maxConcurrent`'s
semaphore, so N concurrent imports can no longer hold N unbounded download
buffers. The slot is released before `upload()` re-acquires its own (no
self-deadlock at `maxConcurrent: 1`). Behavior otherwise identical.

### Fixed — `LocalProvider` removes partial files on failed stream writes (LOW)

A failing source stream previously left a truncated file on disk; the partial
file is now unlinked (best-effort) before the error rethrows.

### Added — Biome lint/format gate

`@biomejs/biome` devDep + `biome.json` (aligned with the org config used by
mongokit; `noExplicitAny: error` in `src/`). New scripts: `lint`, `lint:fix`,
`check` (`biome ci src/ --diagnostic-level=error`). `prepublishOnly` gate is
now `check → build → typecheck → test → test:smoke`.

### Changed — zero `any` in `src/`

All ~60 `any` usages replaced with proper types: typed optional-peer SDK
clients (`S3Client`, GCS `Storage`/`Bucket` via type-only imports — erased at
runtime, peers stay optional), `SharpModule` type for the shared sharp
instance, `ImageAdapter.extractMetadata` now returns
`Record<string, unknown>`, and `MediaRepository`'s option bags / contexts are
properly typed. The cache plugin wiring was also corrected for
mongokit ≥ 3.18 / repo-core ≥ 0.7: `MediaCacheConfig`'s `del`/string adapter
is bridged to repo-core's `delete`/envelope `CacheAdapter`, and
`byIdTtl`/`prefix` now map to `defaults.staleTime`/`prefix` (the previous
`ttl`/`keyPrefix` keys were silently ignored).

### Removed — dead code / stale docs

- Dead private `extractKey()` in `LocalProvider`.
- Hardcoded version in the `src/index.ts` docblock (drifted at `v3.0.0`).
- Broken `testing-infrastructure` link in README (§Testing).

### Dev dependencies

- `@classytic/mongokit` `^3.16.0` → `^3.18.0`, `@classytic/repo-core`
  `^0.6.0` → `^0.7.0` (peer floors unchanged).

## [3.3.1] — 2026-06-14

### Fixed — `importFromUrl` crashed with "Invalid IP address: undefined" on Node ≥18

The DNS-rebinding guard pins the validated IP by passing a custom `lookup` to
`http(s).get`. That shim only implemented the legacy `(err, address, family)`
callback, but Node invokes a custom lookup with `{ all: true }` (the default
since the autoSelectFamily change in Node 18+) and then expects an array
`[{ address, family }]`. Given the legacy triple, Node read `.address` off an
undefined array element and threw `URL import failed: Invalid IP address:
undefined` — breaking **every** `importFromUrl` call on Node ≥18 (and the
package requires Node ≥22). The shim now branches on `options.all` and returns
the correct shape for each. Extracted as `createPinnedLookup` with regression
tests covering both callback forms and IPv6.

## [3.3.0] — 2026-05-24

> Consolidates work previously drafted under 3.3.0 (imgbb / ImageKit
> providers) and 3.4.0 (multi-provider routing, providerMetadata,
> Cloudinary) — neither shipped to npm. Below: the new utilities +
> provider hardening that triggered this release. See the unified
> "Drafted 3.3 / 3.4 content" sections further down for the full set.

### Added — `lazy-secret` utility (`src/utils/lazy-secret.ts`)

Resolves provider credentials on first use instead of at construction
time. Lets hosts build the engine + provider chain at startup without
the secrets being available yet (CI, deferred config load, on-demand
KMS unwrap). Throws a clear "secret X not resolved" error if a real
call needs the value before it's wired.

### Added — `cascade` utility (`src/utils/cascade.ts`)

Helper that walks a provider chain on read/delete failures so a hosted
URL that 404s from one backend can transparently fall through to the
next. Useful when migrating between providers without breaking
existing URLs.

### Changed — Provider hardening (Cloudinary / ImageKit / imgbb)

- All three providers now accept lazy-secret values for their
  credential fields. Sync constructors stay sync; resolution happens
  inside the first network call.
- Cleaner error surfaces — credential-resolution failures throw
  `MediaKitError('CREDENTIAL_NOT_RESOLVED', …)` instead of an opaque
  HTTP failure deep inside the SDK call.
- Test coverage added: `tests/unit/lazy-secret.test.ts`,
  `tests/unit/provider-lazy-secrets.test.ts`,
  `tests/integration/cascade.test.ts`.

### Changed — peer dep floors

- `@classytic/mongokit` `>=3.13.0` → `>=3.14.0` (compliance-grade
  `purgeByField`).
- `@classytic/primitives` `>=0.4.0` → `>=0.6.0` (new `phone` /
  `status-history` / `condition` / `mixin` / `sla-policy` primitives).
- `@classytic/repo-core` `>=0.4.0` → `>=0.5.0` (`PurgePort` + chunked
  purge orchestrator).

Floor-only — no API breaks.

### Drafted 3.4 content — Multi-provider routing, providerMetadata, expiresAt, Cloudinary

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

### Drafted 3.3 content — imgbb and ImageKit storage providers

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
