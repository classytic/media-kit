/** Internal legacy operation event envelopes. Not part of the public package contract. */

import type { OperationContext } from '../types/uploads.js';

export type LegacyProgressEventName = 'progress:move' | 'progress:rename';

/** Event context for before hooks (dependency of {@link EventError}). */
interface EventContext<T = unknown> {
  /** Operation input data */
  data: T;
  /** Operation context (user, org, etc.) */
  context?: OperationContext;
  /** Timestamp */
  timestamp: Date;
}

/**
 * Event error for error hooks — the one legacy envelope still consumed
 * (by the presigned operations error path).
 */
export interface EventError<T = unknown> {
  /** Original context */
  context: EventContext<T>;
  /** Error that occurred */
  error: Error;
  /** Timestamp */
  timestamp: Date;
}
