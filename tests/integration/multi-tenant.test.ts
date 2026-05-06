/**
 * Integration tests — Multi-tenancy with both fieldType modes
 *
 * Verifies that:
 *   - fieldType: 'string' — tenantId stored as raw string
 *   - fieldType: 'objectId' — tenantId cast to ObjectId, enabling $lookup/.populate()
 *   - Cross-tenant isolation enforced by multiTenantPlugin
 *   - Both modes work end-to-end for CRUD
 */

import { describe, it, expect, afterAll, beforeEach, afterEach } from 'vitest';
import { Types } from 'mongoose';
import { createTestEngine, teardownTestMongo, type TestEngineHandle } from '../helpers/create-test-engine.js';

const BUF = (s: string) => Buffer.from(s, 'utf-8');
const ORG_HEX = '507f1f77bcf86cd799439011';
const OTHER_ORG_HEX = '507f1f77bcf86cd799439012';

describe('MediaRepository — multi-tenancy', () => {
  afterAll(async () => {
    await teardownTestMongo();
  });

  describe('fieldType: "string" (default)', () => {
    let handle: TestEngineHandle;

    beforeEach(async () => {
      handle = await createTestEngine({
        tenant: { enabled: true, fieldType: 'string', tenantField: 'organizationId', required: true },
      });
    });

    afterEach(async () => {
      await handle.cleanup();
    });

    it('stores organizationId as string', async () => {
      const media = await handle.engine.repositories.media.upload(
        { buffer: BUF('x'), filename: 'x.txt', mimeType: 'text/plain' },
        { organizationId: ORG_HEX } as any,
      );
      const raw = await handle.engine.models.Media.findById(media._id).lean();
      expect(typeof raw!.organizationId).toBe('string');
      expect(raw!.organizationId).toBe(ORG_HEX);
    });

    it('scopes queries by tenant (cross-tenant isolation)', async () => {
      await handle.engine.repositories.media.upload(
        { buffer: BUF('a'), filename: 'a.txt', mimeType: 'text/plain' },
        { organizationId: ORG_HEX } as any,
      );
      await handle.engine.repositories.media.upload(
        { buffer: BUF('b'), filename: 'b.txt', mimeType: 'text/plain' },
        { organizationId: OTHER_ORG_HEX } as any,
      );

      const orgA = await handle.engine.repositories.media.getAll(
        { page: 1, limit: 10 },
        { organizationId: ORG_HEX } as any,
      );
      const orgB = await handle.engine.repositories.media.getAll(
        { page: 1, limit: 10 },
        { organizationId: OTHER_ORG_HEX } as any,
      );

      expect((orgA as any).data).toHaveLength(1);
      expect((orgB as any).data).toHaveLength(1);
      expect((orgA as any).data[0].filename).toBe('a.txt');
      expect((orgB as any).data[0].filename).toBe('b.txt');
    });

    it('throws when required tenant is missing', async () => {
      await expect(
        handle.engine.repositories.media.upload({
          buffer: BUF('x'),
          filename: 'x.txt',
          mimeType: 'text/plain',
        }),
      ).rejects.toThrow(/organizationId/i);
    });
  });

  describe('fieldType: "objectId"', () => {
    let handle: TestEngineHandle;

    beforeEach(async () => {
      handle = await createTestEngine({
        tenant: {
          enabled: true,
          fieldType: 'objectId',
          tenantField: 'organizationId',
          ref: 'Organization',
          required: true,
        },
      });
    });

    afterEach(async () => {
      await handle.cleanup();
    });

    it('casts organizationId to ObjectId before storing', async () => {
      const media = await handle.engine.repositories.media.upload(
        { buffer: BUF('x'), filename: 'x.txt', mimeType: 'text/plain' },
        { organizationId: ORG_HEX } as any,
      );
      const raw = await handle.engine.models.Media.findById(media._id).lean();
      expect(raw!.organizationId).toBeInstanceOf(Types.ObjectId);
      expect((raw!.organizationId as any).toString()).toBe(ORG_HEX);
    });

    it('scopes queries by tenant with ObjectId cast', async () => {
      await handle.engine.repositories.media.upload(
        { buffer: BUF('a'), filename: 'a.txt', mimeType: 'text/plain' },
        { organizationId: ORG_HEX } as any,
      );
      await handle.engine.repositories.media.upload(
        { buffer: BUF('b'), filename: 'b.txt', mimeType: 'text/plain' },
        { organizationId: OTHER_ORG_HEX } as any,
      );

      const orgA = await handle.engine.repositories.media.getAll(
        { page: 1, limit: 10 },
        { organizationId: ORG_HEX } as any,
      );
      expect((orgA as any).data).toHaveLength(1);
      expect((orgA as any).data[0].filename).toBe('a.txt');
    });

    it('schema declares ref: Organization for populate compatibility', async () => {
      const path = handle.engine.models.Media.schema.path('organizationId') as any;
      expect(path?.options?.ref).toBe('Organization');
    });

    it('prevents cross-tenant hard delete', async () => {
      const media = await handle.engine.repositories.media.upload(
        { buffer: BUF('a'), filename: 'a.txt', mimeType: 'text/plain' },
        { organizationId: ORG_HEX } as any,
      );

      // Different org tries to delete — should fail (not found due to tenant scoping)
      const result = await handle.engine.repositories.media.hardDelete(
        String(media._id),
        { organizationId: OTHER_ORG_HEX } as any,
      );
      expect(result).toBe(false);

      // Verify still exists
      const stillThere = await handle.engine.models.Media.findById(media._id);
      expect(stillThere).toBeTruthy();
    });
  });
});
