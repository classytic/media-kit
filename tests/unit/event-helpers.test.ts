/**
 * Unit tests — createMediaEvent helper
 */

import { describe, it, expect } from 'vitest';
import { createMediaEvent } from '../../src/events/helpers.js';
import { Types } from 'mongoose';

describe('createMediaEvent', () => {
  it('fills in meta.id and timestamp automatically', () => {
    const event = createMediaEvent('media:asset.uploaded', { assetId: 'a1' });
    expect(event.meta.id).toBeTruthy();
    expect(event.meta.timestamp).toBeInstanceOf(Date);
  });

  it('fills userId and organizationId from context (string form)', () => {
    const event = createMediaEvent(
      'media:asset.uploaded',
      { assetId: 'a1' },
      { userId: 'user_123', organizationId: 'org_456', correlationId: 'trace_abc' },
    );
    expect(event.meta.userId).toBe('user_123');
    expect(event.meta.organizationId).toBe('org_456');
    expect(event.meta.correlationId).toBe('trace_abc');
  });

  it('coerces ObjectId userId/organizationId to string', () => {
    const oid1 = new Types.ObjectId();
    const oid2 = new Types.ObjectId();
    const event = createMediaEvent(
      'media:asset.uploaded',
      { assetId: 'a1' },
      { userId: oid1, organizationId: oid2 },
    );
    expect(event.meta.userId).toBe(oid1.toString());
    expect(event.meta.organizationId).toBe(oid2.toString());
  });

  it('allows meta override via last arg', () => {
    const event = createMediaEvent(
      'media:asset.uploaded',
      { assetId: 'a1' },
      {},
      { resource: 'media', resourceId: 'a1' },
    );
    expect(event.meta.resource).toBe('media');
    expect(event.meta.resourceId).toBe('a1');
  });

  it('preserves payload shape', () => {
    const payload = { assetId: 'a1', size: 1024, tags: ['foo', 'bar'] };
    const event = createMediaEvent('media:asset.uploaded', payload);
    expect(event.payload).toEqual(payload);
    expect(event.type).toBe('media:asset.uploaded');
  });

  it('generates unique ids for each event', () => {
    const e1 = createMediaEvent('x', {});
    const e2 = createMediaEvent('x', {});
    expect(e1.meta.id).not.toBe(e2.meta.id);
  });
});
