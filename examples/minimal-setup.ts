/**
 * Minimal Setup Example
 *
 * Shows how media-kit works with minimal dependencies
 * - No sharp (image processing disabled)
 * - No warnings
 * - Simple local storage provider
 */

import mongoose from 'mongoose';
import { createMedia } from '@classytic/media-kit';
import type { StorageProvider, UploadResult, UploadOptions } from '@classytic/media-kit';
import fs from 'fs/promises';
import path from 'path';

// ==================================================
// CUSTOM LOCAL STORAGE PROVIDER (No AWS/GCS needed!)
// ==================================================

class LocalStorageProvider implements StorageProvider {
  readonly name = 'local';
  private uploadDir: string;
  private publicUrl: string;

  constructor(config: { uploadDir: string; publicUrl: string }) {
    this.uploadDir = config.uploadDir;
    this.publicUrl = config.publicUrl;
  }

  async upload(
    buffer: Buffer,
    filename: string,
    options?: UploadOptions
  ): Promise<UploadResult> {
    const folder = options?.folder || 'uploads';
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(7);
    const safeName = filename.replace(/[^a-zA-Z0-9.-]/g, '_');
    const key = `${folder}/${timestamp}-${random}-${safeName}`;

    // Create directory
    const fullPath = path.join(this.uploadDir, key);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });

    // Write file
    await fs.writeFile(fullPath, buffer);

    // Get file size
    const stats = await fs.stat(fullPath);

    return {
      url: `${this.publicUrl}/${key}`,
      key,
      size: stats.size,
      mimeType: options?.metadata?.mimeType || 'application/octet-stream',
    };
  }

  async delete(key: string): Promise<boolean> {
    try {
      const fullPath = path.join(this.uploadDir, key);
      await fs.unlink(fullPath);
      return true;
    } catch {
      return false;
    }
  }

  async exists(key: string): Promise<boolean> {
    try {
      const fullPath = path.join(this.uploadDir, key);
      await fs.access(fullPath);
      return true;
    } catch {
      return false;
    }
  }
}

// ==================================================
// SETUP MEDIA KIT - NO SHARP, NO S3, NO GCS!
// ==================================================

const media = createMedia({
  // Custom local provider - no AWS/GCS SDK needed
  provider: new LocalStorageProvider({
    uploadDir: './public/uploads',
    publicUrl: 'http://localhost:3000/uploads',
  }),

  // Disable image processing - no sharp needed
  processing: {
    enabled: false,
  },

  // Suppress warnings about missing sharp
  suppressWarnings: true,

  // Basic configuration
  folders: {
    baseFolders: ['documents', 'images', 'videos'],
    defaultFolder: 'documents',
  },

  fileTypes: {
    allowed: ['*/*'], // Accept all files
    maxSize: 10 * 1024 * 1024, // 10MB
  },
});

// Connect to MongoDB
await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/mediakit');

// Create and initialize model
const Media = mongoose.model('Media', media.schema);
media.init(Media);

// ==================================================
// USAGE - Works perfectly without sharp/S3/GCS!
// ==================================================

async function uploadDocument() {
  const fileBuffer = Buffer.from('Hello, this is a test document!');

  const uploaded = await media.upload({
    buffer: fileBuffer,
    filename: 'test-document.txt',
    mimeType: 'text/plain',
    folder: 'documents',
    title: 'Test Document',
  });

  console.log('✅ Uploaded successfully!');
  console.log('URL:', uploaded.url);
  console.log('Size:', uploaded.size, 'bytes');

  return uploaded;
}

async function listFiles() {
  const files = await Media.find()
    .sort({ createdAt: -1 })
    .limit(10)
    .lean();

  console.log(`\n📂 Found ${files.length} files:`);
  files.forEach((file) => {
    console.log(`  - ${file.filename} (${file.size} bytes)`);
  });

  return files;
}

// Run example
uploadDocument()
  .then(() => listFiles())
  .then(() => {
    console.log('\n✨ All done! No sharp, no S3, no GCS needed!');
    process.exit(0);
  })
  .catch((error) => {
    console.error('Error:', error.message);
    process.exit(1);
  });

// ==================================================
// KEY POINTS:
// ==================================================
//
// 1. ✅ No sharp needed - just set processing.enabled = false
// 2. ✅ No S3/GCS SDKs - use custom provider or local storage
// 3. ✅ No warnings - set suppressWarnings = true
// 4. ✅ Still get all core features:
//    - Database schema
//    - Folder organization
//    - File validation
//    - Multi-tenancy support
//    - Event system
//    - Type safety
//
// 5. ⚠️ What you lose without sharp:
//    - No image resizing
//    - No format conversion (WebP, AVIF, etc.)
//    - No multi-size generation
//    - No automatic dimensions
//
// 6. ⚠️ What you lose without S3/GCS:
//    - No cloud storage
//    - Need to implement your own provider (easy!)
//
// 7. 💡 When to enable features:
//    - Add sharp when you need image optimization
//    - Add S3/GCS when you need cloud storage
//    - Start simple, add features as needed!
