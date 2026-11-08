---
name: media-kit
description: Media engine for Mongoose and arc - storage providers (local, GCS, S3), two-phase presigned uploads, dedup, variants, private signed URLs, quotas, folders, events. Use for file upload, signed download, media library, storage driver, tenant media. Triggers - media-kit, defineMedia, confirmUpload, signed url, StorageDriver, GCSProvider, LocalProvider.
metadata:
  minVersion: "3.13.0"
  package: "@classytic/media-kit"
  peers: "@classytic/mongokit >=3.43.0, @classytic/repo-core >=0.31.1, mongoose >=9.11.2, node >=22"
---

# @classytic/media-kit

Describe the engine, bind it to a connection, call verbs on `engine.repositories.media` (a mongokit `Repository`, so list/get/update are mongokit's). Heavy SDKs (`sharp`, `@google-cloud/storage`, AWS) are optional peers.

## Do not hand-roll

| Need | Use |
|---|---|
| Build and bind the engine | `defineMedia`, then `blueprint.bind(connection, runtime)` |
| Dev disk storage with signed PUT | `LocalProvider` (`/providers/local`) |
| Production bucket | `GCSProvider` (`/providers/gcs`), `S3Provider` (`/providers/s3`, also R2, MinIO) |
| Route prefixes to different backends | `StorageRouter` (`/providers/router`) |
| Client uploads straight to storage | `repo.getSignedUploadUrl` then `repo.confirmUpload` |
| Files over the single-PUT size | `repo.initiateMultipartUpload`, `createTusUpload` (`/resumable`) |
| Skip re-uploading known bytes | `deduplication` config, `repo.existsByHash` |
| Private files with expiring links | `visibility`, `signing`, `repo.getSignedAssetUrl`, `repo.revokeAccess` |
| HTTP serve route with Range, variants, auth | `createAssetTransform` (`/transforms`) |
| HMAC URL signing without the engine | `createUrlSigner` (`/signing`) |
| Thumbnails, webp, ThumbHash, dominant color | `processing` config (needs `sharp`), `generateThumbHash` |
| Per-tenant byte quota | `createMongoStorageBudget` (`/storage-budget/mongo`) |
| Delete media when its owner is deleted | `withMediaCascade` |
| Refuse deleting media still referenced | `bridges.usage` |
| Virus or moderation verdict | `bridges.scan` (`ScanBridge`) |
| Feed an image to a vision model | `repo.getContextPayload` |
| Register a third-party URL as a record | `repo.registerExternal` |
| Request validation schemas | `uploadInputSchema`, `confirmUploadSchema` (`/schemas`) |
| Event names and error codes | `MEDIA_EVENTS`, `MEDIA_ERROR_CODES` |
| Cleanup sweeps | `repo.purgeDeleted`, `repo.purgeStalePending`, `repo.purgeExpired` |

## Golden path

Engine (private by default, GCS in production):

```ts
import { defineMedia } from '@classytic/media-kit';
import { GCSProvider } from '@classytic/media-kit/providers/gcs';

const engine = await defineMedia({
  tenant: { tenantField: 'organizationId', fieldType: 'string', required: true },
  fileTypes: { allowed: ['image/*', 'application/pdf'], maxSize: 25 * 1024 * 1024, verifyContent: true },
  deduplication: { enabled: true, returnExisting: true, algorithm: 'sha256' },
  softDelete: { enabled: true, ttlDays: 30 },
  visibility: { default: 'private' },
  signing: { secret: process.env.MEDIA_SIGNING_SECRET!, servePath: '/media/content', defaultTtl: 3600 },
}).bind(mongoose.connection, {
  driver: new GCSProvider({ bucket, credentials, makePublic: false }),
  eventTransport,   // optional; default is an in-process bus
});
const media = engine.repositories.media;
await engine.syncIndexes();   // deploy step
```

Two-phase upload (bytes never touch the API):

```ts
const ctx = { userId, organizationId };
const target = await media.getSignedUploadUrl('plan.pdf', 'application/pdf', { folder: 'docs', size }, ctx);
// client: PUT target.uploadUrl with target.headers and the bytes
const doc = await media.confirmUpload({ key: target.key, filename: 'plan.pdf', mimeType: 'application/pdf', size, hashStrategy: 'sha256' }, ctx);
```

Server-side upload: `await media.upload({ buffer, filename, mimeType, folder, tags }, ctx)`.

Serve and share (private):

```ts
import { createAssetTransform } from '@classytic/media-kit/transforms';
const transform = createAssetTransform({ media: engine });
const res = await transform.handle({ fileId, variant, params: {}, query, principal, range, accept });
reply.code(res.status).headers(res.headers).send(res.stream);
const link = await media.getSignedAssetUrl(id, { expiresIn: 3600 }, ctx);   // revoke: media.revokeAccess(id, ctx)
```

## Gotchas

- Tenancy is ON by default (`organizationId`, string, optional); pass `tenant: false` for none.
- Verbs take a context `{ userId, organizationId }` last; pass it on BOTH presign and confirm (keys are tenant-bound, a leaked key cannot be claimed cross-tenant).
- `GCSProvider` defaults `makePublic: true`; set `false` for private media. Signed URLs need service-account `credentials` or `keyFilename`.
- `confirmUpload` rejects hand-made keys (400) and keys already in a record (403), and derives `url` itself. `hashStrategy` defaults to `skip`: dedup by hash needs `sha256`.
- `LocalProvider` presign is off unless `presign.enabled: true`; mount its receiver (`acceptSignedUpload`) only outside production.
- `existsByHash` is tenant-scoped on purpose; pass `expectedSize`; put the endpoint behind auth.
- Private serve admits a valid signature OR `authorize(req, media)` (a throw means 403). Store the media `_id`, never a signed URL.
- `delete` is soft when soft delete is on; `hardDelete(id)` removes storage and row. The soft-delete TTL index is opt-in; run `purgeDeleted` on a cron.
- Abandoned presigned uploads leave bucket objects with no row: add a bucket lifecycle rule on the upload prefix.
- With a `storageBudget`, direct `upload()` is refused (`media.quota.direct_upload_required`); use the sized presigned flow.
- Responses are raw mongokit shapes (`getAll` returns `{ method, data, ... }`); the HTTP layer wraps, media-kit does not.
- Video is stored and range-served, never transcoded.

## Never

- Call verbs on the engine itself; they live on `engine.repositories.media`.
- Put AI, CDN or search logic inside the package: use bridges and `media:asset.*` events.
- Hardcode the tenant field type; set `tenant.fieldType`.

## References

- `references/uploads.md`: read for presign, confirm, multipart, TUS, dedup, quotas, derivatives, cleanup.
- `references/serving-private.md`: read for visibility, signing, authorize, serve pipeline, LLM payloads, external media.
- `references/engine-config.md`: read for shape and runtime options, providers, processing, events, errors, bridges, cascade.
- Mongo repository methods: skill `mongokit`. Client-side image compression: skill `media-transform`.
