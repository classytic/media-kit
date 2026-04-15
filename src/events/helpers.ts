/**
 * Event creation helper.
 *
 * Fills in meta.id (uuid), meta.timestamp (now), and optional fields
 * (userId, organizationId, correlationId) from the media context.
 */

import type { DomainEvent } from './transport.js';
import type { MediaContext } from '../engine/engine-types.js';

export function createMediaEvent<T>(
  type: string,
  payload: T,
  ctx?: MediaContext,
  meta?: Partial<DomainEvent['meta']>,
): DomainEvent<T> {
  return {
    type,
    payload,
    meta: {
      id: crypto.randomUUID(),
      timestamp: new Date(),
      userId: ctx?.userId ? String(ctx.userId) : undefined,
      organizationId: ctx?.organizationId ? String(ctx.organizationId) : undefined,
      correlationId: ctx?.correlationId,
      ...meta,
    },
  };
}
