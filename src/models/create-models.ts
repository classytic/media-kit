/**
 * Media model specification — the ONE authoritative place the Media model is described.
 *
 * `defineMediaModels(config)` returns a connection-free mongokit `ModelBlueprint`;
 * `defineMedia(shape).bind(connection, runtime)` binds it during engine construction.
 * Collision handling, auto-index and collection config live here once
 * (PACKAGE_RULES §20/§21). A name collision surfaces as mongokit's typed
 * `ModelCollisionError` — there is no media-specific collision error.
 */

import { defineModels, type ModelBlueprint } from '@classytic/mongokit';
import type { Model } from 'mongoose';
import type { SoftDeleteConfig } from '../types/config.js';
import type { IMediaDocument } from '../types/media.js';
import type { MediaSchemaConfig } from './media.schema.js';
import { buildMediaSchema } from './media.schema.js';
import { type MediaTenantInput, resolveMediaTenant } from './inject-tenant.js';

export interface MediaModels {
  Media: Model<IMediaDocument>;
}

const MODEL_NAME = 'Media';

export interface DefineMediaModelsConfig {
  /** Raw tenant input — resolved lazily (inside the schema factory) via `resolveMediaTenant`. */
  tenant?: MediaTenantInput;
  /** Soft-delete policy — gates the `deletedAt` field and (opt-in) TTL index. */
  softDelete?: SoftDeleteConfig;
  /** Schema extension point — extra fields/indexes, explicit collection name. */
  extraFields?: MediaSchemaConfig['extraFields'];
  extraIndexes?: MediaSchemaConfig['extraIndexes'];
  collection?: string;
  optimizedIndexes?: boolean;
  /** Mongoose auto-index builds. Default `true` (dev); pass `false` in prod (§35). */
  autoIndex?: boolean;
  /** On a name collision: `false` (default) throws; `true` re-registers (test/dev fixtures). */
  forceRecreate?: boolean;
}

/**
 * Describe the Media model set as a connection-free blueprint. Pure — builds no schema and
 * registers nothing until `.bind(connection)`. Tenant resolution and schema construction are
 * deferred into the lazy schema factory, so `defineMedia(...)` performs no I/O at describe time.
 */
export function defineMediaModels(config: DefineMediaModelsConfig = {}): ModelBlueprint<MediaModels> {
  const autoIndex = config.autoIndex ?? true;

  return defineModels<MediaModels>({
    models: [
      {
        name: MODEL_NAME,
        schema: () => {
          const schema = buildMediaSchema({
            tenant: resolveMediaTenant(config.tenant),
            ...(config.softDelete !== undefined ? { softDelete: config.softDelete } : {}),
            ...(config.extraFields !== undefined ? { extraFields: config.extraFields } : {}),
            ...(config.extraIndexes !== undefined ? { extraIndexes: config.extraIndexes } : {}),
            ...(config.collection !== undefined ? { collection: config.collection } : {}),
            ...(config.optimizedIndexes !== undefined ? { optimizedIndexes: config.optimizedIndexes } : {}),
          });
          schema.set('autoIndex', autoIndex);
          return schema;
        },
        // `replace` (test/dev) mirrors the old unconditional purge; mongokit refuses it in prod.
        existing: config.forceRecreate ? { mode: 'replace', environment: 'test' } : { mode: 'throw' },
      },
    ],
    assemble: (models) => Object.freeze({ Media: models.get(MODEL_NAME) as Model<IMediaDocument> }),
  });
}
