/**
 * Repository Factory — composes plugins and creates repositories.
 */

import {
  multiTenantPlugin,
  softDeletePlugin,
  methodRegistryPlugin,
  aggregateHelpersPlugin,
  cachePlugin,
  type PluginType,
} from '@classytic/mongokit';
import type { StorageDriver, ImageAdapter, MediaKitLogger } from '../types.js';
import type { EventTransport } from '../events/transport.js';
import type { ResolvedMediaConfig } from '../engine/engine-types.js';
import type { MediaBridges } from '../bridges/types.js';
import type { MediaModels } from '../models/create-models.js';
import type { ImageProcessor } from '../processing/image.js';
import { MediaRepository } from './media.repository.js';

export interface MediaRepositories {
  media: MediaRepository;
}

export interface CreateRepositoriesDeps {
  events: EventTransport;
  config: ResolvedMediaConfig;
  driver: StorageDriver;
  processor?: ImageProcessor | ImageAdapter | null;
  processorReady?: Promise<void> | null;
  logger?: MediaKitLogger;
  bridges?: MediaBridges;
}

export function createMediaRepositories(
  models: MediaModels,
  deps: CreateRepositoriesDeps,
): MediaRepositories {
  const plugins: PluginType[] = [
    // Method registry first (required by other plugins)
    methodRegistryPlugin(),
  ];

  // Multi-tenant plugin
  if (deps.config.multiTenancy?.enabled) {
    plugins.push(
      multiTenantPlugin({
        tenantField: deps.config.multiTenancy.field || 'organizationId',
        contextKey: 'organizationId',
        required: deps.config.multiTenancy.required ?? false,
        fieldType: deps.config.tenantFieldType ?? 'string',
      }),
    );
  }

  // Soft delete plugin
  if (deps.config.softDelete?.enabled) {
    plugins.push(
      softDeletePlugin({
        deletedField: 'deletedAt',
        ttlDays: deps.config.softDelete.ttlDays,
      }),
    );
  }

  // Aggregate helpers
  plugins.push(aggregateHelpersPlugin());

  // Cache plugin
  if (deps.config.cache?.adapter) {
    plugins.push(
      cachePlugin({
        adapter: deps.config.cache.adapter,
        ttl: deps.config.cache.byIdTtl,
        keyPrefix: deps.config.cache.prefix ?? 'mk',
      } as any),
    );
  }

  // User-supplied plugins (appended)
  if (deps.config.plugins && deps.config.plugins.length > 0) {
    plugins.push(...deps.config.plugins);
  }

  const media = new MediaRepository(
    models.Media,
    plugins,
    {
      events: deps.events,
      config: deps.config,
      driver: deps.driver,
      processor: deps.processor ?? null,
      processorReady: deps.processorReady ?? null,
      logger: deps.logger,
      bridges: deps.bridges ?? {},
    },
    deps.config.pagination,
  );

  return { media };
}
