/**
 * Shared dependency interface for all operation functions.
 * Created once by MediaKitImpl and passed to all operations.
 */

import type {
  MediaKitConfig,
  StorageDriver,
  MediaKitLogger,
  ImageAdapter,
} from '../types';
import type { MediaRepository } from '../repository/media.repository';
import type { ImageProcessor } from '../processing/image';
import type { MediaEventEmitter } from '../events';
import type { Semaphore } from '../utils/semaphore';

export interface OperationDeps {
  readonly config: MediaKitConfig;
  readonly driver: StorageDriver;
  readonly repository: MediaRepository;
  readonly processor: ImageProcessor | ImageAdapter | null;
  readonly processorReady: Promise<void> | null;
  readonly events: MediaEventEmitter;
  readonly uploadSemaphore: Semaphore;
  readonly logger?: MediaKitLogger;
}

/**
 * Minimal deps subset for config-only helpers (validateFile, getContentType).
 * These helpers never touch storage, repository, or events.
 */
export type ConfigOnlyDeps = Pick<OperationDeps, 'config'>;
