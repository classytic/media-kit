# @classytic/media-kit

Engine-factory media management for Mongoose — framework-agnostic, Arc-compatible events, pluggable storage, and a bridge-based extension surface for hosts to compose their own ImageKit-like stack.

Built on [@classytic/mongokit](https://www.npmjs.com/package/@classytic/mongokit) ≥3.13.0 and [@classytic/repo-core](https://www.npmjs.com/package/@classytic/repo-core) ≥0.4.0. Zero runtime deps.

```bash
npm install @classytic/media-kit @classytic/mongokit mongoose zod
```

Optional peers — install what you use: `sharp`, `@aws-sdk/client-s3`, `@google-cloud/storage`, `mime-types`.

Requires Node ≥22, Mongoose ≥9.4.1, Zod ≥4.0.0.

### Storage providers

| Provider | Import | Peer dep | Notes |
|---|---|---|---|
| **S3** | `@classytic/media-kit/providers/s3` | `@aws-sdk/client-s3` | AWS S3 or any S3-compatible endpoint |
| **GCS** | `@classytic/media-kit/providers/gcs` | `@google-cloud/storage` | Google Cloud Storage |
| **Local** | `@classytic/media-kit/providers/local` | — | Filesystem (dev / self-hosted) |
| **imgbb** | `@classytic/media-kit/providers/imgbb` | — | Free public image hosting; no extra dep |
| **ImageKit** | `@classytic/media-kit/providers/imagekit` | — | Managed CDN; use with `processing: false` |
| **Router** | `@classytic/media-kit/providers/router` | — | Route uploads across multiple drivers |

---

## Quick start

```ts
import { createMedia } from '@classytic/media-kit';
import { S3Provider } from '@classytic/media-kit/providers/s3';
import mongoose from 'mongoose';

const engine = await createMedia({
  connection: mongoose.connection,
  driver: new S3Provider({ bucket: 'my-bucket', region: 'us-east-1' }),
  tenant: { enabled: true, fieldType: 'objectId', required: true },
  softDelete: { enabled: true, ttlDays: 30 },
  processing: { enabled: true, format: 'webp', quality: 80 },
});

// Repositories ARE the API surface
const media = await engine.repositories.media.upload(
  { buffer, filename: 'photo.jpg', mimeType: 'image/jpeg', folder: 'products' },
  { organizationId: 'org_123', userId: 'user_456' },
);

// Arc-compatible events
await engine.events.subscribe('media:asset.*', async (event) => {
  console.log(event.type, event.payload);
});
```

---

## Core concepts

### The engine

`createMedia(config)` returns a frozen `MediaEngine`:

```ts
interface MediaEngine {
  repositories: { media: MediaRepository };  // API surface
  events: EventTransport;                     // arc-compatible
  models: { Media: Model<IMediaDocument> };   // for Arc adapters
  config: ResolvedMediaConfig;
  driver: StorageDriver;
  bridges: MediaBridges;
  dispose(): Promise<void>;
}
```

The package **owns its models** — you pass a `connection`, not a model. One `createMedia()` call. No `.init()`, no feature flags, no tiers.

### Repositories are the API surface

`MediaRepository` extends mongokit's `Repository<IMediaDocument>`. Hosts get:

| Inherited from mongokit | Domain verbs added |
|---|---|
| `getById`, `getAll`, `getByQuery`, `count`, `exists`, `aggregate` | `upload`, `uploadMany`, `replace` |
| `create`, `update`, `delete`, `restore` (via softDelete) | `hardDelete`, `hardDeleteMany`, `purgeDeleted` |
| `getDeleted`, soft-delete TTL, keyset pagination | `move`, `importFromUrl`, `addTags`, `removeTags` |
| Transactions, plugins, hooks, QueryParser | `setFocalPoint`, folder operations, presigned URLs |
| | Bridge verbs: `resolveSource`, `getAssetUrl`, `applyTransforms` |

**No envelopes.** Raw Mongoose docs, raw mongokit pagination shapes. Arc's `BaseController` wraps responses — the package stays out of the way.

### Arc-compatible events

The event transport shape matches `@classytic/arc` exactly — any Arc transport drops in:

```ts
import { RedisEventTransport } from '@classytic/arc/events';

const engine = await createMedia({
  connection,
  driver,
  eventTransport: new RedisEventTransport({ url: process.env.REDIS_URL }),
});
```

Without an `eventTransport`, a 50-line `InProcessMediaBus` fallback is used. Both support exact / `*` / `media.*` glob patterns.

Event names follow `media:resource.verb`:

```
media:asset.uploaded / replaced / deleted / softDeleted / restored
media:asset.moved / imported / purged / tagged / untagged / focalPointSet
media:folder.renamed / deleted
media:upload.confirmed / multipartCompleted
media:batch.deleted
```

---

## Bridges — the extensibility primitives

Bridges are optional host-implemented adapters. media-kit stays thin; hosts compose.

### `SourceBridge` — polymorphic refs

Link media to entities in other packages or external systems without hardcoding ObjectId refs:

```ts
bridges: {
  source: {
    async resolve(sourceId, sourceModel, ctx) {
      if (sourceModel === 'Product') return productRepo.getById(sourceId);
      if (sourceModel === 'StripeCharge') return stripe.charges.retrieve(sourceId);
      return null;
    },
    async resolveMany(refs, ctx) { /* batch to avoid N+1 */ },
  },
}

// Upload attaches the ref
await engine.repositories.media.upload(
  { buffer, filename, mimeType, sourceId: 'prod_123', sourceModel: 'Product' },
  ctx,
);

// List-endpoint enrichment (1 batch call, no N+1)
const page = await engine.repositories.media.getAll({ page: 1, limit: 20 });
const sources = await engine.repositories.media.resolveSourcesMany(page.data);
```

### `ScanBridge` — upload-time moderation

Reject malicious / quarantine NSFW / allow clean — host wires the scanner:

```ts
bridges: {
  scan: {
    async scan(buffer, mimeType, filename) {
      const score = await rekognition.detectModerationLabels(buffer);
      if (score > 0.9) return { verdict: 'reject', reason: 'Explicit content' };
      if (score > 0.5) return { verdict: 'quarantine', reason: 'Manual review' };
      return { verdict: 'clean' };
    },
  },
}
```

- `reject` → upload throws, nothing persisted
- `quarantine` → stored with `status: 'error'` + scan metadata for manual review
- `clean` → normal flow

### `CdnBridge` — URL rewriting

imgix, CloudFront, Cloudflare Images, or custom signing:

```ts
bridges: {
  cdn: {
    transform(key, defaultUrl, ctx) {
      if (ctx?.signed) return signCloudFrontUrl(`https://cdn.example.com/${key}`, 3600);
      return `https://my-images.imgix.net/${key}?auto=format,compress`;
    },
  },
}

