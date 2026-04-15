/**
 * Shared dependency interface for legacy operation functions.
 *
 * v3 internal: these operation files are implementation details.
 * The new MediaRepository passes a shim for `events` (no-op emitter)
 * so operation files can run unchanged.
 */

import type {
  MediaKitConfig,
  StorageDriver,
  MediaKitLogger,
  ImageAdapter,
} from '../types.js';
import type { MediaRepository } from '../repositories/media.repository.js';
import type { ImageProcessor } from '../processing/image.js';
import type { Semaphore } from '../utils/semaphore.js';

/**
 * Minimal event emitter shim used internally by operation files.
 * Matches the old MediaEventEmitter shape — repository provides a no-op.
 */
export interface InternalEventEmitter {
  emit(event: string, payload: unknown): Promise<void>;
  on(event: string, listener: (payload: unknown) => void | Promise<void>): () => void;
  removeAllListeners(event?: string): void;
  listenerCount(event: string): number;
}

export interface OperationDeps {
  readonly config: MediaKitConfig;
  readonly driver: StorageDriver;
  readonly repository: MediaRepository;
  readonly processor: ImageProcessor | ImageAdapter | null;
  readonly processorReady: Promise<void> | null;
  readonly events: InternalEventEmitter;
  readonly uploadSemaphore: Semaphore;
  readonly logger?: MediaKitLogger;
}

export type ConfigOnlyDeps = Pick<OperationDeps, 'config'>;
