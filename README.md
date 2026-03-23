# @classytic/media-kit

Production-grade media management for Mongoose with pluggable storage drivers, image processing presets, presigned uploads, multipart/resumable uploads, and smart pagination.

Built on [@classytic/mongokit](https://github.com/classytic/mongokit) for pagination, search, and repository patterns.

## Features

- **Storage drivers** — S3, GCS, Local, Storage Router (multi-backend), or bring your own
- **Image processing** — resize, format conversion (WebP/AVIF/JPEG/PNG), variants, ThumbHash, dominant color
- **Processing presets** — `social-media`, `web-optimized`, `high-quality`, `thumbnail` — one-line config
- **Enhanced Sharp** — mozjpeg, smart WebP subsampling, AVIF effort tuning out of the box
- **Camera RAW support** — pluggable `RawAdapter` for CR2, NEF, DNG, ARW, RAF, ORF, PEF
- **Presigned uploads** — direct client-to-storage with hash verification (skip/etag/sha256)
- **Multipart & resumable** — S3 multipart or GCS resumable, auto-detected from driver
- **Batch presigned URLs** — HLS segments, multi-file uploads in one call
- **Soft delete** — TTL-based with restore, purge, and full storage cleanup
- **Folder management** — tree, breadcrumbs, rename, move, subfolder queries
- **Multi-tenancy** — scoped queries by org/user field
- **Events** — `before:*/after:*/error:*` hooks on every operation
- **Focal point** — per-image crop anchor for responsive display
- **Deduplication** — SHA-256 content hashing
- **URL import** — fetch remote files with SSRF protection

## Install

```bash
npm install @classytic/media-kit @classytic/mongokit mongoose
```

Optional peer dependencies — install only what you need:

```bash
npm install sharp                    # Image processing (resize, format, variants)
npm install @aws-sdk/client-s3 @aws-sdk/s3-request-presigner  # S3 storage
npm install @google-cloud/storage    # GCS storage
npm install mime-types               # Extended MIME detection (built-in fallback included)
```

The library works without optional deps. Without `sharp`, uploads still work but images won't be processed. Without S3/GCS, use the local provider or bring your own.

## Quick Start

```ts
import { createMedia } from '@classytic/media-kit';
import { S3Provider } from '@classytic/media-kit/providers/s3';
import mongoose from 'mongoose';

const media = createMedia({
  driver: new S3Provider({
    bucket: 'my-bucket',
    region: 'us-east-1',
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
    },
  }),
});

const Media = mongoose.model('Media', media.schema);
media.init(Media);

const file = await media.upload({
  buffer: fileBuffer,
  filename: 'photo.jpg',
  mimeType: 'image/jpeg',
  folder: 'products/featured',
});

console.log(file.url);
```

## Storage Providers

Four built-in providers, all implementing the `StorageDriver` interface:

### S3 (+ S3-compatible)

```ts
import { S3Provider } from '@classytic/media-kit/providers/s3';

const driver = new S3Provider({
  bucket: 'my-bucket',
  region: 'us-east-1',
  credentials: { accessKeyId: '...', secretAccessKey: '...' },
  publicUrl: 'https://cdn.example.com',  // optional CDN
  // S3-compatible (MinIO, R2, etc.):
  // endpoint: 'https://minio.example.com',
  // forcePathStyle: true,
});
```

### Google Cloud Storage

```ts
import { GCSProvider } from '@classytic/media-kit/providers/gcs';

const driver = new GCSProvider({
  bucket: 'my-bucket',
  projectId: 'my-project',
  keyFilename: './service-account.json',
});
```

### Local Filesystem

```ts
import { LocalProvider } from '@classytic/media-kit/providers/local';

const driver = new LocalProvider({
  basePath: './uploads',
  baseUrl: 'http://localhost:3000/uploads',
});
```

### Storage Router (multi-backend)

Route files to different backends by key prefix:

```ts
import { StorageRouter } from '@classytic/media-kit/providers/router';

const driver = new StorageRouter({
  drivers: {
    s3: new S3Provider({ ... }),
    local: new LocalProvider({ ... }),
  },
  routes: [
    { prefix: 'temp/', driver: 'local' },
    { prefix: 'drafts/', driver: 'local' },
  ],
  default: 's3',
});
```

### Custom Provider

Implement the `StorageDriver` interface:

```ts
import type { StorageDriver, WriteResult, FileStat } from '@classytic/media-kit';

class MyDriver implements StorageDriver {
  readonly name = 'my-driver';

  async write(key: string, data: Buffer | NodeJS.ReadableStream, contentType: string): Promise<WriteResult> {
    // ...
    return { key, url, size };
  }
  async read(key: string, range?: { start: number; end: number }): Promise<NodeJS.ReadableStream> { ... }
  async delete(key: string): Promise<boolean> { ... }
  async exists(key: string): Promise<boolean> { ... }
  async stat(key: string): Promise<FileStat> { ... }
  getPublicUrl(key: string): string { ... }

  // Optional:
  // list?(prefix: string): AsyncIterable<string>;
  // copy?(source: string, destination: string): Promise<WriteResult>;
  // move?(source: string, destination: string): Promise<WriteResult>;
  // getSignedUrl?(key: string, expiresIn?: number): Promise<string>;
  // getSignedUploadUrl?(key: string, contentType: string, expiresIn?: number): Promise<PresignedUploadResult>;
  // createMultipartUpload?(key: string, contentType: string): Promise<{ uploadId: string }>;
  // signUploadPart?(key: string, uploadId: string, partNumber: number, expiresIn?: number): Promise<SignedPartResult>;
  // completeMultipartUpload?(key: string, uploadId: string, parts: CompletedPart[]): Promise<{ etag: string; size: number }>;
  // abortMultipartUpload?(key: string, uploadId: string): Promise<void>;
  // createResumableUpload?(key: string, contentType: string, options?: { size?: number }): Promise<ResumableUploadSession>;
}
```

## Configuration

```ts
const media = createMedia({
  driver: s3Provider,

  fileTypes: {
    allowed: ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'],
    maxSize: 100 * 1024 * 1024, // 100 MB (default)
  },

  folders: {
    defaultFolder: 'general',
    enableSubfolders: true,
    rewriteKeys: true, // physically move files on rename/move
    contentTypeMap: {
      product: ['products'],
      avatar: ['users', 'avatars'],
    },
  },

  processing: {
    enabled: true,       // requires sharp
    preset: 'web-optimized',  // or 'social-media' | 'high-quality' | 'thumbnail'
    format: 'webp',      // 'webp' | 'jpeg' | 'png' | 'avif' | 'original'
    quality: 80,         // or per-format: { jpeg: 80, webp: 75, avif: 60, png: 90 }
    maxWidth: 2048,
    originalHandling: 'keep-variant', // 'keep-variant' | 'replace' | 'discard'
    generateAlt: true,   // auto alt-text from filename
    aspectRatios: {
      product: { aspectRatio: 3 / 4, fit: 'cover' },
      avatar: { aspectRatio: 1, fit: 'cover' },
      default: { preserveRatio: true },
    },
    sizes: [
      { name: 'thumbnail', width: 150, height: 150 },
      { name: 'medium', width: 800 },
      { name: 'large', width: 1920 },
    ],
    sharpOptions: {
      concurrency: 2,
      cache: false,
      mozjpeg: true,             // trellis quantization (default: true)
      webpSmartSubsample: true,  // sharper chroma (default: true)
      avifEffort: 6,             // 0-9, higher = slower + smaller (default: 6)
    },
  },

  deduplication: { enabled: true, algorithm: 'sha256' },
  softDelete: { enabled: true, ttlDays: 30 },
  concurrency: { maxConcurrent: 5 },
  multiTenancy: { enabled: false, field: 'organizationId' },

  plugins: [/* mongokit plugins */],
  logger: console,
  suppressWarnings: false,
});
```

All fields except `driver` are optional and have sensible defaults.

## Processing Presets

One-line processing configuration for common use cases. User overrides always win over preset defaults.

```ts
const media = createMedia({
  driver,
  processing: { preset: 'web-optimized' },
});
```

| Preset | Max Size | Format | Quality | Variants | Metadata | Use Case |
|--------|----------|--------|---------|----------|----------|----------|
| `social-media` | 1080px | JPEG | 80 | thumb (150), small (320), medium (640) | stripped | Social posts, Instagram, Facebook |
| `web-optimized` | 2048px | WebP | 80 | ThumbHash + dominant color | stripped | Websites, blogs, e-commerce |
| `high-quality` | 4096px | original | 92 | none | preserved | Photography, print, archives |
| `thumbnail` | 300px | WebP | 65 | none, no original kept | stripped | Avatars, icons, previews |

Override any preset field:

```ts
const media = createMedia({
  driver,
  processing: {
    preset: 'social-media',
    maxWidth: 1200,  // override preset's 1080
    sizes: [         // override preset's variants
      { name: 'thumb', width: 200, height: 200 },
      { name: 'large', width: 1200 },
    ],
  },
});
```

## Original Image Handling

Control what happens to the original unprocessed image during processing:

```ts
processing: {
  enabled: true,
  originalHandling: 'keep-variant', // default
}
```

| Mode | Behavior |
|------|----------|
| `keep-variant` | Store original as `__original` variant alongside processed output (default) |
| `replace` | Only processed image is stored — original is not kept |
| `discard` | No original stored, only processed + size variants |

## Camera RAW Support

media-kit detects camera RAW formats (CR2, NEF, DNG, ARW, RAF, ORF, PEF) and can convert them before processing via Sharp. **No RAW library is bundled** — you provide a `RawAdapter` with your preferred converter.

Without a `rawAdapter`, RAW files are uploaded as-is (no processing, no thumbnails).

### Approach 1: Extract Embedded JPEG (fastest, recommended)

Every DSLR RAW file embeds a full-resolution JPEG preview. This is the fastest approach — no sensor decoding needed:

```bash
npm install exiftool-vendored
```

```ts
import { exiftool } from 'exiftool-vendored';
import { writeFileSync, readFileSync, unlinkSync } from 'fs';
import type { RawAdapter } from '@classytic/media-kit';

const rawAdapter: RawAdapter = {
  supportedTypes: [
    'image/x-canon-cr2', 'image/x-nikon-nef', 'image/x-adobe-dng',
    'image/x-sony-arw', 'image/x-fuji-raf', 'image/x-olympus-orf',
  ],
  async convert(buffer, mimeType) {
    const tmp = `/tmp/raw-${Date.now()}`;
    const previewPath = `${tmp}.jpg`;
    writeFileSync(tmp, buffer);
    await exiftool.extractJpgFromRaw(tmp, previewPath);
    const jpeg = readFileSync(previewPath);
    unlinkSync(tmp);
    unlinkSync(previewPath);
    return { buffer: jpeg, mimeType: 'image/jpeg' };
  },
};
```

### Approach 2: dcraw (pure JS via WASM)

Full RAW decode to TIFF, then Sharp processes normally:

```bash
npm install dcraw
```

```ts
import dcraw from 'dcraw';
import type { RawAdapter } from '@classytic/media-kit';

const rawAdapter: RawAdapter = {
  supportedTypes: [
    'image/x-canon-cr2', 'image/x-nikon-nef', 'image/x-adobe-dng',
    'image/x-sony-arw', 'image/x-fuji-raf', 'image/x-olympus-orf',
  ],
  async convert(buffer, mimeType) {
    const tiff = dcraw(buffer, { exportAsTiff: true });
    return { buffer: Buffer.from(tiff), mimeType: 'image/tiff' };
  },
};
```

### Approach 3: LibRaw WASM (full sensor decode)

Best quality — decodes from raw sensor data:

```bash
npm install libraw-wasm
```

```ts
import LibRaw from 'libraw-wasm';
import sharp from 'sharp';
import type { RawAdapter } from '@classytic/media-kit';

const rawAdapter: RawAdapter = {
  supportedTypes: [
    'image/x-canon-cr2', 'image/x-nikon-nef', 'image/x-adobe-dng',
    'image/x-sony-arw', 'image/x-fuji-raf', 'image/x-olympus-orf',
  ],
  async convert(buffer, mimeType) {
    const libraw = await LibRaw.load();
    const decoded = await libraw.decode(buffer);
    const tiff = await sharp(decoded.data, {
      raw: { width: decoded.width, height: decoded.height, channels: 4 },
    }).tiff().toBuffer();
    return { buffer: tiff, mimeType: 'image/tiff' };
  },
};
```

### Wire it up

```ts
const media = createMedia({
  driver,
  processing: {
    enabled: true,
    preset: 'web-optimized',
    rawAdapter,
  },
});

// DSLR uploads now auto-convert → Sharp processes → WebP/AVIF output
await media.upload({ buffer: cr2Buffer, filename: 'photo.cr2', mimeType: 'image/x-canon-cr2' });
```

If RAW conversion fails, the file is uploaded as-is (graceful fallback, no crash).

## API

### Upload & Replace

```ts
const file = await media.upload({ buffer, filename, mimeType, folder, tags, alt, focalPoint }, context?);
const files = await media.uploadMany([...inputs], context?);
const replaced = await media.replace(id, { buffer, filename, mimeType }, context?);
```

### Delete

```ts
await media.delete(id, context?);
await media.deleteMany([id1, id2], context?);   // returns { success[], failed[] }
await media.deleteFolder('old-folder', context?);
```

### Soft Delete

Requires `softDelete: { enabled: true }` in config.

```ts
await media.softDelete(id, context?);
await media.restore(id, context?);
await media.purgeDeleted(olderThan?, context?);  // hard-delete expired
```

### Queries

Powered by mongokit pagination (offset or keyset):

```ts
const file = await media.getById(id, context?);
const page = await media.getAll({ page: 1, limit: 20, sort: '-createdAt', filters: { folder: 'products' } }, context?);
const results = await media.search('shoes', { limit: 10 }, context?);
```

### Folders

```ts
const tree = await media.getFolderTree(context?);
const stats = await media.getFolderStats('products', context?);
const crumbs = media.getBreadcrumb('products/electronics/phones');
const subs = await media.getSubfolders('products', context?);
await media.renameFolder('old/path', 'new/path', context?);
await media.move([id1, id2], 'target-folder', context?);
```

### Tags

```ts
await media.addTags(id, ['sale', 'featured'], context?);
await media.removeTags(id, ['sale'], context?);
```

### Focal Point

```ts
await media.setFocalPoint(id, { x: 0.3, y: 0.2 }, context?);
```

### Presigned Uploads

Direct client-to-storage uploads (no server buffering):

```ts
// Server: generate signed URL
const { uploadUrl, key } = await media.getSignedUploadUrl('photo.jpg', 'image/jpeg', { folder: 'uploads' });

// Client: PUT file directly to S3/GCS
await fetch(uploadUrl, { method: 'PUT', body: file, headers: { 'Content-Type': 'image/jpeg' } });

// Server: confirm + create DB record
const doc = await media.confirmUpload({
  key, filename: 'photo.jpg', mimeType: 'image/jpeg', size: file.size,
  hashStrategy: 'skip',  // 'skip' (default) | 'etag' | 'sha256'
  process: true,          // opt-in: generate ThumbHash, variants, dominant color
}, context?);
```

### Multipart Upload (large files, resumable)

S3 multipart or GCS resumable — auto-detected from driver:

```ts
// Initiate (returns discriminated union: type='multipart' or type='resumable')
const session = await media.initiateMultipartUpload({
  filename: 'video.mp4', contentType: 'video/mp4', folder: 'videos',
  partCount: Math.ceil(fileSize / (5 * 1024 * 1024)), // optional: sign all parts upfront
});

// S3 path (type='multipart'): upload parts in parallel
const parts = await Promise.all(
  chunks.map((chunk, i) =>
    fetch(session.parts[i].uploadUrl, { method: 'PUT', body: chunk })
      .then(r => ({ partNumber: i + 1, etag: r.headers.get('etag')! }))
  )
);

// Complete: assemble parts + create DB record
const doc = await media.completeMultipartUpload({
  key: session.key, uploadId: session.uploadId!, parts,
  filename: 'video.mp4', mimeType: 'video/mp4', size: fileSize,
});

// GCS path (type='resumable'): upload chunks to single URI with Content-Range
// Then call media.confirmUpload({ key: session.key, ... }) — GCS auto-assembles

// On-demand part signing (instead of upfront):
const part = await media.signUploadPart(key, uploadId, partNumber);
const parts = await media.signUploadParts(key, uploadId, [1, 2, 3]);

// Abort abandoned uploads:
await media.abortMultipartUpload(key, uploadId);

// GCS helpers:
const { uploadedBytes } = await media.getResumableUploadStatus(sessionUri);
await media.abortResumableUpload(sessionUri);
```

### Batch Presigned URLs

Generate multiple signed URLs at once (HLS segments, multi-file):

```ts
const { uploads } = await media.generateBatchPutUrls({
  files: [
    { filename: 'segment-0.ts', contentType: 'video/mp2t' },
    { filename: 'segment-1.ts', contentType: 'video/mp2t' },
  ],
  folder: 'live/session-abc',
});
```

### URL Import

```ts
const file = await media.importFromUrl('https://example.com/photo.jpg', { folder: 'imports', tags: ['external'] }, context?);
```

### Lifecycle

```ts
media.dispose(); // release listeners and cached state
```

## Events

Subscribe to lifecycle hooks with `on()`. All listeners are awaited (`Promise.allSettled`).

```ts
media.on('before:upload', async (event) => { /* modify event.data */ });
media.on('after:upload', async (event) => { await notifyUser(event.result); });
media.on('error:upload', async (event) => { console.error(event.error); });
```

Every operation follows a `before:*/after:*/error:*` pattern:

`upload` `uploadMany` `delete` `deleteMany` `move` `replace` `softDelete` `restore` `import` `presignedUpload` `confirmUpload` `rename` `multipartUpload` `completeMultipart`

Plus `before:validate`, `after:process`, and progress events for bulk operations:

```ts
media.on('progress:move', (event) => {
  console.log(`${event.completed}/${event.total} files moved`);
});
```

## Multi-Tenancy

```ts
const media = createMedia({
  driver,
  multiTenancy: { enabled: true, field: 'organizationId', required: true },
});

// All operations scoped to the org
const ctx = { userId: user._id, organizationId: org._id };
await media.upload(input, ctx);
await media.getAll({ limit: 20 }, ctx);
```

## Asset Transforms (on-the-fly)

Serve transformed images on the fly with URL query parameters. No pre-generation needed:

```ts
import { AssetTransform } from '@classytic/media-kit/transforms';

const transform = new AssetTransform(driver, { cache: true });

// Express/Fastify route
app.get('/assets/:key(*)', async (req, res) => {
  // GET /assets/products/photo.jpg?w=400&h=300&format=webp&q=80
  const result = await transform.serve(req.params.key, req.query);
  res.status(result.status).set(result.headers).send(result.body);
});
```

Supported params: `w` (width), `h` (height), `q` (quality 1-100), `format` (webp/avif/jpeg/png/auto), `fit` (cover/contain/fill/inside/outside), `download` (force download).

## Using Schema or Repository Directly

```ts
import { createMediaSchema, createMediaRepository } from '@classytic/media-kit';

// Schema only
const schema = createMediaSchema({ multiTenancy: { enabled: true } });
const Media = mongoose.model('Media', schema);

// Repository only (extends mongokit Repository)
const repo = createMediaRepository(Media, { multiTenancy: { enabled: true } });
const tree = await repo.getFolderTree(context);
```

## Exports

```ts
// Main entry
import { createMedia, createMediaSchema, createMediaRepository, PROCESSING_PRESETS } from '@classytic/media-kit';

// Storage providers
import { S3Provider } from '@classytic/media-kit/providers/s3';
import { GCSProvider } from '@classytic/media-kit/providers/gcs';
import { LocalProvider } from '@classytic/media-kit/providers/local';
import { StorageRouter } from '@classytic/media-kit/providers/router';

// Asset transforms
import { AssetTransform } from '@classytic/media-kit/transforms';

// Types
import type {
  StorageDriver, ProcessingConfig, ProcessingPresetName,
  OriginalHandling, RawAdapter, VideoAdapter, ImageAdapter,
  SharpOptions, SizeVariant, FocalPoint, IMedia,
} from '@classytic/media-kit';
```

## Peer Dependencies

All peer deps use floor versions (`>=`) — media-kit works with any compatible version:

| Package | Required | Version |
|---------|----------|---------|
| `@classytic/mongokit` | yes | >= 3.2.0 |
| `mongoose` | yes | >= 8.0.0 |
| `sharp` | optional | >= 0.33.0 |
| `@aws-sdk/client-s3` | optional | >= 3.0.0 |
| `@aws-sdk/s3-request-presigner` | optional | >= 3.0.0 |
| `@google-cloud/storage` | optional | >= 7.0.0 |
| `mime-types` | optional | >= 2.1.0 |

## License

MIT
