# Engine shape, runtime, events, errors, bridges

## Describe then bind

`defineMedia(shape)` is pure (no model, no I/O). `await blueprint.bind(connection, runtime)` registers the model, builds the engine, probes `sharp`. `blueprint.modelNames` is known without a connection.
`engine` exposes `repositories.media`, `models.Media`, `events`, `config`, `registry`, `driver`, `resolveDriver(doc)`, `bridges`, `signing`, `authorize`, `syncIndexes()`, `close()`.
`close()` closes only the in-process bus it created, never a transport you passed in.

### Shape (serializable, validated with zod at bind)

| Key | Content |
|---|---|
| `tenant` | `false` (off), `true`, or `{ tenantField, contextKey, required, fieldType: 'string' \| 'objectId' }`. Omitted means ON with `organizationId`, string type, not required; pass `false` to turn scoping off |
| `fileTypes` | `{ allowed: ['image/*'], maxSize, verifyContent }` |
| `folders` | `{ defaultFolder, keyPrefix, contentTypeMap, enableSubfolders, rewriteKeys }` |
| `processing` | see below |
| `deduplication` | `{ enabled, returnExisting, algorithm: 'md5' \| 'sha256' }` |
| `softDelete` | `{ enabled, ttlDays, ttlIndex }` |
| `concurrency` | `{ maxConcurrent, maxQueue, acquireTimeoutMs }` for image work |
| `visibility`, `signing`, `external` | see `serving-private.md` |
| `schemaOptions` | `{ extraFields, extraIndexes, collection, optimizedIndexes }` to extend the model |
| `autoIndex`, `forceRecreate` | index build at model compile; `forceRecreate` replaces a registered model (tests only) |

### Runtime (non-serializable)

`driver` or `providers` + `defaultProvider`, `eventTransport`, `bridges`, `cache`, `logger`, `plugins` (extra mongokit plugins), `pagination` (mongokit config), `authorize`, `storageBudget`.

## Processing (needs `sharp`)

```ts
processing: {
  enabled: true, preset: 'web-optimized',        // 'social-media' | 'web-optimized' | 'high-quality' | 'thumbnail'; explicit keys override the preset
  format: 'webp', quality: { webp: 82, jpeg: 82, avif: 50 }, maxWidth: 2048,
  originalHandling: 'keep-variant',               // keep __original | 'replace' | 'discard'
  smartSkip: true, stripMetadata: true, autoOrient: true, thumbhash: true, dominantColor: true,
  sizes: [{ name: 'thumb', width: 150, height: 150 }, { name: 'medium', width: 800 }],   // width+height crops, width alone keeps ratio
  aspectRatios: { product: { aspectRatio: 3 / 4, fit: 'cover' } },
}
```

Focal point cropping uses the stored `{ x, y }`. `imageAdapter` replaces sharp; `videoAdapter` supplies video thumbnails and metadata only (no transcoding); `rawAdapter` converts RAW stills.
Disable server processing (`enabled: false`) when the client compresses first (skill `media-transform`) and send its width, height, thumbhash and dominant color at confirm.

## Events

`engine.events.subscribe('media:asset.*', handler)` (arc-compatible glob). Constants in `MEDIA_EVENTS`: `media:asset.uploaded | replaced | deleted | softDeleted | restored | moved | imported | externalRegistered | purged | tagged | untagged | focalPointSet`,
`media:folder.renamed | deleted`, `media:upload.confirmed | multipartCompleted`, `media:batch.deleted`, `media:assets.expired`. Payload types are exported (`AssetUploadedPayload` etc.).
Search, embeddings and moderation subscribe to `media:asset.uploaded`. Pass the SAME transport arc uses; do not also publish the events from another layer.

## Errors

Client-caused failures are repo-core `HttpError`s with codes from `MEDIA_ERROR_CODES`: 415 `media.file.type_not_allowed`, 413 `media.file.too_large`, 400 `media.file.empty`, 415 `media.file.content_mismatch`,
409 `media.upload.not_found`, 400 `media.key.invalid`, `media.confirm.invalid_key | tenant_mismatch | key_in_use`, 404 `media.asset.not_found`, 422 `media.scan.rejected`, 502 `media.scan.failed`,
`media.import.*`, `media.serve.*`, `media.in_use`. Host wiring faults (a driver without presign, a missing bridge) are plain `Error`s.

## Bridges (`runtime.bridges`)

| Bridge | Contract |
|---|---|
| `source` | resolve `sourceId` + `sourceModel` to the owning document (`repo.resolveSource`, `resolveSourcesMany`) |
| `scan` | `scan(buffer, mimeType, filename, ctx)` returns `{ verdict: 'clean' \| 'reject' \| 'quarantine', reason }`; reject is 422, quarantine stores the file with status `error` |
| `cdn` | rewrite delivery URLs |
| `transform` | named ops for `repo.applyTransforms(id, { ops })` (background removal, upscale) |
| `usage` | `inUse(mediaId, urls, ctx)`; true blocks destructive verbs |

## Owner cleanup

```ts
import { withMediaCascade } from '@classytic/media-kit';
withMediaCascade(LessonSchema, { repository: engine.repositories.media, fields: ['coverMediaId', 'attachmentIds'], context: (doc) => ({ organizationId: doc.organizationId }) });
```

Runs after the owner delete (post hooks); a cascade failure logs by default and never resurrects the owner.

## Models and indexes

`defineMediaModels` and `buildMediaSchema` expose the schema for hosts composing their own model set; `injectTenantField` is the shared tenant-index injector. Call `engine.syncIndexes()` in a deploy step,
not at serve time.

## Arc integration

`engine.repositories.media` is a mongokit `Repository`; wrap it with `createMongooseAdapter` from `@classytic/mongokit/adapter` for `defineResource`. Zod request schemas come from `@classytic/media-kit/schemas`
(`uploadInputSchema`, `confirmUploadSchema`, `initiateMultipartSchema`, `startWriteSchema`). For the standard routes (start-write, complete-write, signed-url, content) use the spine media module rather than rebuilding them.
