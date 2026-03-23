/**
 * Integration Tests
 *
 * Full upload/delete flow with MongoDB, storage driver abstraction,
 * status lifecycle, hash, originalFilename, title, tags, deletedAt,
 * awaitable events, presigned uploads, folder tree, and mongokit integration.
 *
 * Requires: MongoDB running on localhost:27017
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { createMedia } from '../src/media';
import { MediaRepository } from '../src/repository/media.repository';
import { MemoryStorageDriver } from './helpers/memory-driver';
import type { IMediaDocument } from '../src/types';
import type { OffsetPaginationResult, KeysetPaginationResult } from '@classytic/mongokit';

describe('Media Kit Integration Tests', () => {
  let driver: MemoryStorageDriver;

  beforeAll(async () => {
    await mongoose.connect('mongodb://localhost:27017/mediakit-integration-test');
  });

  afterAll(async () => {
    await mongoose.disconnect();
  });

  beforeEach(async () => {
    // Clean up collections for isolation
    const collections = await mongoose.connection.db?.collections();
    if (collections) {
      for (const collection of collections) {
        await collection.deleteMany({});
      }
    }

    // Delete all registered models to prevent recompilation errors
    Object.keys(mongoose.models).forEach(key => {
      delete mongoose.models[key];
    });

    // Create fresh driver
    driver = new MemoryStorageDriver();
  });

  // ============================================
  // 1. UPLOAD FLOW
  // ============================================

  describe('Upload Flow', () => {
    it('should upload a single file with correct fields', async () => {
      const media = createMedia({
        driver,
        processing: { enabled: false },
        suppressWarnings: true,
      });

      const Media = mongoose.model('Test', media.schema);
      media.init(Media);

      const buffer = Buffer.from('test file content');

      const uploaded = await media.upload({
        buffer,
        filename: 'test-document.txt',
        mimeType: 'text/plain',
        folder: 'general',
      });

      // filename is the storage key filename (sanitized), not the original
      expect(uploaded.filename).toBeDefined();
      expect(uploaded.mimeType).toBe('text/plain');
      expect(uploaded.folder).toBe('general');
      expect(uploaded.size).toBe(buffer.length);
      expect(uploaded.url).toContain('cdn.example.com');

      // status lifecycle
      expect(uploaded.status).toBe('ready');

      // hash is auto-computed
      expect(uploaded.hash).toBeDefined();
      expect(typeof uploaded.hash).toBe('string');
      expect(uploaded.hash.length).toBeGreaterThan(0);

      // originalFilename preserves the input
      expect(uploaded.originalFilename).toBe('test-document.txt');

      // title is auto-generated from filename
      expect(uploaded.title).toBe('test document');

      // tags default to empty array
      expect(uploaded.tags).toEqual([]);

      // deletedAt starts as null
      expect(uploaded.deletedAt).toBeNull();

      // Verify in database
      const found = await Media.findById(uploaded._id);
      expect(found).toBeDefined();
      expect(found!.status).toBe('ready');

      // Verify in storage
      const exists = await driver.exists(uploaded.key);
      expect(exists).toBe(true);
    });

    it('should upload multiple files with uploadMany', async () => {
      const media = createMedia({
        driver,
        processing: { enabled: false },
        suppressWarnings: true,
      });

      const Media = mongoose.model('Test', media.schema);
      media.init(Media);

      const files = [
        { buffer: Buffer.from('file1'), filename: 'file1.txt', mimeType: 'text/plain' },
        { buffer: Buffer.from('file2'), filename: 'file2.txt', mimeType: 'text/plain' },
        { buffer: Buffer.from('file3'), filename: 'file3.txt', mimeType: 'text/plain' },
      ];

      const uploaded = await media.uploadMany(
        files.map(f => ({ ...f, folder: 'general' }))
      );

      expect(uploaded).toHaveLength(3);

      for (const doc of uploaded) {
        expect(doc.status).toBe('ready');
        expect(doc.hash).toBeDefined();
        expect(doc.hash.length).toBeGreaterThan(0);
        expect(doc.originalFilename).toBeDefined();
        expect(doc.tags).toEqual([]);
        expect(doc.deletedAt).toBeNull();
      }

      // Verify all in database
      const count = await Media.countDocuments();
      expect(count).toBe(3);
    });

    it('should auto-generate alt text for images when configured', async () => {
      const media = createMedia({
        driver,
        processing: {
          enabled: false,
          generateAlt: true,
        },
        suppressWarnings: true,
      });

      const Media = mongoose.model('Test', media.schema);
      media.init(Media);

      const uploaded = await media.upload({
        buffer: Buffer.from('fake image data'),
        filename: 'product-red-shoes.jpg',
        mimeType: 'image/jpeg',
        folder: 'images',
      });

      expect(uploaded.alt).toBe('Product red shoes');
      expect(uploaded.status).toBe('ready');
    });
  });

  // ============================================
  // 2. DELETE FLOW
  // ============================================

  describe('Delete Flow', () => {
    it('should delete from storage and database', async () => {
      const media = createMedia({
        driver,
        processing: { enabled: false },
        suppressWarnings: true,
      });

      const Media = mongoose.model('Test', media.schema);
      media.init(Media);

      const uploaded = await media.upload({
        buffer: Buffer.from('delete me'),
        filename: 'delete-me.txt',
        mimeType: 'text/plain',
        folder: 'general',
      });

      const uploadedId = (uploaded as any)._id.toString();
      const uploadedKey = uploaded.key;

      // Verify uploaded
      expect(await driver.exists(uploadedKey)).toBe(true);
      expect(await Media.findById(uploadedId)).toBeDefined();

      // Delete
      const deleted = await media.delete(uploadedId);

      // Verify deleted
      expect(deleted).toBe(true);
      expect(await Media.findById(uploadedId)).toBeNull();
      expect(await driver.exists(uploadedKey)).toBe(false);
    });

    it('should delete multiple files with deleteMany', async () => {
      const media = createMedia({
        driver,
        processing: { enabled: false },
        suppressWarnings: true,
      });

      const Media = mongoose.model('Test', media.schema);
      media.init(Media);

      const files = await media.uploadMany([
        { buffer: Buffer.from('1'), filename: '1.txt', mimeType: 'text/plain', folder: 'general' },
        { buffer: Buffer.from('2'), filename: '2.txt', mimeType: 'text/plain', folder: 'general' },
        { buffer: Buffer.from('3'), filename: '3.txt', mimeType: 'text/plain', folder: 'general' },
      ]);

      const ids = files.map(f => (f as any)._id.toString());

      const result = await media.deleteMany(ids);

      expect(result.success).toHaveLength(3);
      expect(result.failed).toHaveLength(0);
      expect(await Media.countDocuments()).toBe(0);
    });
  });

  // ============================================
  // 3. EVENT SYSTEM
  // ============================================

  describe('Event System', () => {
    it('should fire before:upload event', async () => {
      const media = createMedia({
        driver,
        processing: { enabled: false },
        suppressWarnings: true,
      });

      const Media = mongoose.model('Test', media.schema);
      media.init(Media);

      let eventFired = false;

      const unsub = media.on('before:upload', () => {
        eventFired = true;
      });

      await media.upload({
        buffer: Buffer.from('test'),
        filename: 'event-test.txt',
        mimeType: 'text/plain',
        folder: 'general',
      });

      expect(eventFired).toBe(true);

      // Verify unsubscribe function is returned
      expect(typeof unsub).toBe('function');
      unsub();
    });

    it('should fire after:upload event with result (awaitable)', async () => {
      const media = createMedia({
        driver,
        processing: { enabled: false },
        suppressWarnings: true,
      });

      const Media = mongoose.model('Test', media.schema);
      media.init(Media);

      let uploadedFile: IMediaDocument | null = null;

      const unsub = media.on('after:upload', async (event: any) => {
        // Simulate async work to verify awaitable behavior
        await new Promise(resolve => setTimeout(resolve, 10));
        uploadedFile = event.result;
      });

      const result = await media.upload({
        buffer: Buffer.from('test'),
        filename: 'event-test.txt',
        mimeType: 'text/plain',
        folder: 'general',
      });

      // After upload should have awaited the async listener
      expect(uploadedFile).toBeDefined();
      expect((uploadedFile as any)._id.toString()).toBe((result as any)._id.toString());

      unsub();
    });

    it('should fire error:upload event on validation failure', async () => {
      const media = createMedia({
        driver,
        fileTypes: { allowed: ['image/*'] },
        processing: { enabled: false },
        suppressWarnings: true,
      });

      const Media = mongoose.model('Test', media.schema);
      media.init(Media);

      let errorEvent: any = null;

      media.on('error:upload', (event: any) => {
        errorEvent = event;
      });

      try {
        await media.upload({
          buffer: Buffer.from('test'),
          filename: 'test.txt',
          mimeType: 'text/plain', // Not allowed — only image/* allowed
          folder: 'general',
        });
      } catch {
        // Expected to fail
      }

      expect(errorEvent).toBeDefined();
      expect(errorEvent.error).toBeInstanceOf(Error);
    });
  });

  // ============================================
  // 4. VALIDATION
  // ============================================

  describe('Validation', () => {
    it('should validate file type against allowed list', async () => {
      const media = createMedia({
        driver,
        fileTypes: { allowed: ['image/*'] },
        processing: { enabled: false },
        suppressWarnings: true,
      });

      const Media = mongoose.model('Test', media.schema);
      media.init(Media);

      await expect(
        media.upload({
          buffer: Buffer.from('not an image'),
          filename: 'test.txt',
          mimeType: 'text/plain',
          folder: 'general',
        })
      ).rejects.toThrow(/not allowed/);
    });

    it('should allow any folder (no baseFolders validation)', async () => {
      const media = createMedia({
        driver,
        processing: { enabled: false },
        suppressWarnings: true,
      });

      const Media = mongoose.model('Test', media.schema);
      media.init(Media);

      // Folders are free-form — any folder name is valid
      const uploaded = await media.upload({
        buffer: Buffer.from('data'),
        filename: 'file.txt',
        mimeType: 'text/plain',
        folder: 'any/arbitrary/nested/folder',
      });

      expect(uploaded.folder).toBe('any/arbitrary/nested/folder');
      expect(uploaded.status).toBe('ready');
    });
  });

  // ============================================
  // 5. MONGOKIT INTEGRATION
  // ============================================

  describe('Mongokit Integration', () => {
    it('should expose repository as MediaRepository instance', async () => {
      const media = createMedia({
        driver,
        processing: { enabled: false },
        suppressWarnings: true,
      });

      const Media = mongoose.model('Test', media.schema);
      media.init(Media);

      expect(media.repository).toBeInstanceOf(MediaRepository);
      expect(media.repository.Model).toBe(Media);
    });

    it('should support offset pagination with getAll({ page, limit })', async () => {
      const media = createMedia({
        driver,
        processing: { enabled: false },
        suppressWarnings: true,
      });

      const Media = mongoose.model('Test', media.schema);
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

      // Page 1
      const page1 = await media.getAll({ page: 1, limit: 10 });

      expect(page1.method).toBe('offset');
      expect(page1.docs).toHaveLength(10);
      expect((page1 as OffsetPaginationResult<IMediaDocument>).page).toBe(1);
      expect((page1 as OffsetPaginationResult<IMediaDocument>).total).toBe(15);
      expect((page1 as OffsetPaginationResult<IMediaDocument>).pages).toBe(2);
      expect((page1 as OffsetPaginationResult<IMediaDocument>).hasNext).toBe(true);

      // Page 2
      const page2 = await media.getAll({ page: 2, limit: 10 });
      expect(page2.docs).toHaveLength(5);
      expect((page2 as OffsetPaginationResult<IMediaDocument>).hasNext).toBe(false);
    });

    it('should support keyset pagination with getAll({ sort, limit })', async () => {
      const media = createMedia({
        driver,
        processing: { enabled: false },
        suppressWarnings: true,
      });

      const Media = mongoose.model('Test', media.schema);
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

      // First batch — keyset mode (no page param)
      const batch1 = await media.getAll({
        sort: { createdAt: -1 },
        limit: 10,
      });

      expect(batch1.method).toBe('keyset');
      expect(batch1.docs).toHaveLength(10);
      expect((batch1 as KeysetPaginationResult<IMediaDocument>).hasMore).toBe(true);
      expect((batch1 as KeysetPaginationResult<IMediaDocument>).next).toBeDefined();

      // Next batch via cursor
      const batch2 = await media.getAll({
        after: (batch1 as KeysetPaginationResult<IMediaDocument>).next!,
        sort: { createdAt: -1 },
        limit: 10,
      });

      expect(batch2.docs).toHaveLength(5);
      expect((batch2 as KeysetPaginationResult<IMediaDocument>).hasMore).toBe(false);
    });

    it('should support filtering with getAll({ filters: { folder } })', async () => {
      const media = createMedia({
        driver,
        processing: { enabled: false },
        suppressWarnings: true,
      });

      const Media = mongoose.model('Test', media.schema);
      media.init(Media);

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

      const imagesOnly = await media.getAll({
        filters: { folder: 'images' },
        page: 1,
        limit: 10,
      });

      expect(imagesOnly.docs).toHaveLength(2);
      expect(imagesOnly.docs.every(d => d.folder === 'images')).toBe(true);
    });

    it('should provide analytics: getTotalStorageUsed and getStorageByFolder', async () => {
      const media = createMedia({
        driver,
        processing: { enabled: false },
        suppressWarnings: true,
      });

      const Media = mongoose.model('Test', media.schema);
      media.init(Media);

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

      // Total storage
      const totalStorage = await media.repository.getTotalStorageUsed();
      expect(totalStorage).toBe(3500);

      // Storage by folder
      const storageByFolder = await media.repository.getStorageByFolder();
      expect(storageByFolder).toHaveLength(2);

      const imagesFolder = storageByFolder.find(f => f.folder === 'images');
      expect(imagesFolder?.size).toBe(3000);
      expect(imagesFolder?.count).toBe(2);

      const docsFolder = storageByFolder.find(f => f.folder === 'documents');
      expect(docsFolder?.size).toBe(500);
      expect(docsFolder?.count).toBe(1);
    });

    it('should support getById', async () => {
      const media = createMedia({
        driver,
        processing: { enabled: false },
        suppressWarnings: true,
      });

      const Media = mongoose.model('Test', media.schema);
      media.init(Media);

      const uploaded = await media.upload({
        buffer: Buffer.from('test'),
        filename: 'test.txt',
        mimeType: 'text/plain',
        folder: 'general',
      });

      const found = await media.getById((uploaded as any)._id.toString());
      expect(found).toBeDefined();
      expect(found!.originalFilename).toBe('test.txt');
      expect(found!.status).toBe('ready');

      // Non-existent ID should return null
      const notFound = await media.getById('507f1f77bcf86cd799439011');
      expect(notFound).toBeNull();
    });

    it('should support advanced repository queries: getByMimeType, getRecentUploads, countInFolder', async () => {
      const media = createMedia({
        driver,
        processing: { enabled: false },
        suppressWarnings: true,
      });

      const Media = mongoose.model('Test', media.schema);
      media.init(Media);

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

      // getByMimeType
      const images = await media.repository.getByMimeType('image/*');
      expect(images.docs).toHaveLength(1);
      expect(images.docs[0].mimeType).toBe('image/jpeg');

      // getRecentUploads
      const recent = await media.repository.getRecentUploads(5);
      expect(recent).toHaveLength(2);

      // countInFolder (includes subfolders by default)
      const imageCount = await media.repository.countInFolder('images');
      expect(imageCount).toBe(1);
    });
  });

  // ============================================
  // 6. FOLDER TREE
  // ============================================

  describe('Folder Tree', () => {
    it('should build a folder tree from uploaded files', async () => {
      const media = createMedia({
        driver,
        processing: { enabled: false },
        suppressWarnings: true,
      });

      const Media = mongoose.model('Test', media.schema);
      media.init(Media);

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

      // getFolderTree
      const tree = await media.getFolderTree();
      expect(tree.folders.length).toBeGreaterThan(0);
      expect(tree.meta.totalFiles).toBe(3);
    });

    it('should return folder stats', async () => {
      const media = createMedia({
        driver,
        processing: { enabled: false },
        suppressWarnings: true,
      });

      const Media = mongoose.model('Test', media.schema);
      media.init(Media);

      await media.upload({
        buffer: Buffer.alloc(100),
        filename: 'a.jpg',
        mimeType: 'image/jpeg',
        folder: 'images/vacation',
      });
      await media.upload({
        buffer: Buffer.alloc(200),
        filename: 'b.jpg',
        mimeType: 'image/jpeg',
        folder: 'images/vacation',
      });

      const stats = await media.getFolderStats('images');
      expect(stats.totalFiles).toBe(2);
      expect(stats.totalSize).toBe(300);
      expect(stats.mimeTypes).toContain('image/jpeg');
    });

    it('should return breadcrumb for a nested folder path', async () => {
      const media = createMedia({
        driver,
        processing: { enabled: false },
        suppressWarnings: true,
      });

      const Media = mongoose.model('Test', media.schema);
      media.init(Media);

      const breadcrumb = media.getBreadcrumb('images/vacation/2024');
      expect(breadcrumb).toHaveLength(3);
      expect(breadcrumb[0].name).toBe('images');
      expect(breadcrumb[1].name).toBe('vacation');
      expect(breadcrumb[2].name).toBe('2024');
    });

    it('should return subfolders with stats', async () => {
      const media = createMedia({
        driver,
        processing: { enabled: false },
        suppressWarnings: true,
      });

      const Media = mongoose.model('Test', media.schema);
      media.init(Media);

      await media.upload({ buffer: Buffer.from('a'), filename: 'a.jpg', mimeType: 'image/jpeg', folder: 'images/vacation' });
      await media.upload({ buffer: Buffer.from('b'), filename: 'b.jpg', mimeType: 'image/jpeg', folder: 'images/vacation/2024' });
      await media.upload({ buffer: Buffer.from('c'), filename: 'c.jpg', mimeType: 'image/jpeg', folder: 'images/profile' });

      const subfolders = await media.getSubfolders('images');
      expect(subfolders).toHaveLength(2);

      const names = subfolders.map(s => s.name);
      expect(names).toContain('vacation');
      expect(names).toContain('profile');

      // vacation aggregates its own files + vacation/2024
      const vacation = subfolders.find(s => s.name === 'vacation');
      expect(vacation!.stats.count).toBe(2);
    });
  });

  // ============================================
  // 7. PRESIGNED UPLOAD FLOW
  // ============================================

  describe('Presigned Upload Flow', () => {
    it('should generate presigned URL, simulate browser upload, and confirm', async () => {
      // MemoryStorageDriver already has getSignedUploadUrl
      const presignedDriver = new MemoryStorageDriver();
      const media = createMedia({
        driver: presignedDriver,
        processing: { enabled: false },
        suppressWarnings: true,
      });

      const Media = mongoose.model('Test', media.schema);
      media.init(Media);

      // Step 1: Generate presigned URL
      const presigned = await media.getSignedUploadUrl('photo.jpg', 'image/jpeg', {
        folder: 'images',
      });

      expect(presigned.uploadUrl).toContain('_upload');
      expect(presigned.key).toContain('images/');
      expect(presigned.publicUrl).toContain(presigned.key);
      expect(presigned.expiresIn).toBeGreaterThan(0);

      // Step 2: Simulate browser upload using simulateExternalUpload
      const fileBuffer = Buffer.from('fake image data from browser');
      presignedDriver.simulateExternalUpload(
        presigned.key,
        fileBuffer,
        'image/jpeg'
      );

      // Step 3: Confirm upload
      const confirmed = await media.confirmUpload({
        key: presigned.key,
        filename: 'photo.jpg',
        mimeType: 'image/jpeg',
        size: fileBuffer.length,
        folder: 'images',
      });

      expect(confirmed).toBeDefined();
      expect(confirmed.key).toBe(presigned.key);
      expect(confirmed.folder).toBe('images');
      expect(confirmed.mimeType).toBe('image/jpeg');
      expect(confirmed.status).toBe('ready');
      expect(confirmed.hash).toBeDefined();
      expect(confirmed.hash.length).toBeGreaterThan(0);
      expect(confirmed.originalFilename).toBe('photo.jpg');
      expect(confirmed.title).toBe('photo');
      expect(confirmed.tags).toEqual([]);
      expect(confirmed.deletedAt).toBeNull();

      // Verify in DB
      const found = await Media.findById(confirmed._id);
      expect(found).toBeDefined();
      expect(found!.status).toBe('ready');
    });

    it('should throw when confirming upload for nonexistent file', async () => {
      const presignedDriver = new MemoryStorageDriver();
      const media = createMedia({
        driver: presignedDriver,
        processing: { enabled: false },
        suppressWarnings: true,
      });

      const Media = mongoose.model('Test', media.schema);
      media.init(Media);

      await expect(
        media.confirmUpload({
          key: 'uploads/nonexistent.jpg',
          filename: 'nonexistent.jpg',
          mimeType: 'image/jpeg',
          size: 100,
        })
      ).rejects.toThrow('File not found in storage');
    });

    it('should throw when driver does not support presigned uploads', async () => {
      // Import MinimalStorageDriver which has no getSignedUploadUrl
      const { MinimalStorageDriver } = await import('./helpers/memory-driver');
      const minimalDriver = new MinimalStorageDriver();

      const media = createMedia({
        driver: minimalDriver,
        processing: { enabled: false },
        suppressWarnings: true,
      });

      const Media = mongoose.model('Test', media.schema);
      media.init(Media);

      await expect(
        media.getSignedUploadUrl('file.jpg', 'image/jpeg')
      ).rejects.toThrow('does not support presigned uploads');
    });
  });

  // ============================================
  // 8. UPLOAD MANY WITH PARTIAL FAILURES
  // ============================================

  describe('uploadMany with partial failures', () => {
    /**
     * FailingDriver extends MemoryStorageDriver and throws on
     * filenames containing 'FAIL' in write().
     */
    class FailingDriver extends MemoryStorageDriver {
      async write(
        key: string,
        data: Buffer | NodeJS.ReadableStream,
        contentType: string
      ) {
        // The key contains the sanitized filename; check for FAIL pattern
        if (key.includes('FAIL')) {
          throw new Error(`Simulated write failure for key: ${key}`);
        }
        return super.write(key, data, contentType);
      }
    }

    it('should return successful uploads and skip failures', async () => {
      const failDriver = new FailingDriver();
      const media = createMedia({
        driver: failDriver,
        processing: { enabled: false },
        suppressWarnings: true,
      });

      const Media = mongoose.model('Test', media.schema);
      media.init(Media);

      const results = await media.uploadMany([
        { buffer: Buffer.from('ok1'), filename: 'good1.txt', mimeType: 'text/plain', folder: 'general' },
        { buffer: Buffer.from('fail'), filename: 'FAIL.txt', mimeType: 'text/plain', folder: 'general' },
        { buffer: Buffer.from('ok2'), filename: 'good2.txt', mimeType: 'text/plain', folder: 'general' },
      ]);

      // Only 2 of 3 should succeed (FAIL.txt triggers write error)
      expect(results).toHaveLength(2);
      expect(results.every(r => r.status === 'ready')).toBe(true);

      // The failed one should have a DB record in error status
      const errorDocs = await Media.find({ status: 'error' });
      expect(errorDocs.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ============================================
  // 9. RENAME FOLDER
  // ============================================

  describe('renameFolder', () => {
    it('should rename folder and all subfolders, then verify tree', async () => {
      const media = createMedia({
        driver,
        processing: { enabled: false },
        suppressWarnings: true,
      });

      const Media = mongoose.model('Test', media.schema);
      media.init(Media);

      // Upload files to nested structure
      await media.upload({
        buffer: Buffer.from('img1'),
        filename: 'photo1.jpg',
        mimeType: 'image/jpeg',
        folder: 'images/vacation',
      });
      await media.upload({
        buffer: Buffer.from('img2'),
        filename: 'photo2.jpg',
        mimeType: 'image/jpeg',
        folder: 'images/vacation/2024',
      });
      await media.upload({
        buffer: Buffer.from('img3'),
        filename: 'photo3.jpg',
        mimeType: 'image/jpeg',
        folder: 'images/profile',
      });

      // Rename images/vacation -> images/trips
      const result = await media.renameFolder('images/vacation', 'images/trips');
      expect(result.modifiedCount).toBe(2); // vacation + vacation/2024

      // Verify tree
      const tree = await media.getFolderTree();
      const imagesNode = tree.folders.find(f => f.name === 'images');
      expect(imagesNode).toBeDefined();

      const childNames = imagesNode!.children.map(c => c.name);
      expect(childNames).toContain('trips');
      expect(childNames).toContain('profile');
      expect(childNames).not.toContain('vacation');

      // Verify the subfolder was also renamed
      const tripsNode = imagesNode!.children.find(c => c.name === 'trips');
      expect(tripsNode).toBeDefined();
      // trips should have a child "2024"
      const tripsChildNames = tripsNode!.children.map(c => c.name);
      expect(tripsChildNames).toContain('2024');
    });
  });

  // ============================================
  // 10. GET SUBFOLDERS
  // ============================================

  describe('getSubfolders', () => {
    it('should return immediate subfolders with aggregated stats', async () => {
      const media = createMedia({
        driver,
        processing: { enabled: false },
        suppressWarnings: true,
      });

      const Media = mongoose.model('Test', media.schema);
      media.init(Media);

      await media.upload({ buffer: Buffer.from('a'), filename: 'a.jpg', mimeType: 'image/jpeg', folder: 'images/vacation' });
      await media.upload({ buffer: Buffer.from('b'), filename: 'b.jpg', mimeType: 'image/jpeg', folder: 'images/vacation/2024' });
      await media.upload({ buffer: Buffer.from('c'), filename: 'c.jpg', mimeType: 'image/jpeg', folder: 'images/profile' });
      await media.upload({ buffer: Buffer.from('d'), filename: 'd.jpg', mimeType: 'image/jpeg', folder: 'images/profile/avatars' });

      const subfolders = await media.getSubfolders('images');
      expect(subfolders).toHaveLength(2);

      const names = subfolders.map(s => s.name);
      expect(names).toContain('vacation');
      expect(names).toContain('profile');

      // vacation aggregates vacation + vacation/2024
      const vacation = subfolders.find(s => s.name === 'vacation');
      expect(vacation!.stats.count).toBe(2);

      // profile aggregates profile + profile/avatars
      const profile = subfolders.find(s => s.name === 'profile');
      expect(profile!.stats.count).toBe(2);
    });
  });
});
