import type { EventTransport } from '@classytic/primitives/events';
import { assertNoLegacyTenantKeys } from '@classytic/repo-core/tenant';
import type { Connection } from 'mongoose';
import { mergeConfig } from '../config.js';
import { InProcessMediaBus } from '../events/in-process-bus.js';
import { defineMediaModels } from '../models/create-models.js';
import { resolveMediaTenant } from '../models/inject-tenant.js';
import { ImageProcessor } from '../processing/image.js';
import { DriverRegistry } from '../providers/driver-registry.js';
import { createMediaRepositories } from '../repositories/create-repositories.js';
import { createUrlSigner, type UrlSigner } from '../signing/index.js';
import type { MediaKitConfig } from '../types/config.js';
import type { IMediaDocument } from '../types/media.js';
import type { ImageAdapter } from '../types/processing.js';
import type { StorageDriver } from '../types/storage.js';
import { mediaConfigSchema } from '../validators/media-config.schema.js';
import type { MediaEngine, MediaRuntime, MediaShape, ResolvedMediaConfig } from './engine-types.js';

export interface MediaBlueprint {
  readonly id: 'media';
  /** The model names this blueprint registers — known without a connection. */
  readonly modelNames: readonly string[];
  /**
   * Compile + register the model on `connection`, wire the engine, return the frozen engine.
   * Async: the image-processor readiness probe (sharp availability) is awaited during bind.
   */
  bind(connection: Connection, runtime?: MediaRuntime): Promise<MediaEngine>;
}

/**
 * Describe the media engine. Pure — registers no model, builds no schema, performs no I/O.
 */
