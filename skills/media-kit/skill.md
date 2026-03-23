---
name: media-kit
description: |
  @classytic/media-kit — Production-grade media management for Mongoose with pluggable storage (S3, GCS, local).
  Use when building file uploads, image processing, presigned uploads, multipart uploads, media CRUD,
  asset transforms, or integrating cloud storage with MongoDB.
  Triggers: media upload, file storage, s3 upload, gcs upload, presigned url, multipart upload,
  image processing, sharp, media management, asset transform, media-kit, storage driver.
version: 3.1.0
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
  - file-management
progressive_disclosure:
  entry_point:
    summary: "Media management for Mongoose: S3/GCS storage, image processing, presigned/multipart uploads, soft delete, multi-tenancy"
    when_to_use: "Building file uploads, cloud storage integration, image processing, presigned/multipart uploads, or media CRUD with MongoDB"
    quick_start: "1. npm install @classytic/media-kit 2. createMedia({ driver: new S3Provider({...}) }) 3. media.upload/getSignedUploadUrl/confirmUpload"
  context_limit: 700
---

# @classytic/media-kit

Production-grade media management for Mongoose with pluggable storage drivers, image processing, presigned/multipart uploads, and full TypeScript support. **458 tests.** Built on `@classytic/mongokit`.

**Requires:** Mongoose `^9.0.0` | Node.js `>=18`

## Installation

```bash
npm install @classytic/media-kit @classytic/mongokit mongoose
# Optional peer deps:
npm install sharp                                          # Image processing
npm install @aws-sdk/client-s3 @aws-sdk/s3-request-presigner  # S3
npm install @google-cloud/storage                          # GCS
```

## Core Pattern

```typescript
import { createMedia } from '@classytic/media-kit';
import { S3Provider } from '@classytic/media-kit/providers/s3';
import mongoose from 'mongoose';

const media = createMedia({
  driver: new S3Provider({ bucket: 'my-bucket', region: 'us-east-1', credentials: { accessKeyId: '...', secretAccessKey: '...' } }),
  processing: { enabled: true, format: 'webp', quality: 80, sizes: [{ name: 'thumb', width: 150, height: 150 }, { name: 'large', width: 1920 }] },
  fileTypes: { allowed: ['image/*', 'video/*'], maxSize: 100 * 1024 * 1024 },
  softDelete: { enabled: true, ttlDays: 30 },
  multiTenancy: { enabled: true, field: 'organizationId' },
});

const Media = mongoose.model('Media', media.schema);
media.init(Media);
```

## Storage Drivers

| Driver | Import | Use Case |
|--------|--------|----------|
| `S3Provider` | `@classytic/media-kit/providers/s3` | AWS S3, MinIO, R2, DigitalOcean Spaces |
| `GCSProvider` | `@classytic/media-kit/providers/gcs` | Google Cloud Storage |
| `LocalProvider` | `@classytic/media-kit/providers/local` | Local filesystem (dev) |
| `StorageRouter` | `@classytic/media-kit/providers/router` | Multi-backend routing by key prefix |

### S3Provider Config

```typescript
new S3Provider({
  bucket: string,
  region: string,
  credentials?: { accessKeyId, secretAccessKey },
  endpoint?: string,       // S3-compatible services
  publicUrl?: string,      // CDN URL
  acl?: 'private' | 'public-read',
  forcePathStyle?: boolean,
})
```

### GCSProvider Config

```typescript
new GCSProvider({
  bucket: string,
  projectId?: string,
  keyFilename?: string,
  credentials?: { client_email, private_key },
  makePublic?: boolean,
  publicUrl?: string,
})
```

## Upload Operations

### Standard Upload (buffer to storage)

```typescript
const file = await media.upload({
  buffer, filename: 'photo.jpg', mimeType: 'image/jpeg',
  folder: 'products', tags: ['featured'], alt: 'Product photo',
  focalPoint: { x: 0.3, y: 0.4 },  // for smart cropping
  quality: 85, format: 'webp', maxWidth: 2048,
}, context?);
// Returns: { _id, url, key, mimeType, size, width, height, hash, status, variants[], thumbhash, dominantColor, ... }

const files = await media.uploadMany([...inputs], context?);
const replaced = await media.replace(id, { buffer, filename, mimeType }, context?);
```

### Presigned Upload (client-direct, no server buffering)

```typescript
// 1. Server generates signed URL
const { uploadUrl, key } = await media.getSignedUploadUrl('video.mp4', 'video/mp4', { folder: 'videos' });

// 2. Client PUTs directly to S3/GCS
await fetch(uploadUrl, { method: 'PUT', body: file });

// 3. Server confirms + creates DB record
const doc = await media.confirmUpload({
  key, filename: 'video.mp4', mimeType: 'video/mp4', size: file.size,
  hashStrategy: 'skip',  // 'skip' (default, zero cost) | 'etag' | 'sha256'
  process: true,          // opt-in: ThumbHash, variants, dominant color
}, context?);
```

### Multipart Upload (large files >5GB, resumable)

Auto-detects driver: S3 returns `type='multipart'`, GCS returns `type='resumable'`.

