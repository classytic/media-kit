/**
 * File Replacement Integration Tests
 *
 * Tests the media.replace() method which swaps file content while preserving
 * the same document ID. Covers metadata preservation, alt text handling,
 * nonexistent ID errors, and old variant cleanup.
 * Requires a running MongoDB instance at localhost:27017.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { createMedia } from '../src/media';
import { MemoryStorageDriver } from './helpers/memory-driver';

describe('File Replacement', () => {
  let driver: MemoryStorageDriver;

  beforeAll(async () => {
    await mongoose.connect('mongodb://localhost:27017/mediakit-replacement-test');
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

    // Delete all models to prevent recompilation errors
    Object.keys(mongoose.models).forEach(key => {
      delete mongoose.models[key];
    });

    driver = new MemoryStorageDriver();
  });

  // ============================================
  // REPLACE FILE CONTENT
  // ============================================

  it('should replace file content while preserving the document ID', async () => {
    const media = createMedia({
      driver,
      processing: { enabled: false },
      suppressWarnings: true,
    });

    const Media = mongoose.model('Test', media.schema);
    media.init(Media);

    // Upload original
    const originalBuffer = Buffer.from('original file content');
    const original = await media.upload({
      buffer: originalBuffer,
      filename: 'report.pdf',
      mimeType: 'application/pdf',
      folder: 'documents',
    });

    const originalId = (original as any)._id.toString();
    const originalKey = original.key;

    // Replace with new content
    const newBuffer = Buffer.from('updated report with more data and corrections');
    const replaced = await media.replace(originalId, {
      buffer: newBuffer,
      filename: 'report-v2.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    });

    // Same document ID preserved
    expect((replaced as any)._id.toString()).toBe(originalId);

    // New file metadata
    expect(replaced.originalFilename).toBe('report-v2.docx');
    expect(replaced.mimeType).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    expect(replaced.size).toBe(newBuffer.length);
    expect(replaced.hash).not.toBe(original.hash);

    // Old file deleted from storage
    const oldExists = await driver.exists(originalKey);
    expect(oldExists).toBe(false);

    // New file exists in storage
    const newExists = await driver.exists(replaced.key);
    expect(newExists).toBe(true);

    // Status is ready
    expect(replaced.status).toBe('ready');
  });

  // ============================================
  // REPLACE PRESERVES METADATA
  // ============================================

  it('should preserve alt text when replacing without providing new alt', async () => {
    const media = createMedia({
      driver,
      processing: { enabled: false },
      suppressWarnings: true,
    });

    const Media = mongoose.model('Test', media.schema);
    media.init(Media);

    const original = await media.upload({
      buffer: Buffer.from('image with alt'),
      filename: 'photo.jpg',
      mimeType: 'image/jpeg',
      folder: 'gallery',
      alt: 'A beautiful sunset over the ocean',
    });

    const originalId = (original as any)._id.toString();

    // Replace without specifying alt
    const replaced = await media.replace(originalId, {
      buffer: Buffer.from('new image data replacing the old one'),
      filename: 'photo-updated.jpg',
      mimeType: 'image/jpeg',
    });

    // Alt text preserved from original
    expect(replaced.alt).toBe('A beautiful sunset over the ocean');
  });

  // ============================================
  // REPLACE WITH NEW ALT
  // ============================================

  it('should use new alt text when provided during replacement', async () => {
    const media = createMedia({
      driver,
      processing: { enabled: false },
      suppressWarnings: true,
    });

    const Media = mongoose.model('Test', media.schema);
    media.init(Media);

    const original = await media.upload({
      buffer: Buffer.from('original image'),
      filename: 'banner.jpg',
      mimeType: 'image/jpeg',
      folder: 'marketing',
      alt: 'Old banner text',
    });

    const originalId = (original as any)._id.toString();

    const replaced = await media.replace(originalId, {
      buffer: Buffer.from('new banner image with different design'),
      filename: 'banner-new.jpg',
      mimeType: 'image/jpeg',
      alt: 'New banner with spring theme',
    });

    expect(replaced.alt).toBe('New banner with spring theme');
  });

  // ============================================
  // REPLACE NONEXISTENT ID THROWS
  // ============================================

  it('should throw when replacing a nonexistent document ID', async () => {
    const media = createMedia({
      driver,
      processing: { enabled: false },
      suppressWarnings: true,
    });

    const Media = mongoose.model('Test', media.schema);
    media.init(Media);

    const fakeId = new mongoose.Types.ObjectId().toString();

    await expect(
      media.replace(fakeId, {
        buffer: Buffer.from('replacement content'),
        filename: 'ghost.txt',
        mimeType: 'text/plain',
      })
    ).rejects.toThrow(/not found/i);
  });

  // ============================================
  // OLD VARIANTS CLEANED UP
  // ============================================

  it('should delete old variant keys from storage on replace', async () => {
    const media = createMedia({
      driver,
      processing: { enabled: false },
      suppressWarnings: true,
    });

    const Media = mongoose.model('Test', media.schema);
    media.init(Media);

    // Upload original file
    const original = await media.upload({
      buffer: Buffer.from('original with variants'),
      filename: 'product.jpg',
      mimeType: 'image/jpeg',
      folder: 'products',
    });

    const originalId = (original as any)._id.toString();

    // Simulate that the original has variants by writing fake variant files
    // to storage and updating the DB record directly
    const variantKey1 = 'products/variant-thumb.jpg';
    const variantKey2 = 'products/variant-medium.jpg';

    await driver.write(variantKey1, Buffer.from('thumb data'), 'image/jpeg');
    await driver.write(variantKey2, Buffer.from('medium data'), 'image/jpeg');

    await Media.findByIdAndUpdate(originalId, {
      variants: [
        {
          name: 'thumbnail',
          key: variantKey1,
          url: `https://cdn.example.com/${variantKey1}`,
          filename: 'variant-thumb.jpg',
          mimeType: 'image/jpeg',
          size: 10,
        },
        {
          name: 'medium',
          key: variantKey2,
          url: `https://cdn.example.com/${variantKey2}`,
          filename: 'variant-medium.jpg',
          mimeType: 'image/jpeg',
          size: 11,
        },
      ],
    });

    // Confirm variants exist in storage before replace
    expect(await driver.exists(variantKey1)).toBe(true);
    expect(await driver.exists(variantKey2)).toBe(true);

    // Replace the file
    await media.replace(originalId, {
      buffer: Buffer.from('brand new product image'),
      filename: 'product-v2.jpg',
      mimeType: 'image/jpeg',
    });

    // Old variant keys should be deleted from storage
    expect(await driver.exists(variantKey1)).toBe(false);
    expect(await driver.exists(variantKey2)).toBe(false);
  });
});