export function defineMedia(shape: MediaShape = {}): MediaBlueprint {
  // `multiTenant` / `tenantFieldType` were renamed to `tenant` /
  // `tenant.fieldType`. Refused, not ignored: an unread key leaves scoping at
  // the default, which returns rows from the wrong scope without erroring.
  assertNoLegacyTenantKeys(shape, 'defineMedia', [['tenantFieldType', 'tenant.fieldType']]);

  // Single source of truth for the Media model set (defineMediaModels). Tenant resolution and
  // schema construction are deferred into the lazy schema factory, so this call does no I/O.
  const modelBlueprint = defineMediaModels({
    ...(shape.tenant !== undefined ? { tenant: shape.tenant } : {}),
    ...(shape.softDelete !== undefined ? { softDelete: shape.softDelete } : {}),
    ...(shape.schemaOptions?.extraFields !== undefined
      ? {
          extraFields: shape.schemaOptions.extraFields as Record<string, import('mongoose').SchemaDefinitionProperty>,
        }
      : {}),
    ...(shape.schemaOptions?.extraIndexes !== undefined ? { extraIndexes: shape.schemaOptions.extraIndexes } : {}),
    ...(shape.schemaOptions?.collection !== undefined ? { collection: shape.schemaOptions.collection } : {}),
    ...(shape.schemaOptions?.optimizedIndexes !== undefined
      ? { optimizedIndexes: shape.schemaOptions.optimizedIndexes }
      : {}),
    ...(shape.autoIndex !== undefined ? { autoIndex: shape.autoIndex } : {}),
    ...(shape.forceRecreate !== undefined ? { forceRecreate: shape.forceRecreate } : {}),
  });

  return {
    id: 'media',
    modelNames: modelBlueprint.modelNames,

    async bind(connection: Connection, runtime: MediaRuntime = {}): Promise<MediaEngine> {
      if (!connection) {
        throw new Error('[media-kit] bind() connection is required');
      }

      // Build driver registry from either `driver` (single) or `providers` (multi).
      let registry: DriverRegistry;
      if (runtime.providers) {
        if (!runtime.defaultProvider) {
          throw new Error('[media-kit] defaultProvider is required when providers is set');
        }
        registry = new DriverRegistry(runtime.providers, runtime.defaultProvider);
      } else if (runtime.driver) {
        registry = DriverRegistry.fromSingle(runtime.driver);
      } else {
        throw new Error('[media-kit] Either driver or providers must be specified');
      }

      // Validate the serializable subset of the shape with Zod. Fail-fast on bad shapes
      // (negative ttlDays, unknown fieldType, empty allow-list) instead of letting them
      // silently drift through `mergeConfig`. Non-serializable inputs (drivers, transport,
      // processing adapter, plugins, cache, logger) are not validated here.
      const validated = mediaConfigSchema.parse({
        tenant: shape.tenant,
        softDelete: shape.softDelete,
        fileTypes: shape.fileTypes,
        folders: shape.folders,
        deduplication: shape.deduplication,
        concurrency: shape.concurrency,
        schemaOptions: shape.schemaOptions,
        suppressWarnings: shape.suppressWarnings,
        visibility: shape.visibility,
        signing: shape.signing,
        external: shape.external,
      });

      // Merge shape + runtime into one config object, then re-apply the Zod-validated values
      // (defaults win where overlapping). Non-validated fields (driver, providers, plugins,
      // bridges, cache, logger, authorize, pagination) survive intact.
      const combined = { ...shape, ...runtime, ...validated };

      const resolved = mergeConfig(combined as Partial<MediaKitConfig>) as unknown as ResolvedMediaConfig;
      resolved.connection = connection;
      resolved.tenant = resolveMediaTenant(shape.tenant);
      resolved.schemaOptions = shape.schemaOptions;

      // Ownership: a host-SUPPLIED transport is shared infrastructure (often Arc's bus across
      // every module) — we must NEVER close it, or closing media would silence other domains.
      // We only own — and therefore only close — the default in-process bus we create here.
      const ownsTransport = runtime.eventTransport === undefined;
      const events: EventTransport =
        runtime.eventTransport ?? new InProcessMediaBus(runtime.logger ? { logger: runtime.logger } : undefined);

      // Construct ONE UrlSigner shared by the repository (getSignedAssetUrl) and the transform
      // service (signature verification via engine.signing). createUrlSigner fail-fasts on bad
      // keyrings (no keys, missing currentKid).
      let signer: UrlSigner | undefined;
      if (shape.signing) {
        signer = createUrlSigner({
          keys: shape.signing.keys,
          secret: shape.signing.secret,
          currentKid: shape.signing.currentKid,
          defaultTtl: shape.signing.defaultTtl,
        });
      }

      // Initialize image processor.
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

        processorReady = sharpProcessor
          .waitUntilReady()
          .then((available) => {
            if (!available) {
              processor = null;
              if (!resolved.suppressWarnings) {
                runtime.logger?.warn?.(
                  'Image processing disabled: sharp not available. Install with: npm install sharp',
                );
              }
            }
          })
          .catch(() => {
            processor = null;
            if (!resolved.suppressWarnings) {
              runtime.logger?.warn?.('Image processing disabled: sharp not available. Install with: npm install sharp');
            }
          });
      } else {
        processorReady = Promise.resolve();
      }

      // Compile + register the Media model on the connection (mongokit ModelBlueprint).
      // A name collision surfaces as mongokit's typed `ModelCollisionError` unless the shape
      // opted into `forceRecreate` (test/dev replace policy).
      const models = modelBlueprint.bind(connection);

      // Resolve bridges (frozen, passed through to repo).
      const bridges = Object.freeze({ ...(runtime.bridges ?? {}) });

      const repositories = createMediaRepositories(models, {
        ...(runtime.storageBudget ? { storageBudget: runtime.storageBudget } : {}),
        events,
        config: resolved,
        registry,
        processor,
        processorReady,
        ...(runtime.logger !== undefined ? { logger: runtime.logger } : {}),
        bridges,
        ...(signer !== undefined ? { signing: signer } : {}),
      });

      const close = async (): Promise<void> => {
        // Only close the transport we created. A supplied (shared) transport's lifecycle
        // belongs to the host — closing it would disable other modules on the same bus.
        if (ownsTransport) await events.close?.();
      };

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
        // Per-doc driver routing for the serve path — AssetTransformService picks this up via
        // MediaTransformSource so non-default-provider docs stream from their own backend.
        resolveDriver: (media: IMediaDocument): StorageDriver =>
          registry.resolve(media.provider ?? registry.defaultName),
        bridges,
        signing: signer,
        authorize: runtime.authorize,
        /**
         * §6.4 — explicit index reconciliation.
         *
         * `createIndexes()` REJECTS on failure and is not swallowed: a media
         * collection serving unindexed reads looks merely slow, so a failed sync
         * must surface at the deployment step that ran it.
         */
        async syncIndexes(): Promise<void> {
          await (models.Media as unknown as { createIndexes: () => Promise<unknown> }).createIndexes();
        },
        close,
      });

      return engine;
    },
  };
}
