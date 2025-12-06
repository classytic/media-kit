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
import type { StorageProvider, UploadResult, UploadOptions } from '../src/types';

// Mock storage provider
class MockStorageProvider implements StorageProvider {
  readonly name = 'mock';
  private storage = new Map<string, Buffer>();

  async upload(buffer: Buffer, filename: string, options?: UploadOptions): Promise<UploadResult> {
    const key = `${options?.folder || 'uploads'}/${Date.now()}-${filename}`;
    this.storage.set(key, buffer);
    return {
      url: `https://cdn.example.com/${key}`,
      key,
      size: buffer.length,
      mimeType: 'application/octet-stream',
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

describe('Real-World Scenarios', () => {
  let provider: MockStorageProvider;

  beforeAll(async () => {
    await mongoose.connect('mongodb://localhost:27017/mediakit-realworld-test');
  });

  afterAll(async () => {
    await mongoose.disconnect();
  });

  beforeEach(async () => {
    // Clean up before each test
    const collections = await mongoose.connection.db?.collections();
    if (collections) {
      for (const collection of collections) {
        await collection.deleteMany({});
      }
    }
    Object.keys(mongoose.models).forEach(key => delete mongoose.models[key]);
    provider = new MockStorageProvider();
  });

  describe('E-commerce: Product Images', () => {
    it('should handle product catalog with multiple images per product', async () => {
      const media = createMedia({
        provider,
        folders: { baseFolders: ['products'] },
        fileTypes: { allowed: [] },
        suppressWarnings: true,
      });

      const Media = mongoose.model('EcomTest', media.schema);
      media.init(Media);

      const productId = 'prod_123';
      
      // Upload 3 images for one product
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

      // Query product images using folder filter
      const productImages = await media.getAll({
        filters: { folder: `products/${productId}` },
      });

      expect(productImages.docs).toHaveLength(3);
    });
  });

  describe('Blog: Post Images with SEO', () => {
    it('should auto-generate SEO-friendly alt text', async () => {
      const media = createMedia({
        provider,
        processing: { enabled: false, generateAlt: true },
        fileTypes: { allowed: [] },
        suppressWarnings: true,
      });

      const Media = mongoose.model('BlogTest', media.schema);
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
        provider,
        processing: { enabled: false, generateAlt: true },
        fileTypes: { allowed: [] },
        suppressWarnings: true,
      });

      const Media = mongoose.model('AltOverrideTest', media.schema);
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
        provider,
        multiTenancy: { enabled: true, field: 'organizationId', required: false },
        fileTypes: { allowed: [] },
        suppressWarnings: true,
      });

      const Media = mongoose.model('MultiTenantTest', media.schema);
      media.init(Media);

      // Use valid ObjectIds
      const org1Id = new mongoose.Types.ObjectId();
      const org2Id = new mongoose.Types.ObjectId();

      // Upload for org1
      await media.upload(
        { buffer: Buffer.from('org1'), filename: 'file.txt', mimeType: 'text/plain', folder: 'general' },
        { organizationId: org1Id }
      );

      // Upload for org2
      await media.upload(
        { buffer: Buffer.from('org2'), filename: 'file.txt', mimeType: 'text/plain', folder: 'general' },
        { organizationId: org2Id }
      );

      // Query org1 - should only see their files
      const org1Files = await media.getAll({}, { organizationId: org1Id });
      expect(org1Files.docs).toHaveLength(1);

      // Query org2 - should only see their files
      const org2Files = await media.getAll({}, { organizationId: org2Id });
      expect(org2Files.docs).toHaveLength(1);
    });

    it('should require organizationId when required=true', async () => {
      const media = createMedia({
        provider,
        multiTenancy: { enabled: true, field: 'organizationId', required: true },
        fileTypes: { allowed: [] },
        suppressWarnings: true,
      });

      const Media = mongoose.model('TenantRequiredTest', media.schema);
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
        provider,
        fileTypes: { allowed: [] },
        suppressWarnings: true,
      });

      const Media = mongoose.model('BulkUploadTest', media.schema);
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
        provider,
        folders: { baseFolders: ['inbox', 'archive'] },
        fileTypes: { allowed: [] },
        suppressWarnings: true,
      });

