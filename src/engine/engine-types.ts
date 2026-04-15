/**
 * Engine types for @classytic/media-kit v3.
 *
 * MediaConfig — what the host passes to createMedia()
 * MediaEngine — what createMedia() returns (frozen)
 * MediaContext — operation context threaded through domain verbs
 */

import type { Connection, Model } from 'mongoose';
import type { PaginationConfig, PluginType } from '@classytic/mongokit';
import type { EventTransport } from '../events/transport.js';
import type { MediaRepository } from '../repositories/media.repository.js';
import type { MediaBridges } from '../bridges/types.js';
import type {
  StorageDriver,
  IMediaDocument,
  FileTypesConfig,
  FolderConfig,
  ProcessingConfig,
  MultiTenancyConfig,
  DeduplicationConfig,
  SoftDeleteConfig,
  ConcurrencyConfig,
  MediaCacheConfig,
  MediaKitLogger,
} from '../types.js';

// ── MediaConfig (input to createMedia) ───────────────────────

export interface MediaConfig {
  /** Mongoose connection — package creates models on this connection. */
  connection: Connection;

  /** Storage driver instance (S3, GCS, Local, Router). */
  driver: StorageDriver;

  /**
   * How to store/query the tenant ID.
   * - 'string' (default): String field — for UUID/slug auth systems
   * - 'objectId': Schema.Types.ObjectId + ref — enables $lookup, .populate()
   */
  tenantFieldType?: 'objectId' | 'string';

  /** Arc-compatible event transport. Default: in-process bus. */
  eventTransport?: EventTransport;

  /**
   * Host-implemented bridges for cross-package / external concerns.
   * All bridges are OPTIONAL — media-kit works without any.
   */
  bridges?: MediaBridges;

  /** File type restrictions. */
  fileTypes?: FileTypesConfig;
  /** Folder configuration. */
  folders?: FolderConfig;
  /** Image processing config. */
  processing?: ProcessingConfig;
  /** Multi-tenancy config. */
  multiTenancy?: MultiTenancyConfig;
  /** File deduplication config. */
  deduplication?: DeduplicationConfig;
  /** Soft delete config (wires mongokit softDeletePlugin when enabled). */
  softDelete?: SoftDeleteConfig;
  /** Concurrency control. */
  concurrency?: ConcurrencyConfig;
  /** Cache adapter for read-through caching. */
  cache?: MediaCacheConfig;
  /** Logger instance. */
  logger?: MediaKitLogger;
  /** Suppress warnings about missing optional dependencies. */
  suppressWarnings?: boolean;
  /** Additional mongokit plugins to apply to the repository. */
  plugins?: PluginType[];
  /** Pagination configuration. */
  pagination?: PaginationConfig;

  /**
   * Schema extension point — add fields/indexes without forking.
   */
  schemaOptions?: {
    extraFields?: Record<string, unknown>;
    extraIndexes?: Array<Record<string, 1 | -1 | 'text'>>;
    collection?: string;
    optimizedIndexes?: boolean;
  };
}

// ── ResolvedMediaConfig (after merge with defaults) ──────────

export interface ResolvedMediaConfig extends Omit<MediaConfig, 'connection' | 'eventTransport'> {
  connection: Connection;
  fileTypes: Required<FileTypesConfig>;
  folders: Required<FolderConfig>;
  processing: ProcessingConfig;
  multiTenancy: Required<MultiTenancyConfig>;
  deduplication: Required<DeduplicationConfig>;
  softDelete: Required<SoftDeleteConfig>;
  concurrency: Required<ConcurrencyConfig>;
}

// ── MediaEngine (output of createMedia) ──────────────────────

export interface MediaEngine {
  /** Repositories ARE the API surface (PACKAGE_RULES §1). */
  readonly repositories: {
    readonly media: MediaRepository;
  };

  /** Arc-compatible event transport. */
  readonly events: EventTransport;

  /** Mongoose models — for Arc adapter wiring. */
  readonly models: {
    readonly Media: Model<IMediaDocument>;
  };

  /** Resolved configuration (frozen). */
  readonly config: Readonly<ResolvedMediaConfig>;

  /** Storage driver reference. */
  readonly driver: StorageDriver;

  /** Bridges passed in config (frozen). */
  readonly bridges: Readonly<MediaBridges>;

  /** Release resources. Safe to call multiple times. */
  dispose(): Promise<void>;
}

// ── MediaContext (threaded through domain verbs) ──────────────

export interface MediaContext {
  /** Current user ID. */
  userId?: string | import('mongoose').Types.ObjectId;
  /** Organization ID for multi-tenancy. */
  organizationId?: string | import('mongoose').Types.ObjectId;
  /** Correlation ID for tracing. */
  correlationId?: string;
  /** Mongoose session for transactions (PACKAGE_RULES §17). */
  session?: unknown;
  /** Include soft-deleted files in queries. */
  includeDeleted?: boolean;
  /** Additional context data. */
  [key: string]: unknown;
}
