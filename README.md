# @classytic/media-kit

> Production-grade media management for Mongoose with pluggable storage providers

**Works with:** Ecommerce • Hotels • Schools • ERPs • SaaS • Personal vaults

- ✅ **Pluggable storage** - S3, GCS, or bring your own
- ✅ **Multi-size generation** - Auto-generate thumbnail, medium, large variants
- ✅ **Image processing** - WebP conversion, aspect ratios, quality control
- ✅ **Alt text generation** - Automatic accessibility from filenames
- ✅ **Event system** - Hooks for upload, delete, and custom logic
- ✅ **Multi-tenancy** - Built-in organization isolation
- ✅ **Folder organization** - Virtual folders with tree structure for UI
- ✅ **Mongokit integration** - Advanced pagination, search, and filters
- ✅ **Type-safe** - Full TypeScript support
- ✅ **Framework agnostic** - Works with Express, Fastify, NestJS, etc.

---

## 📦 Installation

### Minimal Install (works immediately!)

```bash
npm install @classytic/media-kit mongoose
```

**That's it!** The library works with just these two packages. Everything else is optional.

### Optional Features (install when needed)

```bash
# Image processing (resizing, format conversion, multi-size)
npm install sharp

# AWS S3 storage
npm install @aws-sdk/client-s3

# Google Cloud Storage
npm install @google-cloud/storage

# Advanced pagination and search
npm install @classytic/mongokit
```

### ✨ Graceful Degradation

**The library works even if you don't install optional dependencies:**

- **Without sharp**: File uploads work, but no image processing (resizing, format conversion, etc.)
- **Without S3/GCS**: Use a custom storage provider (see [examples/minimal-setup.ts](./examples/minimal-setup.ts))
- **Without mongokit**: Basic CRUD works, but you lose advanced pagination features

**Suppress warnings:**
```typescript
const media = createMedia({
  provider: yourProvider,
  processing: { enabled: false }, // Disable if no sharp
  suppressWarnings: true, // No warnings about missing deps
});
```

---

## 🚀 Quick Start

```typescript
import { createMedia } from '@classytic/media-kit';
import { S3Provider } from '@classytic/media-kit/providers/s3';
import mongoose from 'mongoose';

// 1. Create media kit instance
const media = createMedia({
  provider: new S3Provider({
    bucket: 'my-bucket',
    region: 'us-east-1',
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
    },
  }),
  folders: {
    baseFolders: ['products', 'users', 'blog'],
  },
});

// 2. Create Mongoose model from schema
const Media = mongoose.model('Media', media.schema);

// 3. Initialize with model
media.init(Media);

// 4. Upload files
const uploaded = await media.upload({
  buffer: fileBuffer,
  filename: 'product-photo.jpg',
  mimeType: 'image/jpeg',
  folder: 'products/featured',
  alt: 'Product image',
});

console.log(uploaded.url); // https://my-bucket.s3.amazonaws.com/...
```

---

## 🎯 New Features

### Multi-Size Generation

Automatically generate multiple size variants (thumbnail, medium, large) from a single upload:

```typescript
const media = createMedia({
  provider: s3Provider,
  processing: {
    enabled: true,
    format: 'webp',
    quality: 80,
    // Define size variants
    sizes: [
      { name: 'thumbnail', width: 150, height: 150 },
      { name: 'medium', width: 800 },
      { name: 'large', width: 1920 },
    ],
  },
});

// Upload once, get all sizes
const uploaded = await media.upload({
  buffer: imageBuffer,
  filename: 'product.jpg',
  mimeType: 'image/jpeg',
  folder: 'products',
});

console.log(uploaded.url); // Original/processed
console.log(uploaded.variants); // Array of size variants
// [
//   { name: 'thumbnail', url: '...', width: 150, height: 150, size: 5120 },
//   { name: 'medium', url: '...', width: 800, height: 600, size: 45000 },
//   { name: 'large', url: '...', width: 1920, height: 1440, size: 180000 }
// ]
```

### Automatic Alt Text Generation

Improve accessibility with automatic alt text generation from filenames:

