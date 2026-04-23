/**
 * Event creation helper.
 *
 * Thin wrapper around `@classytic/primitives`' `createEvent` that fills the
 * shared `EventMeta` from a `MediaContext` (userId, organizationId, correlationId).
 */

import { createEvent as createPrimitiveEvent } from '@classytic/primitives/events';
import type { DomainEvent, EventMeta } from '@classytic/primitives/events';
import type { MediaContext } from '../engine/engine-types.js';

export function createMediaEvent<T>(
  type: string,
  payload: T,
  ctx?: MediaContext,
  meta?: Partial<EventMeta>,
): DomainEvent<T> {
  return createPrimitiveEvent<T>(type, payload, {
    ...(ctx?.userId !== undefined ? { userId: String(ctx.userId) } : {}),
    ...(ctx?.organizationId !== undefined
      ? { organizationId: String(ctx.organizationId) }
      : {}),
    ...(ctx?.correlationId !== undefined ? { correlationId: ctx.correlationId } : {}),
    ...meta,
  });
}
