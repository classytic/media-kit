/**
 * Deduplication Integration Tests
 *
 * Tests automatic hash computation on upload, hash consistency for identical
 * content, hash divergence for different content, and the deduplication config
 * flags (enabled, returnExisting).
 * Requires a running MongoDB instance at localhost:27017.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { createMedia } from '../src/media';
import { MemoryStorageDriver } from './helpers/memory-driver';

describe('Deduplication', () => {
  let driver: MemoryStorageDriver;

  beforeAll(async () => {
    await mongoose.connect('mongodb://localhost:27017/mediakit-dedup-test');
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
  // AUTO-HASH
  // ============================================

  it('should auto-compute a hash field on every upload', async () => {
    const media = createMedia({
      driver,
      processing: { enabled: false },
      suppressWarnings: true,
    });

    const Media = mongoose.model('Test', media.schema);
    media.init(Media);

    const uploaded = await media.upload({
      buffer: Buffer.from('hash me'),
      filename: 'hashable.txt',
      mimeType: 'text/plain',
      folder: 'general',
    });

    expect(uploaded.hash).toBeDefined();
    expect(typeof uploaded.hash).toBe('string');
    expect(uploaded.hash.length).toBeGreaterThan(0);
    // SHA-256 hex string is 64 characters
    expect(uploaded.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  // ============================================
  // SAME CONTENT -> SAME HASH
  // ============================================

  it('should produce the same hash for identical content', async () => {
    const media = createMedia({
      driver,
      processing: { enabled: false },
      suppressWarnings: true,
    });

    const Media = mongoose.model('Test', media.schema);
    media.init(Media);

    const content = Buffer.from('identical content for hashing');

    const first = await media.upload({
      buffer: content,
      filename: 'copy-a.txt',
      mimeType: 'text/plain',
      folder: 'general',
    });

    const second = await media.upload({
      buffer: content,
      filename: 'copy-b.txt',
      mimeType: 'text/plain',
      folder: 'general',
    });

    expect(first.hash).toBe(second.hash);
  });

  // ============================================
  // DIFFERENT CONTENT -> DIFFERENT HASH
  // ============================================

  it('should produce different hashes for different content', async () => {
    const media = createMedia({
      driver,
      processing: { enabled: false },
      suppressWarnings: true,
    });

    const Media = mongoose.model('Test', media.schema);
    media.init(Media);

    const fileA = await media.upload({
      buffer: Buffer.from('content alpha'),
      filename: 'alpha.txt',
      mimeType: 'text/plain',
      folder: 'general',
    });

    const fileB = await media.upload({
      buffer: Buffer.from('content beta'),
      filename: 'beta.txt',
      mimeType: 'text/plain',
      folder: 'general',
    });

    expect(fileA.hash).not.toBe(fileB.hash);
  });

  // ============================================
  // DEDUP ENABLED — RETURNS EXISTING DOCUMENT
  // ============================================

  it('should return the existing document when dedup is enabled and returnExisting is true', async () => {
    const media = createMedia({
      driver,
      processing: { enabled: false },
      suppressWarnings: true,
      deduplication: {
        enabled: true,
        returnExisting: true,
      },
    });

    const Media = mongoose.model('Test', media.schema);
    media.init(Media);

    const content = Buffer.from('deduplicated content');

    const first = await media.upload({
      buffer: content,
      filename: 'original.txt',
      mimeType: 'text/plain',
      folder: 'general',
    });

    const second = await media.upload({
      buffer: content,
      filename: 'duplicate.txt',
      mimeType: 'text/plain',
      folder: 'general',
    });

    // Same document returned — same _id
    expect((second as any)._id.toString()).toBe((first as any)._id.toString());

    // Only one document in the database
    const count = await Media.countDocuments();
    expect(count).toBe(1);
  });

  // ============================================
  // DEDUP DISABLED (DEFAULT) — CREATES TWO DOCS
  // ============================================

  it('should create two separate documents when dedup is disabled (default)', async () => {
    const media = createMedia({
      driver,
      processing: { enabled: false },
      suppressWarnings: true,
      // deduplication not set — defaults to disabled
    });

    const Media = mongoose.model('Test', media.schema);
    media.init(Media);

    const content = Buffer.from('non-dedup content');

    const first = await media.upload({
      buffer: content,
      filename: 'first.txt',
      mimeType: 'text/plain',
      folder: 'general',
    });

    const second = await media.upload({
      buffer: content,
      filename: 'second.txt',
      mimeType: 'text/plain',
      folder: 'general',
    });

    // Different documents — different _id
    expect((second as any)._id.toString()).not.toBe((first as any)._id.toString());

    // Two documents in the database
    const count = await Media.countDocuments();
    expect(count).toBe(2);
  });

  // ============================================
  // DEDUP ENABLED WITH returnExisting: false
  // ============================================

  it('should create a new record even with dedup enabled when returnExisting is false', async () => {
    const media = createMedia({
      driver,
      processing: { enabled: false },
      suppressWarnings: true,
      deduplication: {
        enabled: true,
        returnExisting: false,
      },
    });

    const Media = mongoose.model('Test', media.schema);
    media.init(Media);

    const content = Buffer.from('dedup but do not return existing');

    const first = await media.upload({
      buffer: content,
      filename: 'orig.txt',
      mimeType: 'text/plain',
      folder: 'general',
    });

    const second = await media.upload({
      buffer: content,
      filename: 'dup.txt',
      mimeType: 'text/plain',
      folder: 'general',
    });

    // Different documents created
    expect((second as any)._id.toString()).not.toBe((first as any)._id.toString());

    // Two documents in the database
    const count = await Media.countDocuments();
    expect(count).toBe(2);

    // But hash is still computed on both
    expect(first.hash).toBeDefined();
    expect(second.hash).toBeDefined();
    expect(first.hash).toBe(second.hash);
  });
});