```typescript
const media = createMedia({
  provider: s3Provider,
  processing: {
    enabled: true,
    // Enable auto alt-text generation
    generateAlt: true,
  },
});

// Upload without alt text
const uploaded = await media.upload({
  buffer: imageBuffer,
  filename: 'red-running-shoes-nike.jpg',
  mimeType: 'image/jpeg',
  // No alt provided
});

console.log(uploaded.alt); // "Red running shoes nike" (auto-generated)
```

**Custom alt generation:**
```typescript
const media = createMedia({
  provider: s3Provider,
  processing: {
    generateAlt: {
      enabled: true,
      strategy: 'filename', // or 'ai' if you have an AI service
      fallback: 'Product image',
      generator: async (filename) => {
        // Your custom logic
        return `Custom alt for ${filename}`;
      },
    },
  },
});
```

### Event System

Hook into upload/delete operations for custom logic:

```typescript
const media = createMedia({
  provider: s3Provider,
});

media.init(MediaModel);

// Before upload hook - modify data
media.on('before:upload', async (event) => {
  console.log('Uploading:', event.data.filename);
  // You can modify event.data here
});

// After upload hook - trigger actions
media.on('after:upload', async (event) => {
  const { result } = event;
  console.log('Uploaded:', result.url);

  // Send notification
  await notifyUser(result);

  // Update search index
  await searchIndex.add(result);

  // Generate thumbnails asynchronously
  await generateThumbnails(result);
});

// Error handling
media.on('error:upload', async (event) => {
  console.error('Upload failed:', event.error.message);
  await logError(event.error);
});

// Available events:
// - before:upload, after:upload, error:upload
// - before:uploadMany, after:uploadMany, error:uploadMany
// - before:delete, after:delete, error:delete
// - before:deleteMany, after:deleteMany, error:deleteMany
// - before:move, after:move, error:move
```

### Integration with @classytic/mongokit

Use mongokit's powerful pagination and search features:

```typescript
import { Repository } from '@classytic/mongokit';
import { createMedia } from '@classytic/media-kit';

// Create media kit
const media = createMedia({
  provider: s3Provider,
});

const Media = mongoose.model('Media', media.schema);
media.init(Media);

// The repository is exposed
const repo = media.repository;

// Advanced pagination with mongokit
const result = await Media.find().paginate({
  page: 1,
  limit: 20,
  sort: '-createdAt',
  filters: {
    folder: 'products',
    mimeType: { $regex: '^image/' }
  },
});

// Cursor-based pagination for infinite scroll
const feed = await Media.find().paginate({
  limit: 20,
  after: cursorToken, // From previous request
  sort: '-createdAt',
});

// Full-text search (requires text index)
const searchResults = await Media.find().paginate({
  search: 'product shoes',
  limit: 20,
});

// Filter by folder, type, date range
const filtered = await Media.find().paginate({
  filters: {
    baseFolder: 'products',
    createdAt: { $gte: new Date('2024-01-01') },
    dimensions: { $exists: true }, // Only images with dimensions
  },
  limit: 50,
});
```

---

## 📖 Configuration

### Full Configuration Example

```typescript
const media = createMedia({
  // Storage provider (required)
  provider: new S3Provider({ ... }),

  // File type restrictions
  fileTypes: {
    allowed: ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'],
    maxSize: 10 * 1024 * 1024, // 10MB
  },

  // Folder organization
  folders: {
    baseFolders: ['products', 'categories', 'users', 'blog'],
    defaultFolder: 'general',
    // Map folders to content types for auto aspect ratio
    contentTypeMap: {
      product: ['products', 'product'],
      category: ['categories', 'category'],
      avatar: ['users', 'avatars'],
    },
  },

  // Image processing (requires sharp)
  processing: {
    enabled: true,
    maxWidth: 2048,
    quality: 80,
    format: 'webp', // 'webp' | 'jpeg' | 'png' | 'avif' | 'original'
    aspectRatios: {
      product: { aspectRatio: 3/4, fit: 'cover' },   // Vertical
      category: { aspectRatio: 1, fit: 'cover' },    // Square
      avatar: { aspectRatio: 1, fit: 'cover' },      // Square
      default: { preserveRatio: true },              // Keep original
    },
  },

  // Multi-tenancy (for SaaS)
  multiTenancy: {
    enabled: true,
    field: 'organizationId',
    required: true,
  },

  // Logger (optional)
  logger: console,
});
```

