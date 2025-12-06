/**
 * Integration Tests - Full Upload/Delete Flow with Mongokit Features
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import mongoose from 'mongoose';
import { createMedia } from '../src/media';
import { MediaRepository } from '../src/repository/media.repository';
import type { StorageProvider, UploadResult, UploadOptions, IMediaDocument } from '../src/types';
import type { OffsetPaginationResult, KeysetPaginationResult } from '@classytic/mongokit';

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
    // Connect to test database (unique name to avoid conflicts)
    await mongoose.connect('mongodb://localhost:27017/mediakit-integration-test');
  });

  afterAll(async () => {
    // Disconnect
    await mongoose.disconnect();
  });

  beforeEach(async () => {
    // Clean up before each test for isolation
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

    // Create fresh provider
    provider = new MemoryStorageProvider();
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

  describe('Mongokit Integration', () => {
    it('should expose mongokit Repository with full features', async () => {
      provider = new MemoryStorageProvider();
      const media = createMedia({
        provider,
        suppressWarnings: true,
      });

      const Media = mongoose.model('MediaRepoTest', media.schema);
      media.init(Media);

      // Repository should be a MediaRepository (extends mongokit Repository)
      expect(media.repository).toBeInstanceOf(MediaRepository);
      expect(media.repository.Model).toBe(Media);
    });

    it('should support offset pagination via getAll', async () => {
      provider = new MemoryStorageProvider();
      const media = createMedia({
        provider,
        suppressWarnings: true,
      });

      const Media = mongoose.model('MediaOffsetTest', media.schema);
      media.init(Media);

      // Upload 15 files
      for (let i = 0; i < 15; i++) {
        await media.upload({
          buffer: Buffer.from(`file${i}`),
          filename: `file${i}.txt`,
          mimeType: 'text/plain',
          folder: 'general',
        });
      }

      // Get page 1 with offset pagination
      const page1 = await media.getAll({ page: 1, limit: 10 });

      expect(page1.method).toBe('offset');
      expect(page1.docs).toHaveLength(10);
      expect((page1 as OffsetPaginationResult<IMediaDocument>).page).toBe(1);
      expect((page1 as OffsetPaginationResult<IMediaDocument>).total).toBe(15);
      expect((page1 as OffsetPaginationResult<IMediaDocument>).pages).toBe(2);
      expect((page1 as OffsetPaginationResult<IMediaDocument>).hasNext).toBe(true);

      // Get page 2
      const page2 = await media.getAll({ page: 2, limit: 10 });
      expect(page2.docs).toHaveLength(5);
      expect((page2 as OffsetPaginationResult<IMediaDocument>).hasNext).toBe(false);
    });

    it('should support keyset (cursor) pagination via getAll', async () => {
      provider = new MemoryStorageProvider();
      const media = createMedia({
        provider,
        suppressWarnings: true,
      });

      const Media = mongoose.model('MediaKeysetTest', media.schema);
      media.init(Media);

      // Upload 15 files with slight delay to ensure different timestamps
      for (let i = 0; i < 15; i++) {
        await media.upload({
          buffer: Buffer.from(`file${i}`),
          filename: `file${i}.txt`,
          mimeType: 'text/plain',
          folder: 'general',
        });
      }

      // Get first batch with keyset pagination (no page param = keyset mode)
      const batch1 = await media.getAll({ 
        sort: { createdAt: -1 }, 
        limit: 10 
      });

      expect(batch1.method).toBe('keyset');
      expect(batch1.docs).toHaveLength(10);
      expect((batch1 as KeysetPaginationResult<IMediaDocument>).hasMore).toBe(true);
      expect((batch1 as KeysetPaginationResult<IMediaDocument>).next).toBeDefined();

      // Get next batch using cursor
      const batch2 = await media.getAll({ 
        after: (batch1 as KeysetPaginationResult<IMediaDocument>).next!,
        sort: { createdAt: -1 }, 
        limit: 10 
      });

      expect(batch2.docs).toHaveLength(5);
      expect((batch2 as KeysetPaginationResult<IMediaDocument>).hasMore).toBe(false);
    });

    it('should support filtering with pagination', async () => {
      provider = new MemoryStorageProvider();
      const media = createMedia({
        provider,
        folders: {
          baseFolders: ['images', 'documents'],
        },
        suppressWarnings: true,
      });

      const Media = mongoose.model('MediaFilterTest', media.schema);
      media.init(Media);

      // Upload files to different folders
      await media.upload({
        buffer: Buffer.from('img1'),
        filename: 'img1.jpg',
        mimeType: 'image/jpeg',
        folder: 'images',
      });
      await media.upload({
        buffer: Buffer.from('img2'),
        filename: 'img2.jpg',
        mimeType: 'image/jpeg',
        folder: 'images',
      });
      await media.upload({
        buffer: Buffer.from('doc1'),
        filename: 'doc1.pdf',
        mimeType: 'application/pdf',
        folder: 'documents',
      });

      // Filter by folder
      const imagesOnly = await media.getAll({
        filters: { folder: 'images' },
        page: 1,
        limit: 10,
      });

      expect(imagesOnly.docs).toHaveLength(2);
      expect(imagesOnly.docs.every(d => d.folder === 'images')).toBe(true);
    });

    it('should provide repository analytics methods', async () => {
      provider = new MemoryStorageProvider();
      const media = createMedia({
        provider,
        folders: {
          baseFolders: ['images', 'documents'],
        },
        suppressWarnings: true,
      });

      const Media = mongoose.model('MediaAnalyticsTest', media.schema);
      media.init(Media);

      // Upload files
      await media.upload({
        buffer: Buffer.alloc(1000),
        filename: 'img1.jpg',
        mimeType: 'image/jpeg',
        folder: 'images',
      });
      await media.upload({
        buffer: Buffer.alloc(2000),
        filename: 'img2.jpg',
        mimeType: 'image/jpeg',
        folder: 'images',
      });
      await media.upload({
        buffer: Buffer.alloc(500),
        filename: 'doc1.pdf',
        mimeType: 'application/pdf',
        folder: 'documents',
      });

      // Get total storage used
      const totalStorage = await media.repository.getTotalStorageUsed();
      expect(totalStorage).toBe(3500);

      // Get storage by folder
      const storageByFolder = await media.repository.getStorageByFolder();
      expect(storageByFolder).toHaveLength(2);
      
      const imagesFolder = storageByFolder.find(f => f.folder === 'images');
      expect(imagesFolder?.size).toBe(3000);
      expect(imagesFolder?.count).toBe(2);

      const docsFolder = storageByFolder.find(f => f.folder === 'documents');
      expect(docsFolder?.size).toBe(500);
      expect(docsFolder?.count).toBe(1);
    });

    it('should support getById method', async () => {
      provider = new MemoryStorageProvider();
      const media = createMedia({
        provider,
        suppressWarnings: true,
      });

      const Media = mongoose.model('MediaGetByIdTest', media.schema);
      media.init(Media);

      const uploaded = await media.upload({
        buffer: Buffer.from('test'),
        filename: 'test.txt',
        mimeType: 'text/plain',
        folder: 'general',
      });

      const found = await media.getById((uploaded as any)._id.toString());
      expect(found).toBeDefined();
      expect(found!.filename).toBe('test.txt');

      // Non-existent ID should return null
      const notFound = await media.getById('507f1f77bcf86cd799439011');
      expect(notFound).toBeNull();
    });

    it('should support repository direct access for advanced queries', async () => {
      provider = new MemoryStorageProvider();
      const media = createMedia({
        provider,
        folders: {
          baseFolders: ['images', 'documents'],
        },
        suppressWarnings: true,
      });

      const Media = mongoose.model('MediaAdvancedTest', media.schema);
      media.init(Media);

      // Upload files
      await media.upload({
        buffer: Buffer.from('img'),
        filename: 'photo.jpg',
        mimeType: 'image/jpeg',
        folder: 'images/vacation',
      });
      await media.upload({
        buffer: Buffer.from('doc'),
        filename: 'report.pdf',
        mimeType: 'application/pdf',
        folder: 'documents/work',
      });

      // Use repository getByMimeType
      const images = await media.repository.getByMimeType('image/*');
      expect(images.docs).toHaveLength(1);
      expect(images.docs[0].mimeType).toBe('image/jpeg');

      // Use repository getRecentUploads
      const recent = await media.repository.getRecentUploads(5);
      expect(recent).toHaveLength(2);

      // Use repository countInFolder
      const imageCount = await media.repository.countInFolder('images');
      expect(imageCount).toBe(1);
    });

    it('should support folder tree operations', async () => {
      provider = new MemoryStorageProvider();
      const media = createMedia({
        provider,
        folders: {
          baseFolders: ['images', 'documents'],
        },
        suppressWarnings: true,
      });

      const Media = mongoose.model('MediaFolderTreeTest', media.schema);
      media.init(Media);

      // Upload files to nested folders
      await media.upload({
        buffer: Buffer.from('img1'),
        filename: 'photo1.jpg',
        mimeType: 'image/jpeg',
        folder: 'images/vacation/2024',
      });
      await media.upload({
        buffer: Buffer.from('img2'),
        filename: 'photo2.jpg',
        mimeType: 'image/jpeg',
        folder: 'images/vacation/2024',
      });
      await media.upload({
        buffer: Buffer.from('doc'),
        filename: 'report.pdf',
        mimeType: 'application/pdf',
        folder: 'documents',
      });

      // Get folder tree
      const tree = await media.getFolderTree();
      expect(tree.folders.length).toBeGreaterThan(0);
      expect(tree.meta.totalFiles).toBe(3);

      // Get folder stats
      const stats = await media.getFolderStats('images');
      expect(stats.totalFiles).toBe(2);

      // Get breadcrumb
      const breadcrumb = media.getBreadcrumb('images/vacation/2024');
      expect(breadcrumb).toHaveLength(3);
      expect(breadcrumb[0].name).toBe('images');
      expect(breadcrumb[1].name).toBe('vacation');
      expect(breadcrumb[2].name).toBe('2024');
    });
  });
});
