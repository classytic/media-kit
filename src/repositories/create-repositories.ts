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
import type { ImageAdapter, MediaKitLogger } from '../types.js';
import type { EventTransport } from '@classytic/primitives/events';
import type { ResolvedMediaConfig } from '../engine/engine-types.js';
import type { DriverRegistry } from '../providers/driver-registry.js';
import type { MediaBridges } from '../bridges/types.js';
import type { MediaModels } from '../models/create-models.js';
import type { ImageProcessor } from '../processing/image.js';
import type { UrlSigner } from '../signing/index.js';
import { MediaRepository } from './media.repository.js';

export interface MediaRepositories {
  media: MediaRepository;
}

export interface CreateRepositoriesDeps {
  events: EventTransport;
  config: ResolvedMediaConfig;
  registry: DriverRegistry;
  processor?: ImageProcessor | ImageAdapter | null;
  processorReady?: Promise<void> | null;
  logger?: MediaKitLogger;
  bridges?: MediaBridges;
  /** Shared HMAC URL signer — constructed by createMedia() from `config.signing`. */
  signing?: UrlSigner;
}

export function createMediaRepositories(models: MediaModels, deps: CreateRepositoriesDeps): MediaRepositories {
  const plugins: PluginType[] = [
    // Method registry first (required by other plugins)
    methodRegistryPlugin(),
  ];

  // Multi-tenant plugin (driven by resolved TenantConfig — P11).
  const { tenant } = deps.config;
  if (tenant.enabled && tenant.strategy === 'field') {
    plugins.push(
      multiTenantPlugin({
        tenantField: tenant.tenantField,
        contextKey: tenant.contextKey,
        required: tenant.required,
        fieldType: tenant.fieldType,
      }),
    );
  }

  // Soft delete plugin. `ttlDays` is only forwarded when the host opted into
  // the Mongo TTL index (`ttlIndex: true`) — mongokit's plugin creates a
  // collection-level TTL index whenever ttlDays > 0, and Mongo's TTL sweeper
  // deletes DOCUMENTS with no hooks, orphaning the storage blob. The
  // supported cleanup path is a purgeDeleted() cron (which still reads
  // config.softDelete.ttlDays for its default cutoff).
  if (deps.config.softDelete?.enabled) {
    plugins.push(
      softDeletePlugin({
        deletedField: 'deletedAt',
        ...(deps.config.softDelete.ttlIndex === true && { ttlDays: deps.config.softDelete.ttlDays }),
      }),
    );
  }

  // Aggregate helpers
  plugins.push(aggregateHelpersPlugin());

  // Cache plugin. MediaCacheConfig's adapter speaks `del` + string values;
  // repo-core's cache plugin speaks `delete` + unknown envelopes — bridge
  // both here so the host-facing config shape stays stable.
  if (deps.config.cache?.adapter) {
    const hostAdapter = deps.config.cache.adapter;
    plugins.push(
      cachePlugin({
        adapter: {
          get: async (key: string) => {
            const raw = await hostAdapter.get(key);
            if (raw === null || raw === undefined) return undefined;
            try {
              return JSON.parse(raw);
            } catch {
              return undefined;
            }
          },
          set: async (key: string, value: unknown, ttlSeconds?: number) =>
            hostAdapter.set(key, JSON.stringify(value), ttlSeconds),
          delete: async (key: string) => hostAdapter.del(key),
          clear: async (pattern?: string) => hostAdapter.clear(pattern ?? '*'),
        },
        prefix: deps.config.cache.prefix ?? 'mk',
        defaults: { staleTime: deps.config.cache.byIdTtl ?? 60 },
      }),
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
      registry: deps.registry,
      processor: deps.processor ?? null,
      processorReady: deps.processorReady ?? null,
      logger: deps.logger,
      bridges: deps.bridges ?? {},
      ...(deps.signing !== undefined && { signing: deps.signing }),
    },
    deps.config.pagination,
  );

  return { media };
}
