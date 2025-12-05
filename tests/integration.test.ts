/**
 * Integration Tests - Full Upload/Delete Flow
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import mongoose from 'mongoose';
import { createMedia } from '../src/media';
import type { StorageProvider, UploadResult, UploadOptions } from '../src/types';

// Mock in-memory storage provider
class MemoryStorageProvider implements StorageProvider {
  readonly name = 'memory';
  private storage = new Map<string, { buffer: Buffer; mimeType: string }>();

  async upload(buffer: Buffer, filename: string, options?: UploadOptions): Promise<UploadResult> {
    const key = `${options?.folder || 'uploads'}/${Date.now()}-${filename}`;
    const url = `https://cdn.example.com/${key}`;

    this.storage.set(key, { buffer, mimeType: options?.metadata?.mimeType || 'application/octet-stream' });

    return {
      url,
      key,
      size: buffer.length,
      mimeType: options?.metadata?.mimeType || 'application/octet-stream',
    };
  }

  async delete(key: string): Promise<boolean> {
    return this.storage.delete(key);
  }

  async exists(key: string): Promise<boolean> {
    return this.storage.has(key);
  }

  clear() {
    this.storage.clear();
  }
}

describe('Media Kit Integration Tests', () => {
  let provider: MemoryStorageProvider;

  beforeAll(async () => {
    // Connect to test database
    await mongoose.connect('mongodb://localhost:27017/mediakit-test');
  });

  afterAll(async () => {
    // Disconnect
    await mongoose.disconnect();
  });

  afterEach(async () => {
    // Clean up all test collections
    const collections = await mongoose.connection.db?.collections();
    if (collections) {
      for (const collection of collections) {
        await collection.deleteMany({});
      }
    }

    // Delete all models to prevent recompilation errors
    Object.keys(mongoose.models).forEach(key => {
      delete mongoose.models[key];
    });

    // Clear storage
    if (provider) {
      provider.clear();
    }
  });

  describe('Upload Flow', () => {
    it('should upload a file successfully', async () => {
      provider = new MemoryStorageProvider();
      const media = createMedia({
        provider,
        folders: {
          baseFolders: ['general', 'images', 'documents'],
          defaultFolder: 'general',
        },
        suppressWarnings: true,
      });

      const Media = mongoose.model('MediaUploadTest', media.schema);
      media.init(Media);

      const buffer = Buffer.from('test file content');

      const uploaded = await media.upload({
        buffer,
        filename: 'test.txt',
        mimeType: 'text/plain',
        folder: 'general',
        title: 'Test File',
      });

      expect(uploaded).toBeDefined();
      expect(uploaded.filename).toBe('test.txt');
      expect(uploaded.mimeType).toBe('text/plain');
      expect(uploaded.folder).toBe('general');
      expect(uploaded.size).toBe(buffer.length);
      expect(uploaded.url).toContain('test.txt');

      // Verify in database
      const found = await Media.findById(uploaded._id);
      expect(found).toBeDefined();
      expect(found!.filename).toBe('test.txt');

      // Verify in storage
      const exists = await provider.exists(uploaded.key);
      expect(exists).toBe(true);
    });

    it('should upload multiple files', async () => {
      provider = new MemoryStorageProvider();
      const media = createMedia({
        provider,
        suppressWarnings: true,
      });

      const Media = mongoose.model('MediaBulkTest', media.schema);
      media.init(Media);

      const files = [
        { buffer: Buffer.from('file1'), filename: 'file1.txt', mimeType: 'text/plain' },
        { buffer: Buffer.from('file2'), filename: 'file2.txt', mimeType: 'text/plain' },
        { buffer: Buffer.from('file3'), filename: 'file3.txt', mimeType: 'text/plain' },
      ];

      const uploaded = await media.uploadMany(files.map(f => ({ ...f, folder: 'general' })));

      expect(uploaded).toHaveLength(3);
      expect(uploaded[0].filename).toBe('file1.txt');
      expect(uploaded[1].filename).toBe('file2.txt');
      expect(uploaded[2].filename).toBe('file3.txt');

      // Verify all in database
      const count = await Media.countDocuments();
      expect(count).toBe(3);
    });

    it('should generate alt text automatically', async () => {
      provider = new MemoryStorageProvider();
      const media = createMedia({
        provider,
        processing: {
          enabled: false,
          generateAlt: true,
        },
        suppressWarnings: true,
      });

      const Media = mongoose.model('MediaAltTest', media.schema);
      media.init(Media);

      const uploaded = await media.upload({
        buffer: Buffer.from('image'),
        filename: 'product-red-shoes.jpg',
        mimeType: 'image/jpeg',
        folder: 'images',
      });

      expect(uploaded.alt).toBe('Product red shoes');
    });
  });

  describe('Delete Flow', () => {
    it('should delete file from storage and database', async () => {
      provider = new MemoryStorageProvider();
      const media = createMedia({
        provider,
        suppressWarnings: true,
      });

      const Media = mongoose.model('MediaDeleteTest', media.schema);
      media.init(Media);

      // Upload first
      const uploaded = await media.upload({
        buffer: Buffer.from('test'),
        filename: 'delete-me.txt',
        mimeType: 'text/plain',
        folder: 'general',
      });

      const uploadedId = (uploaded as any)._id.toString();
      const uploadedKey = uploaded.key;

      // Verify uploaded
      expect(await provider.exists(uploadedKey)).toBe(true);
      expect(await Media.findById(uploadedId)).toBeDefined();

      // Delete
      const deleted = await media.delete(uploadedId);

      // Verify deleted
      expect(deleted).toBe(true);
      expect(await Media.findById(uploadedId)).toBeNull();
      expect(await provider.exists(uploadedKey)).toBe(false);
    });

    it('should delete multiple files', async () => {
      provider = new MemoryStorageProvider();
      const media = createMedia({
        provider,
        suppressWarnings: true,
      });

      const Media = mongoose.model('MediaBulkDeleteTest', media.schema);
      media.init(Media);

      // Upload files
      const files = await media.uploadMany([
        { buffer: Buffer.from('1'), filename: '1.txt', mimeType: 'text/plain', folder: 'general' },
        { buffer: Buffer.from('2'), filename: '2.txt', mimeType: 'text/plain', folder: 'general' },
        { buffer: Buffer.from('3'), filename: '3.txt', mimeType: 'text/plain', folder: 'general' },
      ]);

      const ids = files.map(f => (f as any)._id.toString());

      // Delete all
      const deleted = await media.deleteMany(ids);

      expect(deleted.success).toHaveLength(3);
      expect(deleted.failed).toHaveLength(0);
      expect(await Media.countDocuments()).toBe(0);
    });
  });

  describe('Event System', () => {
    it('should emit before:upload event', async () => {
      provider = new MemoryStorageProvider();
      const media = createMedia({
        provider,
        suppressWarnings: true,
      });

      const Media = mongoose.model('MediaEventBeforeTest', media.schema);
      media.init(Media);

      let eventFired = false;

      media.on('before:upload', () => {
        eventFired = true;
      });

      await media.upload({
        buffer: Buffer.from('test'),
        filename: 'event-test.txt',
        mimeType: 'text/plain',
        folder: 'general',
      });

      expect(eventFired).toBe(true);
    });

    it('should emit after:upload event', async () => {
      provider = new MemoryStorageProvider();
      const media = createMedia({
        provider,
        suppressWarnings: true,
      });

      const Media = mongoose.model('MediaEventAfterTest', media.schema);
      media.init(Media);

      let uploadedFile: any = null;

      media.on('after:upload', (event: any) => {
        uploadedFile = event.result;
      });

      const result = await media.upload({
        buffer: Buffer.from('test'),
        filename: 'event-test.txt',
        mimeType: 'text/plain',
        folder: 'general',
      });

      expect(uploadedFile).toBeDefined();
      expect(uploadedFile._id).toEqual(result._id);
    });

    it('should emit error:upload event on failure', async () => {
      provider = new MemoryStorageProvider();
      const media = createMedia({
        provider,
        folders: {
          baseFolders: ['images'],
          defaultFolder: 'images',
        },
        suppressWarnings: true,
      });

      const Media = mongoose.model('MediaEventErrorTest', media.schema);
      media.init(Media);

      let errorEvent: any = null;

      media.on('error:upload', (event: any) => {
        errorEvent = event;
      });

      try {
        await media.upload({
          buffer: Buffer.from('test'),
          filename: 'test.txt',
          mimeType: 'text/plain',
          folder: 'invalid-folder', // Invalid folder
        });
      } catch (err) {
        // Expected to fail
      }

      expect(errorEvent).toBeDefined();
      expect(errorEvent.error).toBeDefined();
    });
  });

  describe('Validation', () => {
    it('should validate file type', async () => {
      provider = new MemoryStorageProvider();
      const media = createMedia({
        provider,
        fileTypes: {
          allowed: ['image/*'],
        },
        suppressWarnings: true,
      });

      const Media = mongoose.model('MediaValidationTypeTest', media.schema);
      media.init(Media);

      await expect(
        media.upload({
          buffer: Buffer.from('test'),
          filename: 'test.txt',
          mimeType: 'text/plain',
          folder: 'general',
        })
      ).rejects.toThrow();
    });

    it('should validate folder', async () => {
      provider = new MemoryStorageProvider();
      const media = createMedia({
        provider,
        folders: {
          baseFolders: ['images', 'documents'],
          defaultFolder: 'images',
        },
        suppressWarnings: true,
      });

      const Media = mongoose.model('MediaValidationFolderTest', media.schema);
      media.init(Media);

      await expect(
        media.upload({
          buffer: Buffer.from('test'),
          filename: 'test.txt',
          mimeType: 'text/plain',
          folder: 'invalid',
        })
      ).rejects.toThrow(/Invalid base folder/);
    });
  });
});
