/**
 * Multi-Tenant Enforcement Tests
 *
 * Validates that when multiTenancy.required=true, ALL operations
 * enforce organizationId — both mongokit lifecycle operations (getAll, getById, etc.)
 * and direct-model operations (addTags, move, renameFolder, etc.) via _buildQueryFilters.
 *
 * Also tests that before:* event hooks cannot veto operations (by design).
 *
 * Requires: MongoDB running on localhost:27017
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { createMedia } from '../src/media';
import { MemoryStorageDriver } from './helpers/memory-driver';
import type { MediaKit } from '../src/types';

describe('Multi-Tenant Enforcement', () => {
  let driver: MemoryStorageDriver;

  beforeAll(async () => {
    await mongoose.connect('mongodb://localhost:27017/mediakit-multitenant-test');
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

  // Helper: create media kit with required multi-tenancy
  function createRequiredTenantMedia(): MediaKit {
    const media = createMedia({
      driver,
      multiTenancy: { enabled: true, field: 'organizationId', required: true },
      processing: { enabled: false },
      suppressWarnings: true,
    });
    const Model = mongoose.model('Test', media.schema);
    media.init(Model);
    return media;
  }

  // Helper: create media kit with optional multi-tenancy
  function createOptionalTenantMedia(): MediaKit {
    const media = createMedia({
      driver,
      multiTenancy: { enabled: true, field: 'organizationId', required: false },
      processing: { enabled: false },
      suppressWarnings: true,
    });
    const Model = mongoose.model('Test', media.schema);
    media.init(Model);
    return media;
  }

  // ============================================
  // UPLOAD — already tested in real-world.test.ts,
  // but included here for completeness
  // ============================================

  describe('upload (mongokit lifecycle path)', () => {
    it('should throw when required=true and no organizationId', async () => {
      const media = createRequiredTenantMedia();

      await expect(
        media.upload({
          buffer: Buffer.from('test'),
          filename: 'test.txt',
          mimeType: 'text/plain',
          folder: 'general',
        })
      ).rejects.toThrow(/organizationId.*required/i);
    });

    it('should succeed when required=true and organizationId is provided', async () => {
      const media = createRequiredTenantMedia();
      const orgId = new mongoose.Types.ObjectId();

      const uploaded = await media.upload(
        { buffer: Buffer.from('test'), filename: 'test.txt', mimeType: 'text/plain', folder: 'general' },
        { organizationId: orgId },
      );

      expect(uploaded).toBeDefined();
      expect(uploaded.folder).toBe('general');
    });
  });

  // ============================================
  // ADDTAGS — direct Model operation via _buildQueryFilters
  // ============================================

  describe('addTags (_buildQueryFilters path)', () => {
    it('should throw when required=true and no organizationId', async () => {
      const media = createRequiredTenantMedia();
      const orgId = new mongoose.Types.ObjectId();

      // Upload with tenant context
      const uploaded = await media.upload(
        { buffer: Buffer.from('test'), filename: 'test.txt', mimeType: 'text/plain', folder: 'general' },
        { organizationId: orgId },
      );

      const id = (uploaded as any)._id.toString();

      // addTags WITHOUT context → should throw
      await expect(
        media.addTags(id, ['important'])
      ).rejects.toThrow(/organizationId.*missing/i);
    });

    it('should succeed when required=true and organizationId is provided', async () => {
      const media = createRequiredTenantMedia();
      const orgId = new mongoose.Types.ObjectId();

      const uploaded = await media.upload(
        { buffer: Buffer.from('test'), filename: 'test.txt', mimeType: 'text/plain', folder: 'general' },
        { organizationId: orgId },
      );

      const id = (uploaded as any)._id.toString();

      const tagged = await media.addTags(id, ['important'], { organizationId: orgId });
      expect(tagged.tags).toContain('important');
    });

    it('should not throw when required=false and no organizationId', async () => {
      const media = createOptionalTenantMedia();

      const uploaded = await media.upload(
        { buffer: Buffer.from('test'), filename: 'test.txt', mimeType: 'text/plain', folder: 'general' },
      );

      const id = (uploaded as any)._id.toString();

      // Should work — optional mode doesn't require tenant
      const tagged = await media.addTags(id, ['tag1']);
      expect(tagged.tags).toContain('tag1');
    });
  });

  // ============================================
  // REMOVETAGS — direct Model operation via _buildQueryFilters
  // ============================================

  describe('removeTags (_buildQueryFilters path)', () => {
    it('should throw when required=true and no organizationId', async () => {
      const media = createRequiredTenantMedia();
      const orgId = new mongoose.Types.ObjectId();

      const uploaded = await media.upload(
        { buffer: Buffer.from('test'), filename: 'test.txt', mimeType: 'text/plain', folder: 'general', tags: ['a'] },
        { organizationId: orgId },
      );

      const id = (uploaded as any)._id.toString();

      await expect(
        media.removeTags(id, ['a'])
      ).rejects.toThrow(/organizationId.*missing/i);
    });

    it('should succeed when required=true and organizationId is provided', async () => {
      const media = createRequiredTenantMedia();
      const orgId = new mongoose.Types.ObjectId();

      const uploaded = await media.upload(
        { buffer: Buffer.from('test'), filename: 'test.txt', mimeType: 'text/plain', folder: 'general', tags: ['a', 'b'] },
        { organizationId: orgId },
      );

      const id = (uploaded as any)._id.toString();

      const result = await media.removeTags(id, ['a'], { organizationId: orgId });
      expect(result.tags).not.toContain('a');
      expect(result.tags).toContain('b');
    });
  });

  // ============================================
  // MOVE — direct Model operation via _buildQueryFilters
  // ============================================

  describe('move (_buildQueryFilters path)', () => {
    it('should throw when required=true and no organizationId', async () => {
      const media = createRequiredTenantMedia();
      const orgId = new mongoose.Types.ObjectId();

      const uploaded = await media.upload(
        { buffer: Buffer.from('test'), filename: 'test.txt', mimeType: 'text/plain', folder: 'inbox' },
        { organizationId: orgId },
      );

      const id = (uploaded as any)._id.toString();

      await expect(
        media.move([id], 'archive')
      ).rejects.toThrow(/organizationId.*missing/i);
    });

    it('should succeed when required=true and organizationId is provided', async () => {
      const media = createRequiredTenantMedia();
      const orgId = new mongoose.Types.ObjectId();

      const uploaded = await media.upload(
        { buffer: Buffer.from('test'), filename: 'test.txt', mimeType: 'text/plain', folder: 'inbox' },
        { organizationId: orgId },
      );

      const id = (uploaded as any)._id.toString();

      const result = await media.move([id], 'archive', { organizationId: orgId });
      expect(result.modifiedCount).toBe(1);
    });
  });

  // ============================================
  // RENAMEFOLDER — direct Model operation via _buildQueryFilters
  // ============================================

  describe('renameFolder (_buildQueryFilters path)', () => {
    it('should throw when required=true and no organizationId', async () => {
      const media = createRequiredTenantMedia();
      const orgId = new mongoose.Types.ObjectId();

      await media.upload(
        { buffer: Buffer.from('test'), filename: 'test.txt', mimeType: 'text/plain', folder: 'old-folder' },
        { organizationId: orgId },
      );

      await expect(
        media.renameFolder('old-folder', 'new-folder')
      ).rejects.toThrow(/organizationId.*missing/i);
    });

    it('should succeed when required=true and organizationId is provided', async () => {
      const media = createRequiredTenantMedia();
      const orgId = new mongoose.Types.ObjectId();

      await media.upload(
        { buffer: Buffer.from('test'), filename: 'test.txt', mimeType: 'text/plain', folder: 'old-folder' },
        { organizationId: orgId },
      );

      const result = await media.renameFolder('old-folder', 'new-folder', { organizationId: orgId });
      expect(result.modifiedCount).toBe(1);
    });
  });

  // ============================================
  // DELETEFOLDER — direct Model operation via _buildQueryFilters
  // ============================================

  describe('deleteFolder (_buildQueryFilters path)', () => {
    it('should throw when required=true and no organizationId', async () => {
      const media = createRequiredTenantMedia();
      const orgId = new mongoose.Types.ObjectId();

      await media.upload(
        { buffer: Buffer.from('test'), filename: 'test.txt', mimeType: 'text/plain', folder: 'to-delete' },
        { organizationId: orgId },
      );

      await expect(
        media.deleteFolder('to-delete')
      ).rejects.toThrow(/organizationId.*missing/i);
    });

    it('should succeed when required=true and organizationId is provided', async () => {
      const media = createRequiredTenantMedia();
      const orgId = new mongoose.Types.ObjectId();

      await media.upload(
        { buffer: Buffer.from('test'), filename: 'test.txt', mimeType: 'text/plain', folder: 'to-delete' },
        { organizationId: orgId },
      );

      const result = await media.deleteFolder('to-delete', { organizationId: orgId });
      expect(result.success.length).toBe(1);
      expect(result.failed.length).toBe(0);
    });
  });

  // ============================================
  // GETFOLDERSTATS — direct Model aggregation via _buildQueryFilters
  // ============================================

  describe('getFolderStats (_buildQueryFilters path)', () => {
    it('should throw when required=true and no organizationId', async () => {
      const media = createRequiredTenantMedia();
      const orgId = new mongoose.Types.ObjectId();

      await media.upload(
        { buffer: Buffer.from('test'), filename: 'test.txt', mimeType: 'text/plain', folder: 'general' },
        { organizationId: orgId },
      );

      await expect(
        media.getFolderStats('general')
      ).rejects.toThrow(/organizationId.*missing/i);
    });

    it('should succeed when required=true and organizationId is provided', async () => {
      const media = createRequiredTenantMedia();
      const orgId = new mongoose.Types.ObjectId();

      await media.upload(
        { buffer: Buffer.from('test'), filename: 'test.txt', mimeType: 'text/plain', folder: 'general' },
        { organizationId: orgId },
      );

      const stats = await media.getFolderStats('general', { organizationId: orgId });
      expect(stats.totalFiles).toBe(1);
    });
  });

  // ============================================
  // CROSS-TENANT ISOLATION
  // ============================================

  describe('cross-tenant isolation', () => {
    it('should not allow org1 to see org2 files via addTags', async () => {
      const media = createRequiredTenantMedia();
      const org1 = new mongoose.Types.ObjectId();
      const org2 = new mongoose.Types.ObjectId();

      const uploaded = await media.upload(
        { buffer: Buffer.from('secret'), filename: 'secret.txt', mimeType: 'text/plain', folder: 'general' },
        { organizationId: org1 },
      );

      const id = (uploaded as any)._id.toString();

      // org2 tries to tag org1's file → should fail (file not found for that org)
      await expect(
        media.addTags(id, ['hacked'], { organizationId: org2 })
      ).rejects.toThrow(/not found/i);
    });

    it('should not allow org1 to move org2 files', async () => {
      const media = createRequiredTenantMedia();
      const org1 = new mongoose.Types.ObjectId();
      const org2 = new mongoose.Types.ObjectId();

      const uploaded = await media.upload(
        { buffer: Buffer.from('secret'), filename: 'secret.txt', mimeType: 'text/plain', folder: 'inbox' },
        { organizationId: org1 },
      );

      const id = (uploaded as any)._id.toString();

      // org2 tries to move org1's file → should move 0 files
      const result = await media.move([id], 'stolen', { organizationId: org2 });
      expect(result.modifiedCount).toBe(0);
    });

    it('should isolate getAll between tenants', async () => {
      const media = createRequiredTenantMedia();
      const org1 = new mongoose.Types.ObjectId();
      const org2 = new mongoose.Types.ObjectId();

      await media.upload(
        { buffer: Buffer.from('org1-a'), filename: 'a.txt', mimeType: 'text/plain', folder: 'general' },
        { organizationId: org1 },
      );
      await media.upload(
        { buffer: Buffer.from('org1-b'), filename: 'b.txt', mimeType: 'text/plain', folder: 'general' },
        { organizationId: org1 },
      );
      await media.upload(
        { buffer: Buffer.from('org2-a'), filename: 'c.txt', mimeType: 'text/plain', folder: 'general' },
        { organizationId: org2 },
      );

      const org1Files = await media.getAll({}, { organizationId: org1 });
      expect(org1Files.docs).toHaveLength(2);

      const org2Files = await media.getAll({}, { organizationId: org2 });
      expect(org2Files.docs).toHaveLength(1);
    });
  });

  // ============================================
  // REPLACE — uses requireTenant at operation level
  // ============================================

  describe('replace (operation-level requireTenant)', () => {
    it('should throw when required=true and no organizationId', async () => {
      const media = createRequiredTenantMedia();
      const orgId = new mongoose.Types.ObjectId();

      const uploaded = await media.upload(
        { buffer: Buffer.from('original'), filename: 'doc.txt', mimeType: 'text/plain', folder: 'general' },
        { organizationId: orgId },
      );

      const id = (uploaded as any)._id.toString();

      await expect(
        media.replace(id, {
          buffer: Buffer.from('replaced'),
          filename: 'doc-v2.txt',
          mimeType: 'text/plain',
          folder: 'general',
        })
      ).rejects.toThrow(/organizationId.*required/i);
    });
  });

  // ============================================
  // SOFT DELETE — uses mongokit lifecycle (getMediaById + updateMedia)
  // ============================================

  describe('softDelete (mongokit lifecycle path)', () => {
    it('should throw when required=true and no organizationId on getMediaById', async () => {
      const media = createRequiredTenantMedia();
      const orgId = new mongoose.Types.ObjectId();

      const uploaded = await media.upload(
        { buffer: Buffer.from('test'), filename: 'test.txt', mimeType: 'text/plain', folder: 'general' },
        { organizationId: orgId },
      );

      const id = (uploaded as any)._id.toString();

      // softDelete calls getMediaById via mongokit lifecycle → should throw
      await expect(
        media.softDelete(id)
      ).rejects.toThrow();
    });

    it('should succeed when required=true and organizationId is provided', async () => {
      const media = createRequiredTenantMedia();
      const orgId = new mongoose.Types.ObjectId();

      const uploaded = await media.upload(
        { buffer: Buffer.from('test'), filename: 'test.txt', mimeType: 'text/plain', folder: 'general' },
        { organizationId: orgId },
      );

      const id = (uploaded as any)._id.toString();

      const result = await media.softDelete(id, { organizationId: orgId });
      expect(result.deletedAt).toBeDefined();
    });
  });
});

// ============================================
// EVENT SYSTEM — before:* CANNOT veto operations
// ============================================

describe('Event System: before:* hooks cannot veto', () => {
  let driver: MemoryStorageDriver;

  beforeAll(async () => {
    // Reuse existing connection if available
    if (mongoose.connection.readyState !== 1) {
      await mongoose.connect('mongodb://localhost:27017/mediakit-multitenant-test');
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

  it('should proceed with upload even when before:upload listener throws', async () => {
    const media = createMedia({
      driver,
      processing: { enabled: false },
      suppressWarnings: true,
    });

    const Model = mongoose.model('Test', media.schema);
    media.init(Model);

    // Register a before:upload hook that throws
    media.on('before:upload', () => {
      throw new Error('VETOED!');
    });

    // Upload should still succeed — before hooks use Promise.allSettled
    const uploaded = await media.upload({
      buffer: Buffer.from('test'),
      filename: 'test.txt',
      mimeType: 'text/plain',
      folder: 'general',
    });

    expect(uploaded).toBeDefined();
    expect(uploaded.status).toBe('ready');
  });

  it('should proceed with upload even when before:upload listener rejects async', async () => {
    const media = createMedia({
      driver,
      processing: { enabled: false },
      suppressWarnings: true,
    });

    const Model = mongoose.model('Test', media.schema);
    media.init(Model);

    // Register an async before:upload hook that rejects
    media.on('before:upload', async () => {
      await new Promise(resolve => setTimeout(resolve, 10));
      throw new Error('ASYNC VETO!');
    });

    const uploaded = await media.upload({
      buffer: Buffer.from('test'),
      filename: 'test.txt',
      mimeType: 'text/plain',
      folder: 'general',
    });

    expect(uploaded).toBeDefined();
    expect(uploaded.status).toBe('ready');
  });

  it('should proceed with move even when before:move listener throws', async () => {
    const media = createMedia({
      driver,
      processing: { enabled: false },
      suppressWarnings: true,
    });

    const Model = mongoose.model('Test', media.schema);
    media.init(Model);

    const uploaded = await media.upload({
      buffer: Buffer.from('test'),
      filename: 'test.txt',
      mimeType: 'text/plain',
      folder: 'inbox',
    });

    media.on('before:move', () => {
      throw new Error('MOVE VETOED!');
    });

    const id = (uploaded as any)._id.toString();
    const result = await media.move([id], 'archive');

    expect(result.modifiedCount).toBe(1);
  });
});
