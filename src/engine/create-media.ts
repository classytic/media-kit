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
 *   tenant: { enabled: true, fieldType: 'objectId', required: true },
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
import type { EventTransport } from '@classytic/primitives/events';
import type { ImageAdapter } from '../types.js';
import { InProcessMediaBus } from '../events/in-process-bus.js';
import { createMediaModels } from '../models/create-models.js';
import { resolveMediaTenant } from '../models/inject-tenant.js';
import { createMediaRepositories } from '../repositories/create-repositories.js';
import { DriverRegistry } from '../providers/driver-registry.js';
import { ImageProcessor } from '../processing/image.js';
import { mergeConfig } from '../config.js';
import { mediaConfigSchema } from '../validators/media-config.schema.js';

export async function createMedia(config: MediaConfig): Promise<MediaEngine> {
  // Validate required fields
  if (!config.connection) {
    throw new Error('[media-kit] MediaConfig.connection is required');
  }

  // Build driver registry from either `driver` (single) or `providers` (multi)
  let registry: DriverRegistry;
  if (config.providers) {
    if (!config.defaultProvider) {
      throw new Error('[media-kit] defaultProvider is required when providers is set');
    }
    registry = new DriverRegistry(config.providers, config.defaultProvider);
  } else if (config.driver) {
    registry = DriverRegistry.fromSingle(config.driver);
  } else {
    throw new Error('[media-kit] Either driver or providers must be specified');
  }

  // Validate the serializable subset of config with Zod. Fail-fast on bad
  // shapes (negative ttlDays, unknown fieldType, etc.) instead of letting
  // them silently drift through `mergeConfig`. We pick only the schema-
  // validated fields — connection/driver/eventTransport/plugins/cache/
  // processing/logger are not serializable and stay untouched.
  const validated = mediaConfigSchema.parse({
    tenant: config.tenant,
    softDelete: config.softDelete,
    fileTypes: config.fileTypes,
    folders: config.folders,
    deduplication: config.deduplication,
    concurrency: config.concurrency,
    schemaOptions: config.schemaOptions,
    suppressWarnings: config.suppressWarnings,
  });

  // Merge validated values back over the original config so non-validated
  // fields (driver, connection, plugins, ...) survive intact. Zod-supplied
  // defaults take precedence over the raw input where overlapping.
  const merged = { ...config, ...validated };

  // Resolve defaults (reuses v2 mergeConfig)
  const resolved = mergeConfig(merged as any) as unknown as ResolvedMediaConfig;
  resolved.connection = config.connection;
  resolved.tenant = resolveMediaTenant(config.tenant);
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
    registry,
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
    registry,
    driver: registry.defaultDriver,
    bridges,
    async dispose(): Promise<void> {
      await events.close?.();
    },
  });

  return engine;
}

export default createMedia;
