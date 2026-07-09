---
name: media-kit
description: |
  @classytic/media-kit — Production-grade media management for Mongoose with pluggable storage
  (S3, GCS, local, Cloudinary, ImageKit, imgbb), image processing, and PRIVATE media serving
  (HMAC-signed proxy URLs + LLM-context helpers).
  Use when building file uploads, image processing, presigned/multipart uploads, media CRUD,
  asset transforms, private/authenticated media (auth-gated buckets like Drive/Dropbox/ChatGPT),
  signed download URLs, or feeding stored images to a vision LLM (Claude/OpenAI).
  Triggers: media upload, file storage, s3 upload, gcs upload, presigned url, multipart upload,
  image processing, sharp, media management, asset transform, media-kit, storage driver,
  private media, signed url, authenticated media, serve private image, revoke access,
  media for llm, base64 for vision, getContextPayload, visibility public private,
  external media, registerExternal, register cdn url, cloudflare images reference.
version: 3.5.0
license: MIT
metadata:
  author: Classytic
tags:
  - media
  - upload
  - s3
  - gcs
  - storage
  - mongoose
  - image-processing
  - presigned-upload
  - multipart-upload
  - sharp
  - asset-transform
  - private-media
  - signed-url
  - hmac
  - llm-vision
  - file-management
progressive_disclosure:
  entry_point:
    summary: "Media management for Mongoose: S3/GCS/local storage, image processing, presigned/multipart uploads, PRIVATE serving via HMAC-signed proxy URLs, LLM-context helpers, soft delete, multi-tenancy"
    when_to_use: "Building file uploads, cloud storage integration, image processing, presigned/multipart uploads, private/authenticated media serving, signed download URLs, feeding stored images to a vision LLM, or media CRUD with MongoDB"
    quick_start: "1. npm install @classytic/media-kit 2. createMedia({ driver: new S3Provider({...}) }) 3. media.upload / getSignedUploadUrl+confirmUpload / getSignedAssetUrl (private)"
  context_limit: 800
---

# @classytic/media-kit

Production-grade media management for Mongoose: pluggable storage drivers, image processing,
presigned/multipart uploads, **private media serving** (HMAC-signed proxy URLs), and
**LLM-context helpers**. Full TypeScript, ESM-only. Built on `@classytic/mongokit`. **624 tests.**

**Requires:** Node.js `>=22` · Mongoose `>=9.4.1` · `@classytic/mongokit` `>=3.14`. Named
exports only (no default exports). Heavy SDKs are optional peers — install only what you use.

## Installation

```bash
npm install @classytic/media-kit @classytic/mongokit mongoose
# Optional peers, per feature:
npm install sharp                                             # image processing
npm install @aws-sdk/client-s3 @aws-sdk/s3-request-presigner  # S3
npm install @google-cloud/storage                            # GCS
```

## Core pattern

```typescript
import { createMedia } from '@classytic/media-kit';        // named import — no default export
import { S3Provider } from '@classytic/media-kit/providers/s3';
import mongoose from 'mongoose';

const media = createMedia({
  driver: new S3Provider({ bucket: 'my-bucket', region: 'us-east-1', credentials: { accessKeyId, secretAccessKey } }),
  processing: { enabled: true, format: 'webp', quality: 80, sizes: [{ name: 'thumb', width: 150, height: 150 }, { name: 'large', width: 1920 }] },
  fileTypes: { allowed: ['image/*', 'video/*'], maxSize: 100 * 1024 * 1024 },
  softDelete: { enabled: true, ttlDays: 30 },
  multiTenancy: { enabled: true, field: 'organizationId' },
});

const Media = mongoose.model('Media', media.schema);
media.init(Media);                                          // required before any operation
```

## Storage drivers

