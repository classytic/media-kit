/**
 * In-process event bus — default fallback when no arc transport is provided.
 *
 * Structurally identical to arc's MemoryEventTransport.
 * ~50 lines. Supports exact, wildcard (*), and glob (media.*) matching.
 * Handler errors are swallowed — event emission never propagates.
 */

import type { DomainEvent, EventHandler, EventTransport } from './transport.js';
import type { MediaKitLogger } from '../types.js';

interface Sub {
  pattern: string;
  handler: EventHandler;
}

function patternMatches(pattern: string, type: string): boolean {
  if (pattern === '*' || pattern === type) return true;
  if (pattern.endsWith('.*')) {
    const prefix = pattern.slice(0, -2);
    return type === prefix || type.startsWith(`${prefix}.`);
  }
  if (pattern.endsWith('*')) {
    return type.startsWith(pattern.slice(0, -1));
  }
  return false;
}

export class InProcessMediaBus implements EventTransport {
  readonly name = 'in-process-media';
  private subs: Sub[] = [];
  private logger?: MediaKitLogger;

  constructor(options?: { logger?: MediaKitLogger }) {
    this.logger = options?.logger;
  }

  async publish(event: DomainEvent): Promise<void> {
    const matching = this.subs.filter((s) => patternMatches(s.pattern, event.type));
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
