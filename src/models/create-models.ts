/**
 * Model Factory — creates Mongoose models on the given connection.
 *
 * Package owns its models (PACKAGE_RULES §20).
 * Purges stale cached models on rebuild (§21).
 */

import type { Connection, Model } from 'mongoose';
import type { IMediaDocument } from '../types.js';
import type { ResolvedMediaConfig } from '../engine/engine-types.js';
import { buildMediaSchema } from './media.schema.js';

export interface MediaModels {
  Media: Model<IMediaDocument>;
}

const MODEL_NAME = 'Media';

export function createMediaModels(
  connection: Connection,
  config: ResolvedMediaConfig,
): MediaModels {
  // Purge stale cached model (§21 — hot reload, tests)
  if (connection.models[MODEL_NAME]) {
    connection.deleteModel(MODEL_NAME);
  }

  const schema = buildMediaSchema({
    tenant: config.tenant,
    softDelete: config.softDelete,
    extraFields: config.schemaOptions?.extraFields as Record<string, import('mongoose').SchemaDefinitionProperty> | undefined,
    extraIndexes: config.schemaOptions?.extraIndexes,
    collection: config.schemaOptions?.collection,
    optimizedIndexes: config.schemaOptions?.optimizedIndexes,
  });

  const Media = connection.model<IMediaDocument>(MODEL_NAME, schema);
  return { Media };
}
