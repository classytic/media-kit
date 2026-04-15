/**
 * createMedia — Engine factory for @classytic/media-kit v3.
 *
 * Flow:
 *   1. Validate config with Zod
 *   2. Merge with defaults
 *   3. Create Mongoose model (internal, on connection)
 *   4. Compose plugin stack
 *   5. Resolve event transport (or default to in-process bus)
 *   6. Create MediaRepository
 *   7. Return frozen MediaEngine
 *
 * @example
 * ```typescript
 * import { createMedia } from '@classytic/media-kit';
 * import { S3Provider } from '@classytic/media-kit/providers/s3';
 * import mongoose from 'mongoose';
 *
 * const engine = await createMedia({
 *   connection: mongoose.connection,
 *   driver: new S3Provider({ bucket, region }),
 *   tenantFieldType: 'objectId',
 *   multiTenancy: { enabled: true, required: true },
 *   processing: { enabled: true, format: 'webp', quality: 80 },
 * });
 *
 * const media = await engine.repositories.media.upload(input, ctx);
 *
 * engine.events.subscribe('media:asset.*', async (event) => {
 *   console.log(event.type, event.payload);
 * });
 * ```
 */

import type { MediaConfig, MediaEngine, ResolvedMediaConfig } from './engine-types.js';
import type { EventTransport } from '../events/transport.js';
import type { ImageAdapter } from '../types.js';
import { InProcessMediaBus } from '../events/in-process-bus.js';
import { createMediaModels } from '../models/create-models.js';
import { createMediaRepositories } from '../repositories/create-repositories.js';
import { ImageProcessor } from '../processing/image.js';
import { mergeConfig } from '../config.js';

export async function createMedia(config: MediaConfig): Promise<MediaEngine> {
  // Validate required fields
  if (!config.connection) {
    throw new Error('[media-kit] MediaConfig.connection is required');
  }
  if (!config.driver) {
    throw new Error('[media-kit] MediaConfig.driver is required');
  }

  // Resolve defaults (reuses v2 mergeConfig)
  const resolved = mergeConfig(config as any) as unknown as ResolvedMediaConfig;
  resolved.connection = config.connection;
  resolved.tenantFieldType = config.tenantFieldType ?? 'string';
  resolved.schemaOptions = config.schemaOptions;

  // Resolve event transport (default: in-process bus)
  const events: EventTransport = config.eventTransport ?? new InProcessMediaBus({ logger: config.logger });

  // Initialize image processor
  let processor: ImageProcessor | ImageAdapter | null = null;
  let processorReady: Promise<void> | null = null;

  if (resolved.processing?.imageAdapter) {
    processor = resolved.processing.imageAdapter;
    processorReady = Promise.resolve();
  } else if (resolved.processing?.enabled) {
    const sharpOptions = resolved.processing?.sharpOptions;
    const sharpProcessor = new ImageProcessor({
      concurrency: sharpOptions?.concurrency ?? 2,
      cache: sharpOptions?.cache ?? false,
    });
    processor = sharpProcessor;

    processorReady = sharpProcessor.waitUntilReady().then((available) => {
      if (!available) {
        processor = null;
        if (!resolved.suppressWarnings) {
          config.logger?.warn?.(
            'Image processing disabled: sharp not available. Install with: npm install sharp',
          );
        }
      }
    }).catch(() => {
      processor = null;
      if (!resolved.suppressWarnings) {
        config.logger?.warn?.(
          'Image processing disabled: sharp not available. Install with: npm install sharp',
        );
      }
    });
  } else {
    processorReady = Promise.resolve();
  }

  // Create Mongoose models (purges stale cached models first)
  const models = createMediaModels(config.connection, resolved);

  // Resolve bridges (frozen, passed through to repo)
  const bridges = Object.freeze({ ...(config.bridges ?? {}) });

  // Create repositories
  const repositories = createMediaRepositories(models, {
    events,
    config: resolved,
    driver: config.driver,
    processor,
    processorReady,
    logger: config.logger,
    bridges,
  });

  // Build and freeze engine
  const engine: MediaEngine = Object.freeze({
    repositories: Object.freeze({
      media: repositories.media,
    }),
    events,
    models: Object.freeze({
      Media: models.Media,
    }),
    config: Object.freeze(resolved),
    driver: config.driver,
    bridges,
    async dispose(): Promise<void> {
      await events.close?.();
    },
  });

  return engine;
}

export default createMedia;
