/**
 * Key Rewrite Tests
 *
 * Tests that move() and renameFolder() physically rewrite storage keys
 * when rewriteKeys is enabled (default: true).
 *
 * Validates:
 * - Storage files are copied to new keys matching the target folder
 * - Old storage files are deleted after successful DB update
 * - DB records (key, url, folder, variants) are updated correctly
 * - rewriteKeys: false preserves metadata-only behavior
 * - Cross-folder isolation (keys don't leak across folders)
 *
 * Requires: MongoDB running on localhost:27017
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { createMedia } from '../src/media';
import type { ProgressEvent } from '../src/types';
import { MemoryStorageDriver } from './helpers/memory-driver';

describe('Key Rewrite: move()', () => {
  let driver: MemoryStorageDriver;

  beforeAll(async () => {
    await mongoose.connect('mongodb://localhost:27017/mediakit-keyrewrite-test');
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

  it('should rewrite storage key to match target folder', async () => {
    const media = createMedia({
      driver,
      processing: { enabled: false },
      suppressWarnings: true,
    });

    const Model = mongoose.model('Test', media.schema);
    media.init(Model);

    const uploaded = await media.upload({
      buffer: Buffer.from('document content'),
      filename: 'report.pdf',
      mimeType: 'application/pdf',
      folder: 'inbox',
    });

    // Verify file is in storage under inbox/
    expect(uploaded.key).toMatch(/^inbox\//);
    expect(await driver.exists(uploaded.key)).toBe(true);

    const id = (uploaded as any)._id.toString();
    const oldKey = uploaded.key;

    await media.move([id], 'archive');

    // Verify DB is updated
    const doc = await Model.findById(id).lean();
    expect(doc!.folder).toBe('archive');
    expect(doc!.key).toMatch(/^archive\//);
    expect(doc!.url).toContain('archive/');

    // Verify storage: new key exists, old key is gone
    expect(await driver.exists(doc!.key)).toBe(true);
    expect(await driver.exists(oldKey)).toBe(false);

    // Verify file content is preserved
    const buf = driver.getBuffer(doc!.key);
    expect(buf?.toString()).toBe('document content');
  });

  it('should rewrite keys for multiple files', async () => {
    const media = createMedia({
      driver,
      processing: { enabled: false },
      suppressWarnings: true,
    });

    const Model = mongoose.model('Test', media.schema);
    media.init(Model);

    const file1 = await media.upload({
      buffer: Buffer.from('file1'),
      filename: 'a.txt',
      mimeType: 'text/plain',
      folder: 'inbox',
    });
    const file2 = await media.upload({
      buffer: Buffer.from('file2'),
      filename: 'b.txt',
      mimeType: 'text/plain',
      folder: 'inbox',
    });

    const id1 = (file1 as any)._id.toString();
    const id2 = (file2 as any)._id.toString();
    const oldKey1 = file1.key;
    const oldKey2 = file2.key;

    const result = await media.move([id1, id2], 'archive');
    expect(result.modifiedCount).toBe(2);

    // Both files moved in storage
    const doc1 = await Model.findById(id1).lean();
    const doc2 = await Model.findById(id2).lean();

    expect(doc1!.key).toMatch(/^archive\//);
    expect(doc2!.key).toMatch(/^archive\//);
    expect(await driver.exists(doc1!.key)).toBe(true);
    expect(await driver.exists(doc2!.key)).toBe(true);
    expect(await driver.exists(oldKey1)).toBe(false);
    expect(await driver.exists(oldKey2)).toBe(false);
  });

  it('should skip storage copy when file is already in target folder', async () => {
    const media = createMedia({
      driver,
      processing: { enabled: false },
      suppressWarnings: true,
    });

    const Model = mongoose.model('Test', media.schema);
    media.init(Model);

    const uploaded = await media.upload({
      buffer: Buffer.from('already here'),
      filename: 'doc.txt',
      mimeType: 'text/plain',
      folder: 'archive',
    });

    const id = (uploaded as any)._id.toString();
    const originalKey = uploaded.key;

    // Move to the same folder — should be a no-op for storage
    const result = await media.move([id], 'archive');

    const doc = await Model.findById(id).lean();
    expect(doc!.key).toBe(originalKey);
    expect(await driver.exists(originalKey)).toBe(true);
  });

  it('should use metadata-only move when rewriteKeys is false', async () => {
    const media = createMedia({
      driver,
      folders: { rewriteKeys: false },
      processing: { enabled: false },
      suppressWarnings: true,
    });

    const Model = mongoose.model('Test', media.schema);
    media.init(Model);

    const uploaded = await media.upload({
      buffer: Buffer.from('content'),
      filename: 'doc.txt',
      mimeType: 'text/plain',
      folder: 'inbox',
    });

    const id = (uploaded as any)._id.toString();
    const originalKey = uploaded.key;

    await media.move([id], 'archive');

    // DB folder is updated but key stays the same
    const doc = await Model.findById(id).lean();
    expect(doc!.folder).toBe('archive');
    expect(doc!.key).toBe(originalKey); // key unchanged
    expect(await driver.exists(originalKey)).toBe(true); // old key still exists
  });

  it('should preserve file content after key rewrite', async () => {
    const media = createMedia({
      driver,
      processing: { enabled: false },
      suppressWarnings: true,
    });

    const Model = mongoose.model('Test', media.schema);
    media.init(Model);

    const content = 'important data that must survive the move';
    const uploaded = await media.upload({
      buffer: Buffer.from(content),
      filename: 'critical.dat',
      mimeType: 'text/plain',
      folder: 'temp',
    });

    const id = (uploaded as any)._id.toString();

    await media.move([id], 'permanent');

    const doc = await Model.findById(id).lean();
    const buf = driver.getBuffer(doc!.key);
    expect(buf?.toString()).toBe(content);
  });
});

describe('Key Rewrite: renameFolder()', () => {
  let driver: MemoryStorageDriver;

  beforeAll(async () => {
    if (mongoose.connection.readyState !== 1) {
      await mongoose.connect('mongodb://localhost:27017/mediakit-keyrewrite-test');
    }
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

  it('should rewrite all keys when renaming a folder', async () => {
    const media = createMedia({
      driver,
      processing: { enabled: false },
      suppressWarnings: true,
    });

    const Model = mongoose.model('Test', media.schema);
    media.init(Model);

    const file1 = await media.upload({
      buffer: Buffer.from('img1'),
      filename: 'photo.jpg',
      mimeType: 'image/jpeg',
      folder: 'images',
    });
    const file2 = await media.upload({
      buffer: Buffer.from('img2'),
      filename: 'banner.jpg',
      mimeType: 'image/jpeg',
      folder: 'images',
    });

    const oldKey1 = file1.key;
    const oldKey2 = file2.key;

    const result = await media.renameFolder('images', 'photos');
    expect(result.modifiedCount).toBe(2);

    // Both files should have new keys under photos/
    const doc1 = await Model.findById(file1._id).lean();
    const doc2 = await Model.findById(file2._id).lean();

    expect(doc1!.folder).toBe('photos');
    expect(doc1!.key).toMatch(/^photos\//);
    expect(doc2!.folder).toBe('photos');
    expect(doc2!.key).toMatch(/^photos\//);

    // Storage: new keys exist, old keys are gone
    expect(await driver.exists(doc1!.key)).toBe(true);
    expect(await driver.exists(doc2!.key)).toBe(true);
    expect(await driver.exists(oldKey1)).toBe(false);
    expect(await driver.exists(oldKey2)).toBe(false);
  });

  it('should preserve subfolder structure in keys', async () => {
    const media = createMedia({
      driver,
      processing: { enabled: false },
      suppressWarnings: true,
    });

    const Model = mongoose.model('Test', media.schema);
    media.init(Model);

    // Upload to nested subfolder
    const uploaded = await media.upload({
      buffer: Buffer.from('nested'),
      filename: 'deep.txt',
      mimeType: 'text/plain',
      folder: 'images/products',
    });

    const oldKey = uploaded.key;

    // Rename the parent folder
    await media.renameFolder('images', 'media');

    const doc = await Model.findById(uploaded._id).lean();
    expect(doc!.folder).toBe('media/products');
    expect(doc!.key).toMatch(/^media\/products\//);

    // Storage integrity
    expect(await driver.exists(doc!.key)).toBe(true);
    expect(await driver.exists(oldKey)).toBe(false);
  });

  it('should preserve file content after folder rename', async () => {
    const media = createMedia({
      driver,
      processing: { enabled: false },
      suppressWarnings: true,
    });

    const Model = mongoose.model('Test', media.schema);
    media.init(Model);

    const content = 'precious data';
    const uploaded = await media.upload({
      buffer: Buffer.from(content),
      filename: 'data.bin',
      mimeType: 'text/plain',
      folder: 'old-name',
    });

    await media.renameFolder('old-name', 'new-name');

    const doc = await Model.findById(uploaded._id).lean();
    const buf = driver.getBuffer(doc!.key);
    expect(buf?.toString()).toBe(content);
  });

  it('should use metadata-only rename when rewriteKeys is false', async () => {
    const media = createMedia({
      driver,
      folders: { rewriteKeys: false },
      processing: { enabled: false },
      suppressWarnings: true,
    });

    const Model = mongoose.model('Test', media.schema);
    media.init(Model);

    const uploaded = await media.upload({
      buffer: Buffer.from('test'),
      filename: 'test.txt',
      mimeType: 'text/plain',
      folder: 'old-folder',
    });

    const originalKey = uploaded.key;

    await media.renameFolder('old-folder', 'new-folder');

    const doc = await Model.findById(uploaded._id).lean();
    expect(doc!.folder).toBe('new-folder');
    expect(doc!.key).toBe(originalKey); // key unchanged
    expect(await driver.exists(originalKey)).toBe(true); // old key still in storage
  });

  it('should return modifiedCount: 0 for empty folder rename', async () => {
    const media = createMedia({
      driver,
      processing: { enabled: false },
      suppressWarnings: true,
    });

    const Model = mongoose.model('Test', media.schema);
    media.init(Model);

    const result = await media.renameFolder('nonexistent', 'something');
    expect(result.modifiedCount).toBe(0);
  });
});

describe('Key Rewrite: helper functions', () => {
  it('rewriteKey should place filename under target folder', async () => {
    const { rewriteKey } = await import('../src/operations/helpers');

    expect(rewriteKey('inbox/12345-abc-doc.txt', 'archive'))
      .toBe('archive/12345-abc-doc.txt');

    expect(rewriteKey('deep/nested/path/file.pdf', 'flat'))
      .toBe('flat/file.pdf');

    // Edge case: no slash in key
    expect(rewriteKey('orphan.txt', 'folder'))
      .toBe('folder/orphan.txt');
  });

  it('rewriteKeyPrefix should replace folder prefix in key', async () => {
    const { rewriteKeyPrefix } = await import('../src/operations/helpers');

    // Direct match
    expect(rewriteKeyPrefix('images/12345-photo.jpg', 'images', 'photos'))
      .toBe('photos/12345-photo.jpg');

    // Nested subfolder
    expect(rewriteKeyPrefix('images/products/12345-photo.jpg', 'images', 'media'))
      .toBe('media/products/12345-photo.jpg');

    // No match — key unchanged
    expect(rewriteKeyPrefix('other/12345-file.txt', 'images', 'photos'))
      .toBe('other/12345-file.txt');

    // Exact match (key equals prefix)
    expect(rewriteKeyPrefix('images', 'images', 'photos'))
      .toBe('photos');
  });
});

describe('Progress Events: move()', () => {
  let driver: MemoryStorageDriver;

  beforeAll(async () => {
    if (mongoose.connection.readyState !== 1) {
      await mongoose.connect('mongodb://localhost:27017/mediakit-keyrewrite-test');
    }
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

  it('should emit progress:move for each file', async () => {
    const media = createMedia({
      driver,
      processing: { enabled: false },
      suppressWarnings: true,
    });

    const Model = mongoose.model('Test', media.schema);
    media.init(Model);

    const file1 = await media.upload({
      buffer: Buffer.from('file1'),
      filename: 'a.txt',
      mimeType: 'text/plain',
      folder: 'inbox',
    });
    const file2 = await media.upload({
      buffer: Buffer.from('file2'),
      filename: 'b.txt',
      mimeType: 'text/plain',
      folder: 'inbox',
    });
    const file3 = await media.upload({
      buffer: Buffer.from('file3'),
      filename: 'c.txt',
      mimeType: 'text/plain',
      folder: 'inbox',
    });

    const progressEvents: ProgressEvent[] = [];
    media.on<ProgressEvent>('progress:move', (event) => {
      progressEvents.push(event);
    });

    const id1 = (file1 as any)._id.toString();
    const id2 = (file2 as any)._id.toString();
    const id3 = (file3 as any)._id.toString();

    await media.move([id1, id2, id3], 'archive');

    // Should have 3 progress events (one per file)
    expect(progressEvents).toHaveLength(3);

    // All events should report total = 3
    for (const evt of progressEvents) {
      expect(evt.total).toBe(3);
      expect(evt.timestamp).toBeInstanceOf(Date);
      expect(evt.key).toMatch(/^archive\//);
    }

    // completed values should cover 1, 2, 3 (order may vary due to parallel)
    const completedValues = progressEvents.map(e => e.completed).sort();
    expect(completedValues).toEqual([1, 2, 3]);

    // All 3 file IDs should appear
    const fileIds = progressEvents.map(e => e.fileId).sort();
    expect(fileIds).toEqual([id1, id2, id3].sort());
  });

  it('should emit progress:move even for same-folder files', async () => {
    const media = createMedia({
      driver,
      processing: { enabled: false },
      suppressWarnings: true,
    });

    const Model = mongoose.model('Test', media.schema);
    media.init(Model);

    const uploaded = await media.upload({
      buffer: Buffer.from('content'),
      filename: 'doc.txt',
      mimeType: 'text/plain',
      folder: 'archive',
    });

    const progressEvents: ProgressEvent[] = [];
    media.on<ProgressEvent>('progress:move', (event) => {
      progressEvents.push(event);
    });

    const id = (uploaded as any)._id.toString();
    await media.move([id], 'archive');

    // Same folder = key unchanged, but progress event still fires
    expect(progressEvents).toHaveLength(1);
    expect(progressEvents[0].fileId).toBe(id);
    expect(progressEvents[0].completed).toBe(1);
    expect(progressEvents[0].total).toBe(1);
  });

  it('should not emit progress:move when rewriteKeys is false', async () => {
    const media = createMedia({
      driver,
      folders: { rewriteKeys: false },
      processing: { enabled: false },
      suppressWarnings: true,
    });

    const Model = mongoose.model('Test', media.schema);
    media.init(Model);

    const uploaded = await media.upload({
      buffer: Buffer.from('data'),
      filename: 'file.txt',
      mimeType: 'text/plain',
      folder: 'inbox',
    });

    const progressEvents: ProgressEvent[] = [];
    media.on<ProgressEvent>('progress:move', (event) => {
      progressEvents.push(event);
    });

    await media.move([(uploaded as any)._id.toString()], 'archive');

    // Metadata-only path doesn't emit progress events
    expect(progressEvents).toHaveLength(0);
  });
});

describe('Progress Events: renameFolder()', () => {
  let driver: MemoryStorageDriver;

  beforeAll(async () => {
    if (mongoose.connection.readyState !== 1) {
      await mongoose.connect('mongodb://localhost:27017/mediakit-keyrewrite-test');
    }
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

  it('should emit progress:rename for each file', async () => {
    const media = createMedia({
      driver,
      processing: { enabled: false },
      suppressWarnings: true,
    });

    const Model = mongoose.model('Test', media.schema);
    media.init(Model);

    await media.upload({
      buffer: Buffer.from('img1'),
      filename: 'photo.jpg',
      mimeType: 'image/jpeg',
      folder: 'images',
    });
    await media.upload({
      buffer: Buffer.from('img2'),
      filename: 'banner.jpg',
      mimeType: 'image/jpeg',
      folder: 'images',
    });

    const progressEvents: ProgressEvent[] = [];
    media.on<ProgressEvent>('progress:rename', (event) => {
      progressEvents.push(event);
    });

    await media.renameFolder('images', 'photos');

    expect(progressEvents).toHaveLength(2);

    for (const evt of progressEvents) {
      expect(evt.total).toBe(2);
      expect(evt.key).toMatch(/^photos\//);
      expect(evt.timestamp).toBeInstanceOf(Date);
    }

    const completedValues = progressEvents.map(e => e.completed).sort();
    expect(completedValues).toEqual([1, 2]);
  });

  it('should emit progress:rename with correct keys for subfolder files', async () => {
    const media = createMedia({
      driver,
      processing: { enabled: false },
      suppressWarnings: true,
    });

    const Model = mongoose.model('Test', media.schema);
    media.init(Model);

    await media.upload({
      buffer: Buffer.from('nested'),
      filename: 'deep.txt',
      mimeType: 'text/plain',
      folder: 'images/products',
    });

    const progressEvents: ProgressEvent[] = [];
    media.on<ProgressEvent>('progress:rename', (event) => {
      progressEvents.push(event);
    });

    await media.renameFolder('images', 'media');

    expect(progressEvents).toHaveLength(1);
    expect(progressEvents[0].key).toMatch(/^media\/products\//);
    expect(progressEvents[0].completed).toBe(1);
    expect(progressEvents[0].total).toBe(1);
  });

  it('should not emit progress:rename when rewriteKeys is false', async () => {
    const media = createMedia({
      driver,
      folders: { rewriteKeys: false },
      processing: { enabled: false },
      suppressWarnings: true,
    });

    const Model = mongoose.model('Test', media.schema);
    media.init(Model);

    await media.upload({
      buffer: Buffer.from('test'),
      filename: 'test.txt',
      mimeType: 'text/plain',
      folder: 'old-folder',
    });

    const progressEvents: ProgressEvent[] = [];
    media.on<ProgressEvent>('progress:rename', (event) => {
      progressEvents.push(event);
    });

    await media.renameFolder('old-folder', 'new-folder');

    // Metadata-only path doesn't emit progress events
    expect(progressEvents).toHaveLength(0);
  });
});
