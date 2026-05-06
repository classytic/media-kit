/**
 * Engine types for @classytic/media-kit v3.
 *
 * MediaConfig — what the host passes to createMedia()
 * MediaEngine — what createMedia() returns (frozen)
 * MediaContext — operation context threaded through domain verbs
 */

import type { Connection, Model } from 'mongoose';
import type { PaginationConfig, PluginType } from '@classytic/mongokit';
import type { OperationContext } from '@classytic/primitives/context';
import type { EventTransport } from '@classytic/primitives/events';
import type { ResolvedTenantConfig } from '@classytic/repo-core/tenant';
import type { MediaRepository } from '../repositories/media.repository.js';
import type { MediaBridges } from '../bridges/types.js';
import type { MediaTenantInput } from '../models/inject-tenant.js';
import type { DriverRegistry } from '../providers/driver-registry.js';
import type {
  StorageDriver,
  IMediaDocument,
  FileTypesConfig,
  FolderConfig,
  ProcessingConfig,
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

  /**
   * Single storage driver — sugar for a one-entry `providers` registry.
   * Use `providers` + `defaultProvider` when you need multiple backends.
   * Exactly one of `driver` or `providers` must be set.
   */
  driver?: StorageDriver;

  /**
   * Named storage drivers for multi-provider setups.
   *
   * Each key becomes the provider name stored on `IMedia.provider` and passed
   * to `upload({ provider: 'name' })`. Hosts can mix built-in drivers with
   * their own `StorageDriver` implementations freely — the interface is open.
   *
   * @example
   * ```ts
   * createMedia({
   *   providers: {
   *     s3:       new S3Provider({ bucket: 'originals', region: 'us-east-1' }),
   *     imagekit: new ImageKitProvider({ urlEndpoint: '...', privateKey: '...' }),
   *     imgbb:    new ImgbbProvider({ apiKey: process.env.IMGBB_KEY }),
   *   },
   *   defaultProvider: 's3',
   * })
   * ```
   */
  providers?: Record<string, StorageDriver>;

  /**
   * Default provider name when `providers` is used.
   * Required when `providers` is set; ignored when only `driver` is set.
   */
  defaultProvider?: string;

  /**
   * Tenant / scope configuration (PACKAGE_RULES P11).
   *
   * Accepts the canonical {@link TenantConfig} from `@classytic/repo-core/tenant`,
   * a boolean (`false` disables scoping, `true` enables with defaults), or the
   * legacy `{ tenantFieldType, multiTenant }` shorthand. media-kit defaults
   * differ from repo-core's: `fieldType: 'string'`, `required: false`.
   */
  tenant?: MediaTenantInput;

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

export interface ResolvedMediaConfig extends Omit<MediaConfig, 'connection' | 'eventTransport' | 'tenant'> {
  connection: Connection;
  fileTypes: Required<FileTypesConfig>;
  folders: Required<FolderConfig>;
  processing: ProcessingConfig;
  /** Resolved tenant config — single source of truth for scoping (P11). */
  tenant: ResolvedTenantConfig;
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

  /**
   * Driver registry — all registered providers, keyed by name.
   * Use `registry.resolve('name')` to get a specific driver,
   * or `registry.defaultDriver` for the default.
   */
  readonly registry: DriverRegistry;

  /**
   * Default storage driver (shorthand for `registry.defaultDriver`).
   * Preserved for single-driver backward compatibility.
   */
  readonly driver: StorageDriver;

  /** Bridges passed in config (frozen). */
  readonly bridges: Readonly<MediaBridges>;

  /** Release resources. Safe to call multiple times. */
  dispose(): Promise<void>;
}

// ── MediaContext (threaded through domain verbs) ──────────────

/**
 * Extends `@classytic/primitives`' {@link OperationContext}. Media-kit's
 * `userId` (the upload/mutation owner) is an alias for primitives'
 * `actorId`; keep both until consumers migrate, then drop `userId`.
 * Narrows `IdLike` to `string | ObjectId` for mongoose storage.
 *
 * Host-specific extras should go through primitives' `metadata?` field
 * (inherited from OperationContext) — avoids an index signature that
 * would dilute the inherited typed fields.
 */
export interface MediaContext extends OperationContext {
  /** Upload/mutation owner. Media-kit alias for primitives' `actorId`. */
  userId?: string | import('mongoose').Types.ObjectId;
  /** Narrows primitives' `IdLike` to Mongoose-storable types. */
  organizationId?: string | import('mongoose').Types.ObjectId;
  /** Include soft-deleted files in queries. */
  includeDeleted?: boolean;
}
