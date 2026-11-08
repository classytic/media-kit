# Uploads, dedup, quotas, cleanup

All verbs are on `engine.repositories.media` and end with an optional context `{ userId, organizationId }`.

## Server upload

`upload({ buffer, filename, mimeType, folder, alt, title, tags, focalPoint, visibility, sourceId, sourceModel, skipProcessing, expiresAt, provider })`.
Pipeline: validate (type, size, `verifyContent` sniff) -> scan bridge -> dedup -> process -> store -> persist. Status goes `pending` -> `processing` -> `ready`
(or `error`; `deleting` while a hard delete runs). `uploadMany` throws on the first failure; `uploadManySettled` returns per-file outcomes. `replace(id, input)`
keeps the `_id` and the visibility unless overridden.

## Two-phase presigned upload (client to storage)

```ts
const target = await media.getSignedUploadUrl(filename, mimeType, { folder, expiresIn, size }, ctx);
// -> { uploadUrl, key, publicUrl, expiresIn, headers?, method? }   client sends the bytes with target.headers (verb is PUT unless `method` says otherwise)
const doc = await media.confirmUpload({
  key: target.key, filename, mimeType, size,
  hashStrategy: 'sha256',            // 'skip' (default, free) | 'etag' | 'sha256'
  process: false,                    // true runs variants, ThumbHash, dominant color
  width, height, thumbhash, dominantColor,   // optional client-computed display hints
}, ctx);
```

Server-minted keys are tenant-bound (`__t-<orgId>` segment) when tenancy is on. `confirmUpload` verifies: key shape, not already registered, size and type
against policy (and the stored object's real size and head bytes when `verifyContent` is on), tenant match. Failures are typed (`media.confirm.*`, `media.upload.not_found` 409,
`media.file.*` 413/415). A mismatching object is deleted. Batch: `generateBatchPutUrls({ files, folder })`. Client-made derivatives: `signDerivativeUploads({ primaryKey, derivatives })`
(keys come from the primary key, never from the caller).

`LocalProvider` (development): `new LocalProvider({ basePath, baseUrl, presign: { enabled: !isProduction, uploadUrl, secret, maxBytes } })`; the host mounts one PUT route
that calls `driver.acceptSignedUpload({ query, contentType, body })` (needs a raw-body parser). Off by default; production presigns natively.

## Large files

- S3: `initiateMultipartUpload({ filename, contentType, folder, partCount })` returns `type: 'multipart'`; `signUploadPart(key, uploadId, n)` or `signUploadParts`; `completeMultipartUpload({ key, uploadId, parts, filename, mimeType, size })`; `abortMultipartUpload`.
- GCS: the same call returns `type: 'resumable'` (sequential Content-Range chunks), then `confirmUpload`.
- TUS protocol server: `createTusUpload(config)` from `@classytic/media-kit/resumable` (framework-agnostic; `createMemoryTusSessionStore` for tests).

## Dedup

`deduplication: { enabled: true, returnExisting: true, algorithm: 'sha256' }`. `upload()` returns the existing record on a hash hit. Client handshake before sending bytes:

```ts
const { exists, media: hit } = await media.existsByHash(sha256Hex, ctx, { expectedSize: file.size });
```

Tenant-scoped by design (never an existence oracle across tenants); a same-hash different-size row is declined. Presigned confirms only carry a real hash with `hashStrategy: 'sha256'`.

## Storage quotas (`@classytic/media-kit/storage-budget/mongo`)

```ts
import { createMongoStorageBudget } from '@classytic/media-kit/storage-budget/mongo';
const storageBudget = createMongoStorageBudget({ connection, namespace: 'main-bucket', limitBytes: (orgId) => planBytes(orgId) });
await storageBudget.init();
const engine = await blueprint.bind(connection, { driver, storageBudget });
```

Bytes are reserved before a URL is signed (exact-length signed uploads), committed in the same transaction as the record, and released only after storage deletion succeeds.
Direct `upload()` is refused under a budget (`media.quota.direct_upload_required`). Sweep with `purgeAbandonedUploads(limit)` and `purgeDetachedMedia(before)`; `unusedCandidates` plus
`bridges.usage.inUse` protect referenced assets (`assertUnused` throws `media.in_use`).

## Cleanup sweeps (cron, idempotent, storage and DB together)

| Verb | Removes |
|---|---|
| `purgeDeleted(olderThan?)` | soft-deleted rows past `softDelete.ttlDays` (default 30) |
| `purgeExpired(before?)` | rows whose `expiresAt` passed |
| `purgeStalePending(olderThan?)` | uploads stuck in `pending` (default 24 h) |
| `hardDelete(id)`, `hardDeleteMany(ids)` | storage object and row |

The soft-delete Mongo TTL index (`softDelete.ttlIndex: true`) deletes rows without touching storage; prefer the cron. Presigned uploads never confirmed leave bucket objects with no row: set a
lifecycle rule on the upload prefix (S3 `AbortIncompleteMultipartUpload` and expiration, GCS age rule). Media-kit does not garbage-collect buckets.

## Folders, tags, search

`getFolderTree`, `getFolderStats`, `getSubfolders`, `getBreadcrumb`, `renameFolder(old, new)`, `deleteFolder`, `move(ids, folder)`, `addTags`, `removeTags`, `setFocalPoint(id, { x, y })` (0 to 1).
Lists use mongokit: `getAll({ mode: 'offset', page, limit, filters: { folder }, sort: '-createdAt' }, ctx)`.