---

## 🗄️ Storage Providers

### AWS S3

```typescript
import { S3Provider } from '@classytic/media-kit/providers/s3';

const provider = new S3Provider({
  bucket: 'my-bucket',
  region: 'us-east-1',
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
  },
  // Optional: Custom CDN URL
  publicUrl: 'https://cdn.example.com',
  // Optional: ACL for uploads
  acl: 'public-read', // default
});
```

### Google Cloud Storage

```typescript
import { GCSProvider } from '@classytic/media-kit/providers/gcs';

const provider = new GCSProvider({
  bucket: 'my-bucket',
  projectId: 'my-project',
  keyFilename: './service-account.json',
  // Or use credentials object
  credentials: {
    client_email: '...',
    private_key: '...',
  },
  // Optional: Custom CDN URL
  publicUrl: 'https://cdn.example.com',
});
```

### S3-Compatible (MinIO, Cloudflare R2, etc.)

```typescript
const provider = new S3Provider({
  bucket: 'my-bucket',
  region: 'auto',
  endpoint: 'https://my-minio-server.com',
  forcePathStyle: true,
  credentials: { ... },
});
```

### Custom Provider

```typescript
import type { StorageProvider, UploadResult, UploadOptions } from '@classytic/media-kit';

class MyProvider implements StorageProvider {
  readonly name = 'my-provider';

  async upload(buffer: Buffer, filename: string, options?: UploadOptions): Promise<UploadResult> {
    // Your upload logic
    return { url, key, size, mimeType };
  }

  async delete(key: string): Promise<boolean> {
    // Your delete logic
    return true;
  }

  async exists(key: string): Promise<boolean> {
    // Check if file exists
    return true;
  }
}
```

---

## 📁 Folder Organization

### Virtual Folders

Files are organized in virtual folders stored as path strings:

```typescript
// Upload to specific folder
await media.upload({
  buffer,
  filename: 'photo.jpg',
  mimeType: 'image/jpeg',
  folder: 'products/electronics/phones', // Nested path
});

// Results in:
// baseFolder: 'products'
// folder: 'products/electronics/phones'
```

### Folder Tree (for File Explorer UI)

```typescript
const tree = await media.getFolderTree();

// Response:
{
  folders: [
    {
      id: 'products',
      name: 'products',
      path: 'products',
      stats: { count: 150, size: 45000000 },
      children: [
        {
          id: 'products/electronics',
          name: 'electronics',
          path: 'products/electronics',
          stats: { count: 50, size: 15000000 },
          children: []
        }
      ]
    }
  ],
  meta: { totalFiles: 500, totalSize: 150000000 }
}
```

### Breadcrumb

```typescript
const breadcrumb = media.getBreadcrumb('products/electronics/phones');

// Response:
[
  { name: 'products', path: 'products' },
  { name: 'electronics', path: 'products/electronics' },
  { name: 'phones', path: 'products/electronics/phones' }
]
```

### Folder Stats

```typescript
const stats = await media.getFolderStats('products');

// Response:
{
  totalFiles: 150,
  totalSize: 45000000,
  avgSize: 300000,
  mimeTypes: ['image/webp', 'image/jpeg'],
  oldestFile: Date,
  newestFile: Date
}
```

---

## 🏢 Multi-Tenancy

Enable organization isolation for SaaS applications:

```typescript
const media = createMedia({
  provider,
  multiTenancy: {
    enabled: true,
    field: 'organizationId', // Custom field name
    required: true,          // Require on all operations
  },
});

// Pass context with organization ID
const context = { 
  userId: user._id,
  organizationId: org._id 
};

// All operations are scoped to organization
await media.upload(input, context);
await media.getFolderTree(context);
await media.delete(id, context);
```

---

## 🖼️ Image Processing