```typescript
// Initiate session with all part URLs signed upfront
const session = await media.initiateMultipartUpload({
  filename: 'raw-footage.mov', contentType: 'video/quicktime',
  folder: 'videos', partCount: Math.ceil(fileSize / PART_SIZE),
});

if (session.type === 'multipart') {
  // S3: parallel part uploads
  const parts = await Promise.all(
    chunks.map((chunk, i) =>
      fetch(session.parts[i].uploadUrl, { method: 'PUT', body: chunk })
        .then(r => ({ partNumber: i + 1, etag: r.headers.get('etag')! }))
    )
  );
  const doc = await media.completeMultipartUpload({
    key: session.key, uploadId: session.uploadId!, parts,
    filename: 'raw-footage.mov', mimeType: 'video/quicktime', size: fileSize,
  });
} else {
  // GCS: sequential chunks to single URI with Content-Range headers
  // Then: media.confirmUpload({ key: session.key, ... })
}

// On-demand part signing, abort, GCS helpers:
await media.signUploadPart(key, uploadId, partNumber);
await media.signUploadParts(key, uploadId, [1, 2, 3]);
await media.abortMultipartUpload(key, uploadId);
await media.getResumableUploadStatus(sessionUri);
await media.abortResumableUpload(sessionUri);
```

### Batch Presigned URLs (HLS segments, multi-file)

```typescript
const { uploads } = await media.generateBatchPutUrls({
  files: [{ filename: 'seg-0.ts', contentType: 'video/mp2t' }, ...],
  folder: 'live/session-abc',
});
```

## CRUD & Queries

```typescript
const file = await media.getById(id, context?);
const page = await media.getAll({ page: 1, limit: 20, sort: '-createdAt', filters: { folder: 'products' } }, context?);
const results = await media.search('shoes', { limit: 10 }, context?);
await media.delete(id, context?);
await media.deleteMany([id1, id2], context?);
await media.softDelete(id, context?);
await media.restore(id, context?);
await media.purgeDeleted(olderThan?, context?);
```

## Folders & Organization

```typescript
const tree = await media.getFolderTree(context?);
const stats = await media.getFolderStats('products', context?);
const crumbs = media.getBreadcrumb('products/electronics/phones');
await media.renameFolder('old/path', 'new/path', context?);
await media.move([id1, id2], 'target-folder', context?);
await media.addTags(id, ['sale', 'featured'], context?);
await media.setFocalPoint(id, { x: 0.3, y: 0.2 }, context?);
```

## Image Processing

Requires `sharp`. Aspect ratio preserved by default. Only crops when explicitly configured.

```typescript
processing: {
  enabled: true,
  format: 'webp',          // 'webp' | 'jpeg' | 'png' | 'avif' | 'original'
  quality: 80,              // or { jpeg: 82, webp: 82, avif: 50, png: 100 }
  maxWidth: 2048,
  keepOriginal: true,       // store untouched original as '__original' variant
  smartSkip: true,          // skip re-compression if already optimized
  generateAlt: true,        // auto alt-text from filename
  aspectRatios: {
    product: { aspectRatio: 3/4, fit: 'cover' },
    avatar: { aspectRatio: 1, fit: 'cover' },
    default: { preserveRatio: true },  // never crop (default)
  },
  sizes: [
    { name: 'thumbnail', width: 150, height: 150 },  // width+height = crop
    { name: 'medium', width: 800 },                   // width-only = preserve ratio
    { name: 'large', width: 1920 },
  ],
}
```

**Focal point cropping:** When aspect ratio is enforced with a focal point, uses Payload CMS's extract-then-resize algorithm to keep the subject visible.

**Auto-features:** ThumbHash (blur placeholder), dominant color extraction, EXIF metadata, video thumbnail via optional `videoAdapter`.

## Events

```typescript
media.on('before:upload', async (event) => { /* validate/modify */ });
media.on('after:upload', async (event) => { await notify(event.result); });
media.on('error:upload', async (event) => { log(event.error); });
// Operations: upload, delete, move, replace, softDelete, restore, import,
// presignedUpload, confirmUpload, multipartUpload, completeMultipart, rename
```

## Multi-Tenancy

```typescript
const media = createMedia({
  driver,
  multiTenancy: { enabled: true, field: 'organizationId', required: true },
});

// All operations auto-scoped
const ctx = { userId: user._id, organizationId: org._id };
await media.upload(input, ctx);
await media.getAll({ limit: 20 }, ctx);
```

## Key Types

```typescript
import type {
  MediaKit, StorageDriver, WriteResult, FileStat, PresignedUploadResult,
  UploadInput, ConfirmUploadInput, HashStrategy,
  InitiateMultipartInput, CompleteMultipartInput, MultipartUploadSession,
  SignedPartResult, CompletedPart, ResumableUploadSession,
  BatchPresignInput, BatchPresignResult,
  IMedia, IMediaDocument, MediaStatus, FocalPoint,
  ProcessingOptions, SizeVariant, GeneratedVariant,
  MediaKitConfig, FileTypesConfig, SoftDeleteConfig,
} from '@classytic/media-kit';
```

## StorageDriver Interface

Required methods: `write`, `read`, `delete`, `exists`, `stat`, `getPublicUrl`.

Optional: `list`, `copy`, `move`, `getSignedUrl`, `getSignedUploadUrl`, `createMultipartUpload`, `signUploadPart`, `completeMultipartUpload`, `abortMultipartUpload`, `createResumableUpload`, `abortResumableUpload`, `getResumableUploadStatus`.
