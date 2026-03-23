/**
 * Real-World Scenario Tests
 *
 * Tests for common production use cases:
 * - E-commerce: product images with variants
 * - Blog: post images with alt text
 * - Multi-tenant SaaS: organization isolation
 * - File management: folders, search, cleanup
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { createMedia } from '../src/media';
import { MemoryStorageDriver } from './helpers/memory-driver';
import type { StorageDriver, WriteResult, FileStat } from '../src/types';
import { Readable } from 'stream';

describe('Real-World Scenarios', () => {
  let driver: MemoryStorageDriver;

  beforeAll(async () => {
    await mongoose.connect('mongodb://localhost:27017/mediakit-realworld-test');
  });

  afterAll(async () => {
    await mongoose.disconnect();
  });

  beforeEach(async () => {
    const collections = await mongoose.connection.db?.collections();
    if (collections) {
      for (const collection of collections) {
        await collection.deleteMany({});
      }
    }
    Object.keys(mongoose.models).forEach(key => delete mongoose.models[key]);
    driver = new MemoryStorageDriver();
  });

  describe('E-commerce: Product Images', () => {
    it('should handle product catalog with multiple images per product', async () => {
      const media = createMedia({
        driver,
        processing: { enabled: false },
        suppressWarnings: true,
      });

      const Media = mongoose.model('Test', media.schema);
      media.init(Media);

      const productId = 'prod_123';

      await media.upload({
        buffer: Buffer.from('main'),
        filename: 'main.jpg',
        mimeType: 'image/jpeg',
        folder: `products/${productId}`,
      });
      await media.upload({
        buffer: Buffer.from('angle1'),
        filename: 'angle1.jpg',
        mimeType: 'image/jpeg',
        folder: `products/${productId}`,
      });
      await media.upload({
        buffer: Buffer.from('angle2'),
        filename: 'angle2.jpg',
        mimeType: 'image/jpeg',
        folder: `products/${productId}`,
      });

      const productImages = await media.getAll({
        filters: { folder: `products/${productId}` },
      });

      expect(productImages.docs).toHaveLength(3);
    });
  });

  describe('Blog: Post Images with SEO', () => {
    it('should auto-generate SEO-friendly alt text', async () => {
      const media = createMedia({
        driver,
        processing: { enabled: false, generateAlt: true },
        suppressWarnings: true,
      });

      const Media = mongoose.model('Test', media.schema);
      media.init(Media);

      const uploaded = await media.upload({
        buffer: Buffer.from('image'),
        filename: 'how-to-build-nextjs-app-2024.jpg',
        mimeType: 'image/jpeg',
        folder: 'images',
      });

      expect(uploaded.alt).toBe('How to build nextjs app 2024');
    });

    it('should support custom alt text override', async () => {
      const media = createMedia({
        driver,
        processing: { enabled: false, generateAlt: true },
        suppressWarnings: true,
      });

      const Media = mongoose.model('Test', media.schema);
      media.init(Media);

      const uploaded = await media.upload({
        buffer: Buffer.from('image'),
        filename: 'img123.jpg',
        mimeType: 'image/jpeg',
        folder: 'images',
        alt: 'Custom SEO description',
      });

      expect(uploaded.alt).toBe('Custom SEO description');
    });
  });

  describe('Multi-tenant SaaS: Organization Isolation', () => {
    it('should isolate files between organizations', async () => {
      const media = createMedia({
        driver,
        multiTenancy: { enabled: true, field: 'organizationId', required: false },
        processing: { enabled: false },
        suppressWarnings: true,
      });

      const Media = mongoose.model('Test', media.schema);
      media.init(Media);

      const org1Id = new mongoose.Types.ObjectId();
      const org2Id = new mongoose.Types.ObjectId();

      await media.upload(
        { buffer: Buffer.from('org1'), filename: 'file.txt', mimeType: 'text/plain', folder: 'general' },
        { organizationId: org1Id }
      );

      await media.upload(
        { buffer: Buffer.from('org2'), filename: 'file.txt', mimeType: 'text/plain', folder: 'general' },
        { organizationId: org2Id }
      );

      const org1Files = await media.getAll({}, { organizationId: org1Id });
      expect(org1Files.docs).toHaveLength(1);

      const org2Files = await media.getAll({}, { organizationId: org2Id });
      expect(org2Files.docs).toHaveLength(1);
    });

    it('should require organizationId when required=true', async () => {
      const media = createMedia({
        driver,
        multiTenancy: { enabled: true, field: 'organizationId', required: true },
        processing: { enabled: false },
        suppressWarnings: true,
      });

      const Media = mongoose.model('Test', media.schema);
      media.init(Media);

      await expect(
        media.upload({
          buffer: Buffer.from('test'),
          filename: 'test.txt',
          mimeType: 'text/plain',
          folder: 'general',
        })
      ).rejects.toThrow(/organizationId.*required/);
    });
  });

  describe('File Management: Bulk Operations', () => {
    it('should handle bulk upload', async () => {
      const media = createMedia({
        driver,
        processing: { enabled: false },
        suppressWarnings: true,
      });

      const Media = mongoose.model('Test', media.schema);
      media.init(Media);

      const files = Array.from({ length: 10 }, (_, i) => ({
        buffer: Buffer.from(`file${i}`),
        filename: `file${i}.txt`,
        mimeType: 'text/plain',
        folder: 'general',
      }));

      const uploaded = await media.uploadMany(files);
      expect(uploaded).toHaveLength(10);
    });

    it('should move files between folders', async () => {
      const media = createMedia({
        driver,
        processing: { enabled: false },
        suppressWarnings: true,
      });

      const Media = mongoose.model('Test', media.schema);
      media.init(Media);

      const uploaded = await media.upload({
        buffer: Buffer.from('doc'),
        filename: 'document.pdf',
        mimeType: 'application/pdf',
        folder: 'inbox',
      });

      await media.move([(uploaded as any)._id.toString()], 'archive');

      const doc = await Media.findById(uploaded._id);
      expect(doc?.folder).toBe('archive');
    });
  });

  describe('Storage Analytics', () => {
    it('should calculate total storage used', async () => {
      const media = createMedia({
        driver,
        processing: { enabled: false },
        suppressWarnings: true,
      });

      const Media = mongoose.model('Test', media.schema);
      media.init(Media);

      await media.upload({ buffer: Buffer.alloc(1000), filename: 'a.txt', mimeType: 'text/plain', folder: 'general' });
      await media.upload({ buffer: Buffer.alloc(2000), filename: 'b.txt', mimeType: 'text/plain', folder: 'general' });

      const total = await media.repository.getTotalStorageUsed();
      expect(total).toBe(3000);
    });

    it('should break down storage by folder', async () => {
      const media = createMedia({
        driver,
        processing: { enabled: false },
        suppressWarnings: true,
      });

      const Media = mongoose.model('Test', media.schema);
      media.init(Media);

      await media.upload({ buffer: Buffer.alloc(3000), filename: 'img.jpg', mimeType: 'image/jpeg', folder: 'images' });
      await media.upload({ buffer: Buffer.alloc(1000), filename: 'doc.pdf', mimeType: 'application/pdf', folder: 'documents' });

      const breakdown = await media.repository.getStorageByFolder();
      expect(breakdown).toHaveLength(2);

      const images = breakdown.find(b => b.folder === 'images');
      expect(images?.size).toBe(3000);
      expect(images?.percentage).toBe(75);
    });
  });

  describe('Error Handling', () => {
    it('should handle storage driver errors', async () => {
      // Failing driver that throws on write()
      const failingDriver: StorageDriver = {
        name: 'failing',
        async write(): Promise<WriteResult> { throw new Error('Storage unavailable'); },
        async read(): Promise<NodeJS.ReadableStream> { return Readable.from(Buffer.alloc(0)); },
        async delete() { return false; },
        async exists() { return false; },
        async stat(): Promise<FileStat> { return { size: 0, contentType: '' }; },
        getPublicUrl(key: string) { return `https://cdn.example.com/${key}`; },
      };

      const media = createMedia({
        driver: failingDriver,
        processing: { enabled: false },
        suppressWarnings: true,
      });

      const Media = mongoose.model('Test', media.schema);
      media.init(Media);

      await expect(
        media.upload({
          buffer: Buffer.from('test'),
          filename: 'test.txt',
          mimeType: 'text/plain',
          folder: 'general',
        })
      ).rejects.toThrow('Storage unavailable');
    });

    it('should emit error events', async () => {
      const failingDriver: StorageDriver = {
        name: 'failing',
        async write(): Promise<WriteResult> { throw new Error('Upload failed'); },
        async read(): Promise<NodeJS.ReadableStream> { return Readable.from(Buffer.alloc(0)); },
        async delete() { return false; },
        async exists() { return false; },
        async stat(): Promise<FileStat> { return { size: 0, contentType: '' }; },
        getPublicUrl(key: string) { return `https://cdn.example.com/${key}`; },
      };

      const media = createMedia({
        driver: failingDriver,
        processing: { enabled: false },
        suppressWarnings: true,
      });

      const Media = mongoose.model('Test', media.schema);
      media.init(Media);

      let errorCaught: any = null;
      media.on('error:upload', (event: any) => {
        errorCaught = event;
      });

      try {
        await media.upload({
          buffer: Buffer.from('test'),
          filename: 'test.txt',
          mimeType: 'text/plain',
          folder: 'general',
        });
      } catch {
        // Expected
      }

      expect(errorCaught).toBeDefined();
      expect(errorCaught.error.message).toBe('Upload failed');
    });
  });

  describe('Recent Uploads', () => {
    it('should get recent uploads in order', async () => {
      const media = createMedia({
        driver,
        processing: { enabled: false },
        suppressWarnings: true,
      });

      const Media = mongoose.model('Test', media.schema);
      media.init(Media);

      await media.upload({ buffer: Buffer.from('1'), filename: 'first.txt', mimeType: 'text/plain', folder: 'general' });
      await media.upload({ buffer: Buffer.from('2'), filename: 'second.txt', mimeType: 'text/plain', folder: 'general' });
      await media.upload({ buffer: Buffer.from('3'), filename: 'third.txt', mimeType: 'text/plain', folder: 'general' });

      const recent = await media.repository.getRecentUploads(2);

      expect(recent).toHaveLength(2);
      // `filename` is the storage key filename, use `originalFilename` for the original
      expect(recent[0].originalFilename).toBe('third.txt');
    });
  });

  describe('Tags & Search', () => {
    it('should tag and search files', async () => {
      const media = createMedia({
        driver,
        processing: { enabled: false },
        suppressWarnings: true,
      });

      const Media = mongoose.model('Test', media.schema);
      media.init(Media);

      const uploaded = await media.upload({
        buffer: Buffer.from('hero'),
        filename: 'hero-banner.jpg',
        mimeType: 'image/jpeg',
        folder: 'images',
        tags: ['hero', 'banner'],
      });

      expect(uploaded.tags).toEqual(['hero', 'banner']);

      // Add more tags
      const updated = await media.addTags((uploaded as any)._id.toString(), ['featured']);
      expect(updated.tags).toContain('featured');
    });
  });

  describe('Status Lifecycle', () => {
    it('should track upload status lifecycle', async () => {
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

      expect(uploaded.status).toBe('ready');
      expect(uploaded.hash).toBeDefined();
      expect(uploaded.hash.length).toBeGreaterThan(0);
    });
  });
});
