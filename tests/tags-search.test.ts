/**
 * Tags & Search Integration Tests
 *
 * Tests tag CRUD operations (addTags, removeTags, upload with tags)
 * and MongoDB full-text search via the media.search() method.
 * Requires a running MongoDB instance at localhost:27017.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { createMedia } from '../src/media';
import { MemoryStorageDriver } from './helpers/memory-driver';

describe('Tags & Search', () => {
  let driver: MemoryStorageDriver;

  beforeAll(async () => {
    await mongoose.connect('mongodb://localhost:27017/mediakit-tags-search-test');
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
  // TAGS
  // ============================================

  describe('Tags', () => {
    it('should add tags to an uploaded file', async () => {
      const media = createMedia({
        driver,
        processing: { enabled: false },
        suppressWarnings: true,
      });

      const Media = mongoose.model('Test', media.schema);
      media.init(Media);

      const uploaded = await media.upload({
        buffer: Buffer.from('hero image content'),
        filename: 'hero-banner.jpg',
        mimeType: 'image/jpeg',
        folder: 'marketing',
      });

      const id = (uploaded as any)._id.toString();
      const tagged = await media.addTags(id, ['hero', 'featured']);

      expect(tagged.tags).toContain('hero');
      expect(tagged.tags).toContain('featured');
      expect(tagged.tags).toHaveLength(2);
    });

    it('should be idempotent — adding the same tag twice does not duplicate', async () => {
      const media = createMedia({
        driver,
        processing: { enabled: false },
        suppressWarnings: true,
      });

      const Media = mongoose.model('Test', media.schema);
      media.init(Media);

      const uploaded = await media.upload({
        buffer: Buffer.from('idempotent tag test'),
        filename: 'tagfile.txt',
        mimeType: 'text/plain',
        folder: 'general',
      });

      const id = (uploaded as any)._id.toString();

      // Add 'promo' twice
      await media.addTags(id, ['promo']);
      const result = await media.addTags(id, ['promo']);

      const promoOccurrences = result.tags.filter(t => t === 'promo');
      expect(promoOccurrences).toHaveLength(1);
    });

    it('should remove tags and preserve remaining ones', async () => {
      const media = createMedia({
        driver,
        processing: { enabled: false },
        suppressWarnings: true,
      });

      const Media = mongoose.model('Test', media.schema);
      media.init(Media);

      const uploaded = await media.upload({
        buffer: Buffer.from('remove tag test'),
        filename: 'removable.txt',
        mimeType: 'text/plain',
        folder: 'general',
      });

      const id = (uploaded as any)._id.toString();

      // Add three tags, then remove one
      await media.addTags(id, ['alpha', 'beta', 'gamma']);
      const result = await media.removeTags(id, ['beta']);

      expect(result.tags).toContain('alpha');
      expect(result.tags).toContain('gamma');
      expect(result.tags).not.toContain('beta');
      expect(result.tags).toHaveLength(2);
    });

    it('should set tags when provided in the upload input', async () => {
      const media = createMedia({
        driver,
        processing: { enabled: false },
        suppressWarnings: true,
      });

      const Media = mongoose.model('Test', media.schema);
      media.init(Media);

      const uploaded = await media.upload({
        buffer: Buffer.from('promo content'),
        filename: 'promo-banner.png',
        mimeType: 'image/png',
        folder: 'campaigns',
        tags: ['promo'],
      });

      expect(uploaded.tags).toContain('promo');
      expect(uploaded.tags).toHaveLength(1);
    });
  });

  // ============================================
  // SEARCH
  // ============================================

  describe('Search', () => {
    it('should return matching documents by text search', async () => {
      const media = createMedia({
        driver,
        processing: { enabled: false },
        suppressWarnings: true,
      });

      const Media = mongoose.model('Test', media.schema);
      media.init(Media);

      // Ensure the text index is created before searching
      await Media.createIndexes();

      await media.upload({
        buffer: Buffer.from('red shoes file'),
        filename: 'red-running-shoes.jpg',
        mimeType: 'image/jpeg',
        folder: 'products',
        title: 'Red Running Shoes',
      });

      await media.upload({
        buffer: Buffer.from('blue hat file'),
        filename: 'blue-hat.jpg',
        mimeType: 'image/jpeg',
        folder: 'products',
        title: 'Blue Hat',
      });

      await media.upload({
        buffer: Buffer.from('shoes closeup'),
        filename: 'shoes-closeup.jpg',
        mimeType: 'image/jpeg',
        folder: 'products',
        title: 'Shoes Closeup',
      });

      const results = await media.search('shoes');

      expect(results.docs.length).toBeGreaterThanOrEqual(2);
      const titles = results.docs.map(d => d.title);
      expect(titles).toEqual(expect.arrayContaining([
        'Red Running Shoes',
        'Shoes Closeup',
      ]));
    });

    it('should return empty docs array when nothing matches', async () => {
      const media = createMedia({
        driver,
        processing: { enabled: false },
        suppressWarnings: true,
      });

      const Media = mongoose.model('Test', media.schema);
      media.init(Media);

      await Media.createIndexes();

      await media.upload({
        buffer: Buffer.from('some file'),
        filename: 'landscape.jpg',
        mimeType: 'image/jpeg',
        folder: 'nature',
        title: 'Mountain Landscape',
      });

      const results = await media.search('xylophone');

      expect(results.docs).toHaveLength(0);
    });
  });
});