### Automatic Processing

Images are automatically processed based on folder/content type:

```typescript
// Upload to products folder → 3:4 aspect ratio, WebP
await media.upload({
  buffer,
  filename: 'product.jpg',
  mimeType: 'image/jpeg',
  folder: 'products/featured',
});

// Upload to users folder → 1:1 aspect ratio, WebP
await media.upload({
  buffer,
  filename: 'avatar.jpg',
  mimeType: 'image/jpeg',
  folder: 'users/avatars',
});
```

### Skip Processing

```typescript
await media.upload({
  buffer,
  filename: 'original.jpg',
  mimeType: 'image/jpeg',
  folder: 'products',
  skipProcessing: true, // Keep original
});
```

### Force Content Type

```typescript
await media.upload({
  buffer,
  filename: 'photo.jpg',
  mimeType: 'image/jpeg',
  folder: 'blog', // Would normally preserve ratio
  contentType: 'product', // Force 3:4 aspect ratio
});
```

---

## 📚 API Reference

### Core Methods

| Method | Description |
|--------|-------------|
| `upload(input, context?)` | Upload single file |
| `uploadMany(inputs, context?)` | Upload multiple files |
| `delete(id, context?)` | Delete single file |
| `deleteMany(ids, context?)` | Delete multiple files |
| `move(ids, folder, context?)` | Move files to folder |

### Folder Methods

| Method | Description |
|--------|-------------|
| `getFolderTree(context?)` | Get folder tree for UI |
| `getFolderStats(folder, context?)` | Get folder statistics |
| `getBreadcrumb(folder)` | Get breadcrumb path |
| `deleteFolder(folder, context?)` | Delete all files in folder |

### Utilities

| Method | Description |
|--------|-------------|
| `validateFile(buffer, filename, mimeType)` | Validate file against config |
| `getContentType(folder)` | Get content type for folder |

---

## 🔧 Using with Repository

The package exports a repository class for direct database operations:

```typescript
import { createMediaRepository } from '@classytic/media-kit';

const repo = createMediaRepository(MediaModel, {
  multiTenancy: { enabled: true },
});

// Use repository methods
const files = await repo.getAll({ 
  filters: { folder: 'products' },
  sort: '-createdAt',
  limit: 20,
  page: 1,
});

const tree = await repo.getFolderTree(context);
```

---

## 🎨 Using Schema Directly

You can use the schema factory independently:

```typescript
import { createMediaSchema } from '@classytic/media-kit';

// Create with custom options
const schema = createMediaSchema({
  baseFolders: ['products', 'users'],
  multiTenancy: { enabled: true },
  additionalFields: {
    customField: { type: String },
  },
});

// Add your own methods
schema.methods.getPublicUrl = function() {
  return `https://cdn.example.com/${this.key}`;
};

const Media = mongoose.model('Media', schema);
```

---

## 🔌 Framework Integration

### Fastify

```typescript
import fp from 'fastify-plugin';
import { createMedia } from '@classytic/media-kit';
import { S3Provider } from '@classytic/media-kit/providers/s3';

async function mediaPlugin(fastify) {
  const media = createMedia({
    provider: new S3Provider({ ... }),
    logger: fastify.log,
  });

  const Media = mongoose.model('Media', media.schema);
  media.init(Media);

  fastify.decorate('media', media);
}

export default fp(mediaPlugin, { name: 'media' });
```

### Express

```typescript
import { createMedia } from '@classytic/media-kit';
import { S3Provider } from '@classytic/media-kit/providers/s3';
import multer from 'multer';

const media = createMedia({ provider: new S3Provider({ ... }) });
const Media = mongoose.model('Media', media.schema);
media.init(Media);

const upload = multer({ storage: multer.memoryStorage() });

app.post('/upload', upload.single('file'), async (req, res) => {
  const uploaded = await media.upload({
    buffer: req.file.buffer,
    filename: req.file.originalname,
    mimeType: req.file.mimetype,
    folder: req.body.folder,
  });
  res.json(uploaded);
});
```

---

## 📄 License

MIT © [Classytic](https://github.com/classytic)
