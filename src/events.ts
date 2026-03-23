/**
 * Awaitable Event System
 *
 * Events are awaitable — emit() returns a Promise that resolves
 * after all listeners have completed. Uses Promise.allSettled()
 * so one failing listener doesn't block others.
 *
 * @example
 * ```ts
 * const emitter = new MediaEventEmitter(logger);
 *
 * // Register listener (returns unsubscribe function)
 * const unsub = emitter.on('after:upload', async (event) => {
 *   await sendNotification(event.result);
 * });
 *
 * // Emit and await all listeners
 * await emitter.emit('after:upload', payload);
 *
 * // Unsubscribe
 * unsub();
 * ```
 */

import type {
  MediaEventName,
  EventListener,
  Unsubscribe,
  MediaKitLogger,
} from './types';

/**
 * Awaitable media event emitter
 */
export class MediaEventEmitter {
  private listeners: Map<MediaEventName, EventListener[]> = new Map();
  private logger?: MediaKitLogger;

  constructor(logger?: MediaKitLogger) {
    this.logger = logger;
  }

  /**
   * Register an event listener.
   * Returns an unsubscribe function.
   */
  on<T = unknown>(event: MediaEventName, listener: EventListener<T>): Unsubscribe {
    const list = this.listeners.get(event) || [];
    list.push(listener as EventListener);
    this.listeners.set(event, list);

    // Return unsubscribe function
    return () => {
      const current = this.listeners.get(event);
      if (current) {
        const idx = current.indexOf(listener as EventListener);
        if (idx !== -1) {
          current.splice(idx, 1);
        }
      }
    };
  }

  /**
   * Emit an event and await all listeners.
   * Uses Promise.allSettled so one failure doesn't block others.
   */
  async emit<T = unknown>(event: MediaEventName, payload: T): Promise<void> {
    const list = this.listeners.get(event);
    if (!list || list.length === 0) return;

    const results = await Promise.allSettled(
      list.map(listener => {
        try {
          return Promise.resolve(listener(payload));
        } catch (err) {
          return Promise.reject(err);
        }
      })
    );

    // Log any listener errors
    for (const result of results) {
      if (result.status === 'rejected') {
        this.logger?.error(`Event listener error [${event}]`, {
          error: (result.reason as Error)?.message || String(result.reason),
        });
      }
    }
  }

  /**
   * Remove all listeners for a specific event, or all events if no event given.
   */
  removeAllListeners(event?: MediaEventName): void {
    if (event) {
      this.listeners.delete(event);
    } else {
      this.listeners.clear();
    }
  }

  /**
   * Get the count of listeners for an event.
   */
  listenerCount(event: MediaEventName): number {
    return this.listeners.get(event)?.length || 0;
  }
}
