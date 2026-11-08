# Private serving, signing, LLM payloads, external media

## Visibility

`visibility: { default: 'private', byFolder: { avatars: 'public' } }`. Precedence: explicit per-upload, then `byFolder`, then `default`, then `public`.
Public documents serve as plain storage URLs; private ones go through the serve pipeline.

## Signing

Engine config: `signing: { secret | keys: { k2, k1 }, currentKid, defaultTtl, servePath }`. A keyring keeps the previous key valid for rotation.

```ts
const url = await media.getSignedAssetUrl(id, { variant: 'thumb', expiresIn: 86400, claims: { u: userId } }, ctx);
// `${servePath}/${id}[/variant]?e=<exp>&kid=<k>&v=<tokenVersion>&sig=<hmac>`
await media.revokeAccess(id, ctx);   // bumps tokenVersion: every outstanding URL for the file dies at once
```

Standalone signer (edge workers, dev receivers), zero dependencies:

```ts
import { createUrlSigner } from '@classytic/media-kit/signing';
const signer = createUrlSigner({ keys: { k2: secretNew, k1: secretOld }, currentKid: 'k2', defaultTtl: 3600 });
const { query, expiresAt } = signer.sign({ id, variant, expiresIn, claims, tokenVersion });
const verdict = signer.verify({ id, variant, params, expectedTokenVersion });  // { ok: true } | { ok: false, reason }
```

Reasons: `expired`, `bad_signature`, `unknown_kid`, `version_mismatch`, `malformed`. Missing signing config makes signed-URL verbs throw `media.signing.not_configured`.

## Serve pipeline

`createAssetTransform({ media: engine })` shares the engine's signer, `authorize` and driver resolver. `handle({ fileId, variant, params, query, principal, range, accept })` returns
`{ status, headers, stream, contentType, contentLength }` with Range/206, ETag, and variant or on-the-fly sharp transforms (`params`: `w`, `h`, `fit`, `format`, `q`, `download`).
Admission for a private file: valid signature OR `authorize(request, media)` returns true (a throw is a 403, fail-closed). Cache headers on private responses are never public or immutable.
Errors: `media.serve.forbidden` 403, `media.serve.link_expired`, `media.serve.not_found`, `media.serve.variant_not_found`.

Thumbnails in a list: render `<img src=".../thumb">` and let the session `authorize` admit them; do not sign hundreds of URLs. Entitlement checks belong inside `authorize`
(media-kit imports no access package). Add a `StorageTransformCache` (`/transforms`) to persist transformed bytes. `createImgproxyUrlBuilder` builds imgproxy URLs for a CDN-style setup.

## Vision model input

```ts
const { data, contentType, bytes } = await media.getContextPayload(id, { as: 'base64', maxDimension: 1568, maxBytes: 20 * 1024 * 1024 }, ctx);
```

`as`: `base64` (default), `dataUrl`, `buffer`. Reads from private storage, caps size (`media.context.too_large`), downscales with sharp. Store the media `_id` in transcripts and resolve at call time;
signed URLs expire and break replay and prompt caching.

## External (reference-only) media

`registerExternal({ url, mimeType, sourceProvider, folder, width, height, visibility }, ctx)` stores a record for bytes hosted elsewhere (`provider: 'external'`, key `__external__/<hash>`).
The URL is validated (absolute http or https, optional `external.allowedOrigins` else `media.external.origin_not_allowed`) and never fetched; to re-host use `importFromUrl(url, options, ctx)`
(SSRF guard: `media.import.url_blocked`). External records: deletes are DB-only, `move` keeps the sentinel key, serve redirects (302) raw requests, transforms and `replace` return
`media.external.no_bytes`, `getContextPayload` returns `media.context.external`. Check with `isExternalMedia(doc)`.

## Providers

| Provider | Notes |
|---|---|
| `GCSProvider({ bucket, projectId, credentials \| keyFilename, makePublic, publicUrl, retry })` | `makePublic` defaults to true; V4 signed URLs need service-account credentials; resumable uploads; `getSignedReadUrl` pins response type and disposition |
| `S3Provider({ bucket, region, credentials, endpoint, publicUrl, acl, forcePathStyle })` | R2: `endpoint` of the account, `region: 'auto'`, `forcePathStyle: true`, no `acl` |
| `LocalProvider({ basePath, baseUrl, presign })` | development and tests |
| `CloudflareImagesProvider`, `CloudinaryProvider`, `ImageKitProvider`, `ImgbbProvider` | managed image hosts; presign semantics differ per provider |
| `StorageRouter({ drivers, routes: [{ prefix, driver }], default })` | per-prefix backends; rows remember their provider via `resolveDriver(doc)` |

A custom backend implements `StorageDriver`: required `write`, `read` (byte range), `delete`, `exists`, `stat`, `getPublicUrl`; optional `list`, `copy`, `move`, `getSignedUrl`,
`getSignedReadUrl`, `getSignedUploadUrl`, multipart and resumable methods. Test against an in-memory driver.