await engine.repositories.media.getAssetUrl(media, { signed: true });
await engine.repositories.media.getVariantUrls(media);  // all variants transformed
```

### `TransformBridge` — on-the-fly AI transforms

Pluggable URL-param ops. Build `GET /transform/:id?op=bg-remove,upscale&scale=4`:

```ts
bridges: {
  transform: {
    ops: {
      'bg-remove': async ({ buffer }) => {
        const out = await replicate.run('rembg/rembg-silueta', { input: { image: buffer } });
        return { buffer: out, mimeType: 'image/png' };
      },
      'upscale': async ({ buffer }, ctx) => {
        const scale = Number(ctx.params.scale ?? 2);
        const out = await replicate.run('nightmareai/real-esrgan', { input: { image: buffer, scale } });
        return { buffer: out, mimeType: 'image/png' };
      },
    },
  },
}

// Host route handler:
const result = await engine.repositories.media.applyTransforms(id, {
  ops: ['bg-remove', 'upscale'],
  params: { scale: '4' },
});
// Stream result.buffer with Content-Type: result.mimeType
```

---

## Multi-tenancy

Tenant configuration is a single `tenant` field on `MediaConfig` — accepts the canonical [`TenantConfig`](https://www.npmjs.com/package/@classytic/repo-core) from `@classytic/repo-core`, a boolean shorthand, or the legacy `{ tenantFieldType, multiTenant }` shape.

| `fieldType` | Schema | `$lookup` / `.populate()` | Use when |
|---|---|---|---|
| `'objectId'` | `Schema.Types.ObjectId, ref: 'Organization'` | Works | Better Auth, ObjectId orgs |
| `'string'` (default) | `String` | N/A | UUID / slug auth systems |

```ts
await createMedia({
  connection,
  driver,
  tenant: {
    enabled: true,
    fieldType: 'objectId',
    tenantField: 'organizationId',  // schema field — defaults to 'organizationId'
    contextKey: 'organizationId',    // ctx key the plugin reads — defaults to 'organizationId'
    required: true,
  },
});
```

All CRUD ops auto-scope by `ctx.organizationId` (or whatever `contextKey` you configure). Cross-tenant mutations return "not found" (fail-safe).

---

## Storage drivers

Swap backends with one line. All implement the same `StorageDriver` interface.

```ts
import { S3Provider } from '@classytic/media-kit/providers/s3';
import { GCSProvider } from '@classytic/media-kit/providers/gcs';
import { LocalProvider } from '@classytic/media-kit/providers/local';
import { StorageRouter } from '@classytic/media-kit/providers/router';

