/**
 * Unit tests — InProcessMediaBus
 *
 * Covers: exact match, wildcard (*), glob (media.*), error isolation,
 * subscribe/unsubscribe, close.
 */

import { describe, it, expect, vi } from 'vitest';
import { InProcessMediaBus } from '../../src/events/in-process-bus.js';
import type { DomainEvent } from '../../src/events/transport.js';

function event(type: string, payload: unknown = {}): DomainEvent {
  return {
    type,
    payload,
    meta: { id: 'test-id', timestamp: new Date() },
  };
}

describe('InProcessMediaBus', () => {
  describe('name', () => {
    it('exposes name "in-process-media"', () => {
      const bus = new InProcessMediaBus();
      expect(bus.name).toBe('in-process-media');
    });
  });

  describe('subscribe / publish — exact match', () => {
    it('invokes handler for exact event type', async () => {
      const bus = new InProcessMediaBus();
      const handler = vi.fn();
      await bus.subscribe('media:asset.uploaded', handler);
      await bus.publish(event('media:asset.uploaded'));
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('does not invoke handler for different event type', async () => {
      const bus = new InProcessMediaBus();
      const handler = vi.fn();
      await bus.subscribe('media:asset.uploaded', handler);
      await bus.publish(event('media:asset.deleted'));
      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe('subscribe / publish — wildcard (*)', () => {
    it('invokes handler for all events when pattern is "*"', async () => {
      const bus = new InProcessMediaBus();
      const handler = vi.fn();
      await bus.subscribe('*', handler);
      await bus.publish(event('media:asset.uploaded'));
      await bus.publish(event('media:folder.renamed'));
      expect(handler).toHaveBeenCalledTimes(2);
    });
  });

  describe('subscribe / publish — glob (media.*)', () => {
    it('invokes handler for all media: events via media:*', async () => {
      const bus = new InProcessMediaBus();
      const handler = vi.fn();
      await bus.subscribe('media:asset.*', handler);
      await bus.publish(event('media:asset.uploaded'));
      await bus.publish(event('media:asset.deleted'));
      await bus.publish(event('media:folder.renamed'));
      expect(handler).toHaveBeenCalledTimes(2);
    });

    it('supports nested glob patterns', async () => {
      const bus = new InProcessMediaBus();
      const handler = vi.fn();
      await bus.subscribe('media:*', handler);
      await bus.publish(event('media:asset.uploaded'));
      await bus.publish(event('media:folder.renamed'));
      expect(handler).toHaveBeenCalledTimes(2);
    });

    it('does not match different prefix', async () => {
      const bus = new InProcessMediaBus();
      const handler = vi.fn();
      await bus.subscribe('media:asset.*', handler);
      await bus.publish(event('media:folder.deleted'));
      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe('error isolation', () => {
    it('continues calling other handlers when one throws', async () => {
      const bus = new InProcessMediaBus();
      const goodHandler = vi.fn();
      const badHandler = vi.fn(() => {
        throw new Error('boom');
      });
      const goodHandler2 = vi.fn();
      await bus.subscribe('*', goodHandler);
      await bus.subscribe('*', badHandler);
      await bus.subscribe('*', goodHandler2);

      await bus.publish(event('media:asset.uploaded'));

      expect(goodHandler).toHaveBeenCalledTimes(1);
      expect(badHandler).toHaveBeenCalledTimes(1);
      expect(goodHandler2).toHaveBeenCalledTimes(1);
    });

    it('does not propagate handler errors to caller', async () => {
      const bus = new InProcessMediaBus();
      await bus.subscribe('*', () => {
        throw new Error('handler error');
      });
      await expect(bus.publish(event('x:y.z'))).resolves.not.toThrow();
    });
  });

  describe('unsubscribe', () => {
    it('stops delivering events to unsubscribed handler', async () => {
      const bus = new InProcessMediaBus();
      const handler = vi.fn();
      const unsub = await bus.subscribe('*', handler);

      await bus.publish(event('media:asset.uploaded'));
      expect(handler).toHaveBeenCalledTimes(1);

      unsub();
      await bus.publish(event('media:asset.uploaded'));
      expect(handler).toHaveBeenCalledTimes(1);
    });
  });

  describe('close', () => {
    it('clears all subscriptions', async () => {
      const bus = new InProcessMediaBus();
      const handler = vi.fn();
      await bus.subscribe('*', handler);
      await bus.close();
      await bus.publish(event('media:asset.uploaded'));
      expect(handler).not.toHaveBeenCalled();
    });
  });
});