| Driver | Import subpath | Use case |
|--------|----------------|----------|
| `S3Provider` | `providers/s3` | AWS S3, MinIO, R2, DigitalOcean Spaces |
| `GCSProvider` | `providers/gcs` | Google Cloud Storage |
| `LocalProvider` | `providers/local` | Local filesystem (dev) |
| `CloudinaryProvider` | `providers/cloudinary` | Cloudinary CDN |
| `CloudflareImagesProvider` | `providers/cloudflare-images` | Cloudflare Images (managed pipeline + variants; images only, ≤10 MB) |
| `ImageKitProvider` | `providers/imagekit` | ImageKit CDN |
| `ImgbbProvider` | `providers/imgbb` | imgbb (public hosting) |
| `StorageRouter` | `providers/router` | Multi-backend routing by key prefix (e.g. public→S3, private→locked S3) |

```typescript
new S3Provider({ bucket, region, credentials?, endpoint?, publicUrl?, acl?: 'private' | 'public-read', forcePathStyle? })
new GCSProvider({ bucket, projectId?, keyFilename?, credentials?, makePublic?, publicUrl? })
new CloudflareImagesProvider({ accountId, apiToken, accountHash, defaultVariant?: 'public', signing?: { key } })
```

**Cloudflare R2 = S3Provider** (no dedicated driver): `endpoint: 'https://<ACCOUNT_ID>.r2.cloudflarestorage.com'`
(jurisdiction buckets: `<ACCOUNT_ID>.eu.r2.cloudflarestorage.com`), `region: 'auto'`, `forcePathStyle: true`,
NO `acl` (R2 has none — use a public bucket/custom domain + `publicUrl` for public delivery). Presigned
PUT/GET work (max 7 days, S3 domain only); multipart works.

**CloudflareImagesProvider modes:** public (default) — uploads use the generated key as the CF custom ID
(path-like custom IDs supported), so presign→confirm works BUT the client must POST `multipart/form-data`
with a `file` field to the one-time `uploadURL` (NOT a raw PUT). Private (`signing: { key }`) — uploads set
`requireSignedURLs: true`, keys become CF UUIDs, `getSignedUrl()` mints HMAC `?exp&sig` tokens, and
`getSignedUploadUrl()` THROWS (CF forbids custom IDs on signed images) — use server `upload()`.
Images only; pair with `processing: { enabled: false }` and route video/docs elsewhere via `StorageRouter`.

## Upload operations

### Standard upload (buffer → storage)

```typescript
const file = await media.upload({
  buffer, filename: 'photo.jpg', mimeType: 'image/jpeg',
  folder: 'products', tags: ['featured'], alt: 'Product photo',
  focalPoint: { x: 0.3, y: 0.4 },          // smart-crop anchor
  visibility: 'private',                    // optional per-upload override (see Private media)
}, context?);
// → { _id, url, key, mimeType, size, width, height, hash, status, variants[], thumbhash, dominantColor, visibility, ... }

await media.uploadMany([...inputs], context?);
await media.replace(id, { buffer, filename, mimeType }, context?);   // same _id; preserves visibility unless overridden
```

### Presigned upload (client-direct, no server buffering)

Keys are minted server-side and are **tenant-bound** under a tenant context (a `__t-<orgId>`
segment); `confirmUpload` enforces that binding, so a leaked key can't be claimed cross-tenant.
Always pass `context` on both calls when multi-tenant.

```typescript
const { uploadUrl, key } = await media.getSignedUploadUrl('video.mp4', 'video/mp4', { folder: 'videos' }, context?);
await fetch(uploadUrl, { method: 'PUT', body: file });           // client → cloud
const doc = await media.confirmUpload({
  key, filename: 'video.mp4', mimeType: 'video/mp4', size: file.size,
  hashStrategy: 'skip',    // 'skip' (default, zero cost) | 'etag' | 'sha256'
  process: true,           // opt-in ThumbHash / variants / dominant color
}, context?);
```

`confirmUpload` is hardened: the client key must match the generated shape (traversal / URLs /
hand-crafted keys → 400), can't already belong to a record (403), and the stored `url` is always
derived server-side (a client `url` is validated then discarded).

### Upload profiles (chat / cms / document) & client-processed flow