// Route by key prefix (e.g. private → S3, public → GCS CDN)
const router = new StorageRouter({
  routes: [
    { match: (key) => key.startsWith('private/'), driver: new S3Provider({ ... }) },
    { match: (key) => key.startsWith('public/'),  driver: new GCSProvider({ ... }) },
  ],
  default: new LocalProvider({ basePath: './uploads' }),
});
```

Each driver supports: `write`, `read`, `delete`, `exists`, `stat`, `copy` (optional), signed URLs, multipart (S3) or resumable (GCS) upload.

---

## Arc integration

The package drops into an Arc host as a resource. The recommended pattern is an **eager singleton** so the Mongoose model is registered before Arc's resource discovery runs:

```ts
// src/resources/media/media.engine.ts — the singleton
import mongoose from 'mongoose';
import { createMedia } from '@classytic/media-kit';
import { S3Provider } from '@classytic/media-kit/providers/s3';

let engine: Awaited<ReturnType<typeof createMedia>> | null = null;
let pending: Promise<typeof engine> | null = null;

export async function ensureMediaEngine() {
  if (engine) return engine;
  if (!pending) {
    pending = (async () => {
      engine = await createMedia({
        connection: mongoose.connection,
        driver: new S3Provider({ bucket: process.env.S3_BUCKET!, region: 'us-east-1' }),
        tenant: { enabled: true, fieldType: 'objectId', required: true },
        softDelete: { enabled: true, ttlDays: 30 },
        processing: { enabled: true, format: 'webp' },
      });
      return engine;
    })();
  }
  return pending;
}
```

```ts
// src/resources/media/media.resource.ts — the Arc resource
import { defineResource, createMongooseAdapter, BaseController } from '@classytic/arc';
import type { IRequestContext, IControllerResponse } from '@classytic/arc';
import { z } from 'zod';
import { uploadInputSchema, confirmUploadSchema } from '@classytic/media-kit/schemas';
import { ensureMediaEngine } from './media.engine.js';

const engine = await ensureMediaEngine();
const repo = engine.repositories.media;

// MediaRepository extends mongokit's Repository<T>, so it already
// satisfies Arc's RepositoryLike — pass it straight to BaseController.
class MediaController extends BaseController {
  // Route DELETE /:id through hardDelete so storage objects get cleaned up.
  async delete(req: IRequestContext): Promise<IControllerResponse<{ id: string }>> {
    const id = req.params?.id;
    if (!id) return { success: false, error: 'ID required', status: 400 };
    const ok = await repo.hardDelete(id, { userId: (req.user as { id?: string })?.id });
    return ok
      ? { success: true, data: { id } }
      : { success: false, error: 'Not found', status: 404 };
  }

  async upload(req: IRequestContext, reply: unknown) {
    const file = await (req as { file: () => Promise<{ toBuffer(): Promise<Buffer>; filename: string; mimetype: string }> }).file();
    const buffer = await file.toBuffer();
    const doc = await repo.upload(
      { buffer, filename: file.filename, mimeType: file.mimetype, folder: 'products' },
      { userId: (req.user as { id?: string })?.id },
    );
    return (reply as { code: (n: number) => { send: (b: unknown) => void } })
      .code(201).send({ success: true, data: doc });
  }
}

