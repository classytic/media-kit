/**
 * In-process event bus — default fallback when no arc transport is provided.
 *
 * Structurally identical to arc's MemoryEventTransport. Pattern matching is
 * delegated to `@classytic/primitives`' `matchEventPattern` (exact / `*` /
 * `prefix.*` / `prefix:*`). Handler errors are swallowed — event emission
 * never propagates.
 */

import type {
  DomainEvent,
  EventHandler,
  EventTransport,
} from '@classytic/primitives/events';
import { matchEventPattern } from '@classytic/primitives/events';
import type { MediaKitLogger } from '../types.js';

interface Sub {
  pattern: string;
  handler: EventHandler;
}

export class InProcessMediaBus implements EventTransport {
  readonly name = 'in-process-media';
  private subs: Sub[] = [];
  private logger?: MediaKitLogger;

  constructor(options?: { logger?: MediaKitLogger }) {
    this.logger = options?.logger;
  }

  async publish(event: DomainEvent): Promise<void> {
    const matching = this.subs.filter((s) => matchEventPattern(s.pattern, event.type));
    for (const sub of matching) {
      try {
        await sub.handler(event);
      } catch (err) {
        this.logger?.error?.(`[media-kit] Event handler error [${event.type}]`, {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  async subscribe(pattern: string, handler: EventHandler): Promise<() => void> {
    const sub: Sub = { pattern, handler };
    this.subs.push(sub);
    return () => {
      this.subs = this.subs.filter((s) => s !== sub);
    };
  }

  async close(): Promise<void> {
    this.subs = [];
  }
}