Media-kit is a provider-agnostic blob/data-bucket layer (any bytes: video, documents, binary) —
image processing is optional enrichment, not the package identity. Pick a named config bundle
instead of assembling flags — **chat** (client compresses via `@classytic/media-transform`;
confirm accepts client-computed `width`/`height`/`thumbhash`/`dominantColor` display hints since
the server skips processing — server values overwrite them if `process: true` runs;
`existsByHash(hash, ctx?)` is the pre-upload dedup handshake / content-addressed lookup,
tenant-scoped by design so it's never a cross-tenant existence oracle — auth the endpoint),
**cms** (server sharp pipeline, `__original` kept), **document** (the general byte-exact
data-bucket posture: `skipProcessing`, bytes preserved exactly). Video policy: media-kit stores +
byte-range serves any bytes, never transcodes (`videoAdapter` = thumbnails/metadata only).
Full recipes: [docs/guides/upload-profiles.mdx](../../docs/guides/upload-profiles.mdx).

### External (reference-only) media — register a third-party URL

```typescript
// Register media hosted elsewhere (Cloudflare Images, existing CDN asset, partner URL)
// as a first-class record — tenancy/visibility/folders/tags/events — WITHOUT owning bytes.
const doc = await media.registerExternal(
  { url: 'https://imagedelivery.net/acct/id/public', mimeType: 'image/png',
    sourceProvider: 'cloudflare-images', folder: 'landing', width: 1280, height: 960 },
  { organizationId },
);
doc.provider; // 'external' (discriminator — isExternalMedia(doc)); key = '__external__/<hash16>' sentinel
```

URL is validated (absolute http(s); optional engine config `external: { allowedOrigins }` → 403)
but NEVER fetched — re-hosting is `importFromUrl()`. External-aware verbs: `hardDelete`/purges are
DB-only; `move`/`renameFolder` never rewrite the sentinel key; serve path 302-redirects raw
requests to `doc.url` (private gate still runs first) and 400s transforms
(`media.serve.external_no_bytes`); `getContextPayload` → 400 `media.context.external` (fetch
`doc.url` yourself); `replace`/`applyTransforms` → 400 `media.external.no_bytes`. Zod:
`registerExternalSchema`. Event: `media:asset.externalRegistered`.

### Multipart / resumable (large files) & batch

```typescript
const session = await media.initiateMultipartUpload({ filename, contentType, folder, partCount }, context?);
// S3 → session.type === 'multipart' (parallel parts + completeMultipartUpload)
// GCS → session.type === 'resumable' (sequential Content-Range chunks + confirmUpload)
await media.completeMultipartUpload({ key, uploadId, parts, filename, mimeType, size }, context?);
await media.signUploadPart(key, uploadId, partNumber);
await media.abortMultipartUpload(key, uploadId);

// Batch presigned PUTs (HLS segments, multi-file):
const { uploads } = await media.generateBatchPutUrls({ files: [{ filename, contentType }, ...], folder }, context?);
```

Browser client: `@classytic/react-media`'s `createMediaKitProvider` (chunked multipart) and
`createHlsSegmentProvider` (live HLS) speak to these verbs through 4-6 small host routes —
copy-paste Fastify recipe + field mapping (`uploadUrl→url`, `expiresIn`s`→expiresAt`ISO):
[docs/guides/react-media-integration.mdx](../../docs/guides/react-media-integration.mdx).

## Private media serving

The pattern behind Drive/Dropbox/ChatGPT: a **private bucket + authenticated proxy**. Media-kit
owns the reusable parts — a `visibility` flag, an HMAC URL signer, an auth gate on the streaming
serve pipeline, and an LLM-context helper. Works over **every** driver (unlike S3/GCS native
signed URLs, which cap at 7 days and don't exist on Local/Cloudinary/etc.).

### 1. Mark media private

```typescript
const media = createMedia({
  driver,
  visibility: { default: 'private', byFolder: { products: 'public' } },   // explicit upload > byFolder > default > 'public'
  signing: { secret: process.env.MEDIA_SIGNING_SECRET!, servePath: '/media/content', defaultTtl: 3600 },
});
```
`visibility` defaults to `'public'` (unchanged behavior; public uploads pay nothing for the
private machinery). Private S3 uploads get a per-object `private` ACL automatically.

### 2. Serve through the auth gate

`AssetTransformService.handle(req)` is a framework-agnostic serve pipeline (Range/206, sharp
transforms, cache headers). For private docs it admits via **either** a valid signature **or** a
host `authorize(req, media)` callback:

```typescript
// arc / Fastify: one route → the serve pipeline
fastify.get('/media/content/:id/:variant?', async (req, reply) => {
  const res = await transformService.handle({
    fileId: req.params.id, variant: req.params.variant,
    query: req.query, principal: req.scope,          // your session/JWT
    range: req.headers.range, accept: req.headers.accept,
  });
  reply.code(res.status).headers(res.headers);
  return res.stream;
});
```
- **Public docs** → served as today.
- **Private + valid signature** → served (LLM fetchers, `<img>` embeds, share links).
- **Private + session** → your `authorize(req, media)` returns true/false (throwing = 403, fail-closed). This is the bridge point for entitlement engines — call `@classytic/access`'s `check()` here; media-kit never imports it.
- The "400 thumbnails in a list" case: render `<img src="/media/content/:id/thumb">` and let session-`authorize` admit them — **no per-URL signing**, Drive-style.

### 3. Mint & revoke signed URLs

```typescript
const url = await media.getSignedAssetUrl(id, { variant?: 'thumb', expiresIn?: 86400, claims?: { u: userId } }, ctx?);
// → `${servePath}/${id}[/variant]?e=<exp>&kid=<k>&v=<tokenVersion>&sig=<hmac>`
await media.revokeAccess(id, ctx?);   // $inc tokenVersion → every outstanding signed URL dies instantly
```

Standalone signer at the `/signing` subpath (zero-dep `node:crypto`, usable in edge workers):
```typescript
import { createUrlSigner } from '@classytic/media-kit/signing';
const signer = createUrlSigner({ keys: { k2: secretNew, k1: secretOld }, currentKid: 'k2', defaultTtl: 3600 });
signer.sign({ id, variant?, expiresIn?, claims?, tokenVersion? });   // → { query, expiresAt }
signer.verify({ id, variant?, params, expectedTokenVersion?, now? }); // → { ok:true } | { ok:false, reason }
// reason: 'expired' | 'bad_signature' | 'unknown_kid' | 'version_mismatch' | 'malformed'. Keyring keeps N-1 keys for rotation.
```

### 4. Feed a vision LLM (long chat history)

```typescript
const { data, contentType, bytes } = await media.getContextPayload(id, {
  as: 'base64',        // 'base64' (default) | 'dataUrl' | 'buffer'
  maxDimension: 1568,  // downscale long edge (Anthropic token sweet spot); default 1568
  maxBytes: 25 * 1024 * 1024,
}, ctx?);
```
Streams from private storage, size-capped, sharp-downscaled, byte-stable output. **Store the media
`_id` in the transcript, resolve to base64 (or an Anthropic `file_id`) at call time — never store
signed URLs in transcripts:** LLM providers re-fetch URLs anonymously on every history replay, an
expired URL breaks the conversation, and a re-signed URL busts prompt caching. Bedrock/Vertex are
base64-only, so this helper is the portable path.

## Image processing

Requires `sharp`. Aspect ratio preserved by default — only crops when explicitly configured.

```typescript
processing: {
  enabled: true,
  format: 'webp',                  // 'webp' | 'jpeg' | 'png' | 'avif' | 'original'
  quality: 80,                     // or { jpeg: 82, webp: 82, avif: 50 }
  maxWidth: 2048,
  originalHandling: 'keep-variant', // 'keep-variant' (store __original) | 'replace' (only processed) | 'discard'
  smartSkip: true,                 // skip re-compression if already optimized
  stripMetadata: true,             // drop EXIF/GPS, keep ICC
  aspectRatios: { product: { aspectRatio: 3/4, fit: 'cover' }, default: { preserveRatio: true } },
  sizes: [{ name: 'thumb', width: 150, height: 150 }, { name: 'medium', width: 800 }],  // width+height = crop; width-only = preserve ratio
}
```
Use `originalHandling: 'replace'` when the source is too large to keep. Auto-features: ThumbHash
placeholder, dominant color, EXIF, focal-point cropping (Payload-style extract-then-resize), and
video thumbnails via an optional host `videoAdapter` (media-kit stores video as-is + serves
byte-range; it does not transcode — HLS/renditions belong in Mux/ffmpeg or `@classytic/react-media`).

## CRUD, queries, folders

```typescript
await media.getById(id, ctx?);
await media.getAll({ page, limit, sort: '-createdAt', filters: { folder: 'products' } }, ctx?);
await media.search('shoes', { limit: 10 }, ctx?);
await media.delete(id, ctx?);  await media.deleteMany([...], ctx?);
await media.softDelete(id, ctx?);  await media.restore(id, ctx?);
await media.getFolderTree(ctx?);  await media.renameFolder('old', 'new', ctx?);  await media.move([...ids], 'target', ctx?);
await media.addTags(id, ['sale'], ctx?);  await media.setFocalPoint(id, { x: 0.3, y: 0.2 }, ctx?);
```

## Cleanup & data hygiene

Three cron-safe sweeps (storage + DB together, idempotent):

```typescript
await media.purgeDeleted(olderThan?, ctx?);       // soft-deleted past softDelete.ttlDays (default 30d)
await media.purgeExpired(before?, ctx?);          // docs whose expiresAt has passed
await media.purgeStalePending(olderThan?, ctx?);  // crashed uploads stuck in status:'pending' (default 24h)
```
The soft-delete Mongo **TTL index is opt-in** (`softDelete.ttlIndex: true`, default off) — Mongo's
TTL sweeper deletes the doc with no hooks, orphaning the storage blob; use `purgeDeleted()` on a
cron instead. Abandoned **presigned** uploads leave a bucket object with NO DB row — clean those
with a storage-lifecycle rule on the upload prefix (S3 `AbortIncompleteMultipartUpload` + expiration;
GCS age rule). Media-kit deliberately does not implement bucket GC.

## Events & multi-tenancy

```typescript
media.on('before:upload', async (e) => { /* validate/modify */ });
media.on('after:upload',  async (e) => { await notify(e.result); });
// ops: upload, delete, move, replace, softDelete, restore, presignedUpload, confirmUpload, completeMultipart, rename

// Multi-tenant: all ops auto-scoped by the mongokit tenant plugin.
const media = createMedia({ driver, multiTenancy: { enabled: true, field: 'organizationId', required: true } });
await media.upload(input, { userId, organizationId });
```

## Key types & subpaths

```typescript
import type {
  MediaKitConfig, MediaKit, StorageDriver, StorageWriteOptions, IMedia, IMediaDocument, MediaStatus,
  MediaVisibility, MediaSigningConfig, VisibilityConfig, ServeAuthorize, FocalPoint,
  UploadInput, ConfirmUploadInput, PresignedUploadResult, MultipartUploadSession,
  ProcessingConfig, OriginalHandling, SizeVariant, GeneratedVariant,
} from '@classytic/media-kit';
import { createUrlSigner } from '@classytic/media-kit/signing';
import { AssetTransformService } from '@classytic/media-kit/transforms';
import { uploadInputSchema, confirmUploadSchema } from '@classytic/media-kit/schemas';
```

`StorageDriver` required methods: `write`, `read` (byte-range), `delete`, `exists`, `stat`,
`getPublicUrl`. Optional: `list`, `copy`, `move`, `getSignedUrl`, `getSignedUploadUrl`, multipart
(`createMultipartUpload`/`signUploadPart`/`completeMultipartUpload`/`abortMultipartUpload`), and
resumable (`createResumableUpload`/`abortResumableUpload`/`getResumableUploadStatus`).
