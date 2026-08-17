/**
 * In-process event bus — default fallback when no arc transport is provided.
 *
 * A THIN subclass of `@classytic/primitives`' shared `InProcessEventBus`
 * (`/event-infra`, primitives >=0.14) — the single reference runtime that
 * replaced the ~26 drifted per-kernel `in-process-bus.ts` copies. media-kit
 * keeps the public class name `InProcessMediaBus` so nothing in its API
 * surface changes; only the implementation is now shared. Structurally
 * identical to arc's `MemoryEventTransport` (glob match via `matchEventPattern`,
 * per-handler error isolation, idempotent `close()`).
 */

import { InProcessEventBus } from '@classytic/primitives/event-infra';
import type { MediaKitLogger } from '../types/config.js';

export class InProcessMediaBus extends InProcessEventBus {
  constructor(options?: { logger?: MediaKitLogger }) {
    super({
      name: 'in-process-media',
      logLabel: 'media-kit',
      // Preserve media-kit's historical default: no logger → swallow handler
      // errors silently (event emission never propagates OR logs). A supplied
      // MediaKitLogger satisfies the shared bus's ErrorLogger contract.
      logger: options?.logger ?? null,
    });
  }
}
