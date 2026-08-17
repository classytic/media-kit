/**
 * Public media-kit type surface.
 *
 * Prefer focused modules internally. This aggregate exists for consumer
 * convenience and preserves the historical root type contract.
 */

export type * from './storage.js';
export type * from './processing.js';
export type * from './media.js';
export type * from './config.js';
export type * from './uploads.js';
export type * from './folders.js';
export type * from './transforms.js';

export type { HttpError } from '@classytic/repo-core/errors';
export type {
  AggregatePaginationResult,
  AnyPaginationResult as PaginationResult,
  KeysetPaginationResult,
  OffsetPaginationResult,
} from '@classytic/repo-core/pagination';

export type {
  CacheAdapter,
  CacheOperationOptions,
  CacheOptions,
  CreateOptions,
  DeleteResult,
  EventPayload,
  OperationOptions,
  PaginationConfig,
  ParsedQuery,
  Plugin,
  PluginFunction,
  PluginType,
  PopulateSpec,
  QueryParserOptions,
  RepositoryContext,
  RepositoryEvent,
  SelectSpec,
  SortDirection,
  SortSpec,
  UpdateOptions,
} from '@classytic/mongokit';