export default defineResource({
  name: 'media',
  prefix: '/media',
  adapter: createMongooseAdapter({ model: engine.models.Media, repository: repo }),
  controller: new MediaController(repo),
  // CRUD schemas — Arc auto-converts Zod via z.toJSONSchema().
  customSchemas: {
    update: { body: z.object({ alt: z.string().max(255).optional(), tags: z.array(z.string()).optional() }) },
  },
  routes: [
    {
      method: 'POST',
      path: '/upload',
      raw: true,
      handler: (new MediaController(repo)).upload.bind(new MediaController(repo)),
      schema: { body: uploadInputSchema }, // Zod v4 → JSON Schema automatic
    },
    {
      method: 'POST',
      path: '/presigned-upload/confirm',
      raw: true,
      handler: async (req: { body: unknown; user?: { id?: string } }) => {
        return repo.confirmUpload(req.body as never, { userId: req.user?.id });
      },
      schema: { body: confirmUploadSchema },
    },
  ],
});
```

Key wiring notes:

- **`engine.models.Media`** — the engine exposes models at the top level, not under `.engine.models`.
- **`MediaRepository` is a drop-in for `RepositoryLike`** — no adapter layer needed between Arc and mongokit.
- **Override `delete()` on your controller** to route through `repo.hardDelete()` if you want storage cleanup; the inherited handler runs soft-delete when the plugin is enabled.
- **Zod schemas from `/schemas`** — import `uploadInputSchema`, `confirmUploadSchema`, etc. so your host validates against the same shapes the package uses internally.
- **`customSchemas` vs per-route `schema`** — `customSchemas` carries the CRUD endpoints (`list`/`get`/`create`/`update`/`delete`); raw routes attach their own `schema` field.

---

## Soft delete

Via mongokit's `softDeletePlugin`:

```ts
softDelete: { enabled: true, ttlDays: 30 }
```

- `repo.delete(id)` → soft (sets `deletedAt`)
- `repo.delete(id, { mode: 'hard' })` → physical
- `repo.hardDelete(id)` → physical + storage cleanup (domain verb)
- `repo.restore(id)` → undo
- `repo.getDeleted()` → trash bin
- `repo.purgeDeleted(olderThan)` → GC soft-deleted + storage

TTL index auto-purges after `ttlDays`.

---

## Image processing

Bring your own via `ImageAdapter`, or use the built-in Sharp processor.

```ts
processing: {
  enabled: true,
  format: 'webp',
  quality: { jpeg: 82, webp: 82, avif: 50, png: 100 },
  responsivePreset: 'nextjs',       // or 'compact' | number[] | 'none'
  aspectRatios: {
    product: { aspectRatio: 3/4, fit: 'cover' },
    avatar:  { aspectRatio: 1,   fit: 'cover' },
  },
  preset: 'web-optimized',          // shortcut; user overrides still win
  stripMetadata: true,
  thumbhash: true,
  dominantColor: true,
}
```

Custom adapter example (wrap any cloud API):

```ts
processing: {
  imageAdapter: {
    async process(buffer, options) {
      const out = await cloudinary.transform(buffer, { width: options.maxWidth });
      return { buffer: out, mimeType: 'image/webp', width: ..., height: ... };
    },
    isProcessable: (_, mt) => mt.startsWith('image/'),
  },
}
```

---

## Subpath exports

```ts
import { ... } from '@classytic/media-kit';               // engine + repo + types
import { S3Provider } from '@classytic/media-kit/providers/s3';
import { GCSProvider } from '@classytic/media-kit/providers/gcs';
import { LocalProvider } from '@classytic/media-kit/providers/local';
import { StorageRouter } from '@classytic/media-kit/providers/router';
import { AssetTransformService } from '@classytic/media-kit/transforms';
import { uploadInputSchema, mediaConfigSchema } from '@classytic/media-kit/schemas';  // Zod v4 → OpenAPI
```

---

## Testing

Four tiers per [testing-infrastructure](../../sniffer/testing-infrastructure.md):

```bash
npm test              # unit + integration (CI default)
npm run test:unit     # fast feedback
npm run test:integration  # mongodb-memory-server + memory driver
npm run test:e2e      # real S3 / GCS (gated by env)
npm run test:smoke    # dist exports + package.json hygiene
npm run test:bench    # microbenchmarks
```

E2E is gated — missing credentials → skipped, never failed. Set `tests/.env`:

```
AWS_ACCESS_KEY_ID=...
AWS_SECRET_ACCESS_KEY=...
AWS_REGION=...
S3_BUCKET_NAME=...
GCS_BUCKET_NAME=...
GCS_PROJECT_ID=...
GCS_KEY_FILENAME=/path/to/gcs-key.json
```

---

## License

MIT © Classytic

See [CLAUDE.md](./CLAUDE.md) for the agent-facing guide.
