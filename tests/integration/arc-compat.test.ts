/**
 * Integration tests — Arc EventTransport compatibility
 *
 * Verifies that any structurally-compatible transport drops in:
 *   - Custom transport replaces the in-process bus
 *   - Events flow through the custom transport
 *   - Glob subscription patterns work
 *   - Cross-package event fan-out (cascade scenario) works
 *     e.g., product.deleted → media cleanup
 */

import { describe, it, expect, afterAll, beforeEach, afterEach, vi } from 'vitest';
import type { DomainEvent, EventHandler, EventTransport } from '../../src/events/transport.js';
import { createTestEngine, teardownTestMongo, type TestEngineHandle } from '../helpers/create-test-engine.js';
import { MEDIA_EVENTS } from '../../src/events/event-constants.js';

const BUF = (s: string) => Buffer.from(s, 'utf-8');

/**
 * Minimal arc-like transport used to verify structural compat.
 * Same shape as @classytic/arc MemoryEventTransport but locally-defined.
 */
class FakeArcTransport implements EventTransport {
  readonly name = 'fake-arc-memory';
  private subs: Array<{ pattern: string; handler: EventHandler }> = [];
  published: DomainEvent[] = [];

  async publish(event: DomainEvent): Promise<void> {
    this.published.push(event);
    for (const { pattern, handler } of this.subs) {
      if (this._matches(pattern, event.type)) {
        try {
          await handler(event);
        } catch {
          // swallow
        }
      }
    }
  }

  async subscribe(pattern: string, handler: EventHandler): Promise<() => void> {
    const sub = { pattern, handler };
    this.subs.push(sub);
    return () => {
      this.subs = this.subs.filter((s) => s !== sub);
    };
  }

  async close(): Promise<void> {
    this.subs = [];
  }

  private _matches(pattern: string, type: string): boolean {
    if (pattern === '*' || pattern === type) return true;
    if (pattern.endsWith('.*')) {
      const prefix = pattern.slice(0, -2);
      return type === prefix || type.startsWith(`${prefix}.`);
    }
    return false;
  }
}

describe('Arc EventTransport compatibility', () => {
  afterAll(async () => {
    await teardownTestMongo();
  });

  let handle: TestEngineHandle;
  let transport: FakeArcTransport;

  beforeEach(async () => {
    transport = new FakeArcTransport();
    handle = await createTestEngine({ eventTransport: transport });
  });

  afterEach(async () => {
    await handle.cleanup();
  });

  describe('drop-in transport', () => {
    it('engine uses the custom transport', async () => {
      expect(handle.engine.events).toBe(transport);
      expect(handle.engine.events.name).toBe('fake-arc-memory');
    });

    it('events flow through the custom transport', async () => {
      await handle.engine.repositories.media.upload({
        buffer: BUF('x'), filename: 'x.txt', mimeType: 'text/plain',
      });

      expect(transport.published).toHaveLength(1);
      expect(transport.published[0]!.type).toBe(MEDIA_EVENTS.ASSET_UPLOADED);
    });

    it('supports glob subscribe through the custom transport', async () => {
      const handler = vi.fn();
      await transport.subscribe('media:asset.*', handler);

      const media = await handle.engine.repositories.media.upload({
        buffer: BUF('x'), filename: 'x.txt', mimeType: 'text/plain',
      });
      await handle.engine.repositories.media.hardDelete(String(media._id));

      expect(handler).toHaveBeenCalledTimes(2); // uploaded + deleted
    });
  });

  describe('cross-package cascade scenario', () => {
    it('host can subscribe to media events and cleanup resources', async () => {
      // Simulate: host wants to log storage usage after each upload
      const storageUsageLog: number[] = [];
      await transport.subscribe('media:asset.uploaded', async (event) => {
        const payload = event.payload as { size: number };
        storageUsageLog.push(payload.size);
      });

      await handle.engine.repositories.media.upload({
        buffer: BUF('hello'), filename: 'a.txt', mimeType: 'text/plain',
      });
      await handle.engine.repositories.media.upload({
        buffer: BUF('world!'), filename: 'b.txt', mimeType: 'text/plain',
      });

      expect(storageUsageLog).toEqual([5, 6]);
    });

    it('host can chain events (e.g., cascade delete on upload)', async () => {
      // Simulate: when a product is deleted via another package,
      // we want to cleanup all media tagged with that product.
      // Here we just verify the subscription mechanism works for
      // chained deletes.
      const m1 = await handle.engine.repositories.media.upload({
        buffer: BUF('x'), filename: 'prod-1.jpg', mimeType: 'image/jpeg',
        tags: ['product:abc'],
      });

      // Simulate product.deleted event triggered from another system
      const cleanupTriggered: string[] = [];
      await transport.subscribe('catalog:product.deleted', async (event) => {
        const payload = event.payload as { productId: string };
        const tag = `product:${payload.productId}`;
        const found = await handle.engine.repositories.media.getAll({
          page: 1, limit: 100, filters: { tags: tag },
        });
        for (const doc of (found as any).data) {
          await handle.engine.repositories.media.hardDelete(String(doc._id));
          cleanupTriggered.push(String(doc._id));
        }
      });

      // Publish an external event
      await transport.publish({
        type: 'catalog:product.deleted',
        payload: { productId: 'abc' },
        meta: { id: 'evt-1', timestamp: new Date() },
      });

      expect(cleanupTriggered).toContain(String(m1._id));
      // Verify media was actually deleted
      const remaining = await handle.engine.models.Media.countDocuments({});
      expect(remaining).toBe(0);
    });
  });

  describe('event meta propagation', () => {
    it('propagates userId and organizationId from context to event.meta', async () => {
      const events: DomainEvent[] = [];
      await transport.subscribe('media:asset.*', async (event) => {
        events.push(event);
      });

      await handle.engine.repositories.media.upload(
        { buffer: BUF('x'), filename: 'x.txt', mimeType: 'text/plain' },
        { userId: 'user_42', organizationId: 'org_99', correlationId: 'trace_xyz' } as any,
      );

      expect(events).toHaveLength(1);
      expect(events[0]!.meta.userId).toBe('user_42');
      expect(events[0]!.meta.organizationId).toBe('org_99');
      expect(events[0]!.meta.correlationId).toBe('trace_xyz');
    });

    it('sets resource/resourceId for asset events', async () => {
      const events: DomainEvent[] = [];
      await transport.subscribe('media:asset.uploaded', async (event) => {
        events.push(event);
      });

      const media = await handle.engine.repositories.media.upload({
        buffer: BUF('x'), filename: 'x.txt', mimeType: 'text/plain',
      });

      expect(events[0]!.meta.resource).toBe('media');
      expect(events[0]!.meta.resourceId).toBe(String(media._id));
    });
  });
});
