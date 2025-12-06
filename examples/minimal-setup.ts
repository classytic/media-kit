/**
 * Minimal Setup Example
 *
 * Shows the simplest way to use media-kit with mongokit
 * - Local storage provider (no AWS/GCS needed)
 * - No image processing (no sharp needed)
 */

import mongoose from 'mongoose';
import { createMedia } from '@classytic/media-kit';
import type { StorageProvider, UploadResult, UploadOptions } from '@classytic/media-kit';
import fs from 'fs/promises';
import path from 'path';

// Simple local storage provider
class LocalStorageProvider implements StorageProvider {
  readonly name = 'local';
  private uploadDir: string;
  private publicUrl: string;

  constructor(config: { uploadDir: string; publicUrl: string }) {
    this.uploadDir = config.uploadDir;
    this.publicUrl = config.publicUrl;
  }

  async upload(buffer: Buffer, filename: string, options?: UploadOptions): Promise<UploadResult> {
    const folder = options?.folder || 'uploads';
    const key = `${folder}/${Date.now()}-${filename}`;
    const fullPath = path.join(this.uploadDir, key);

    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, buffer);
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
      await fs.unlink(path.join(this.uploadDir, key));
      return true;
    } catch {
      return false;
    }
  }

  async exists(key: string): Promise<boolean> {
    try {
      await fs.access(path.join(this.uploadDir, key));
      return true;
    } catch {
      return false;
    }
  }
}

// Setup
const media = createMedia({
  provider: new LocalStorageProvider({
    uploadDir: './public/uploads',
    publicUrl: 'http://localhost:3000/uploads',
  }),
  processing: { enabled: false },
  suppressWarnings: true,
  folders: {
    baseFolders: ['documents', 'images'],
    defaultFolder: 'documents',
  },
});

await mongoose.connect('mongodb://localhost:27017/myapp');

const Media = mongoose.model('Media', media.schema);
media.init(Media);

// Upload a file
const uploaded = await media.upload({
  buffer: Buffer.from('Hello World!'),
  filename: 'hello.txt',
  mimeType: 'text/plain',
  folder: 'documents',
});

console.log('Uploaded:', uploaded.url);

// Get all files with mongokit pagination
const files = await media.getAll({ page: 1, limit: 10 });
console.log('Files:', files.docs.length);