      const Media = mongoose.model('MoveTest', media.schema);
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
        provider,
        fileTypes: { allowed: [] },
        suppressWarnings: true,
      });

      const Media = mongoose.model('StorageTest', media.schema);
      media.init(Media);

      await media.upload({ buffer: Buffer.alloc(1000), filename: 'a.txt', mimeType: 'text/plain', folder: 'general' });
      await media.upload({ buffer: Buffer.alloc(2000), filename: 'b.txt', mimeType: 'text/plain', folder: 'general' });

      const total = await media.repository.getTotalStorageUsed();
      expect(total).toBe(3000);
    });

    it('should break down storage by folder', async () => {
      const media = createMedia({
        provider,
        folders: { baseFolders: ['images', 'documents'] },
        fileTypes: { allowed: [] },
        suppressWarnings: true,
      });

      const Media = mongoose.model('BreakdownTest', media.schema);
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

  describe('CDN Integration', () => {
    it('should use custom CDN URL', async () => {
      class CDNProvider implements StorageProvider {
        readonly name = 'cdn';
        async upload(buffer: Buffer, filename: string, options?: UploadOptions): Promise<UploadResult> {
          return {
            url: `https://cdn.mysite.com/${options?.folder}/${filename}`,
            key: `${options?.folder}/${filename}`,
            size: buffer.length,
            mimeType: 'image/jpeg',
          };
        }
        async delete() { return true; }
        async exists() { return true; }
      }

      const media = createMedia({
        provider: new CDNProvider(),
        fileTypes: { allowed: [] },
        suppressWarnings: true,
      });

      const Media = mongoose.model('CDNTest', media.schema);
      media.init(Media);

      const uploaded = await media.upload({
        buffer: Buffer.from('image'),
        filename: 'hero.jpg',
        mimeType: 'image/jpeg',
        folder: 'images',
      });

      expect(uploaded.url).toBe('https://cdn.mysite.com/images/hero.jpg');
    });
  });

  describe('Error Handling', () => {
    it('should handle storage provider errors', async () => {
      class FailingProvider implements StorageProvider {
        readonly name = 'failing';
        async upload(): Promise<UploadResult> {
          throw new Error('Storage unavailable');
        }
        async delete() { return false; }
        async exists() { return false; }
      }

      const media = createMedia({
        provider: new FailingProvider(),
        fileTypes: { allowed: [] },
        suppressWarnings: true,
      });

      const Media = mongoose.model('ErrorTest', media.schema);
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
      class FailingProvider implements StorageProvider {
        readonly name = 'failing';
        async upload(): Promise<UploadResult> {
          throw new Error('Upload failed');
        }
        async delete() { return false; }
        async exists() { return false; }
      }

      const media = createMedia({
        provider: new FailingProvider(),
        fileTypes: { allowed: [] },
        suppressWarnings: true,
      });

      const Media = mongoose.model('ErrorEventTest', media.schema);
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
        provider,
        fileTypes: { allowed: [] },
        suppressWarnings: true,
      });

      const Media = mongoose.model('RecentTest', media.schema);
      media.init(Media);

      await media.upload({ buffer: Buffer.from('1'), filename: 'first.txt', mimeType: 'text/plain', folder: 'general' });
      await media.upload({ buffer: Buffer.from('2'), filename: 'second.txt', mimeType: 'text/plain', folder: 'general' });
      await media.upload({ buffer: Buffer.from('3'), filename: 'third.txt', mimeType: 'text/plain', folder: 'general' });

      const recent = await media.repository.getRecentUploads(2);

      expect(recent).toHaveLength(2);
      expect(recent[0].filename).toBe('third.txt');
    });
  });
});
