import type { StorageBudget } from '../storage-budget.js';
/**
 * Engine types for @classytic/media-kit.
 *
 * MediaShape   — describe-time policy passed to `defineMedia(shape)` (pure, no I/O)
 * MediaRuntime — bind-time collaborators passed to `blueprint.bind(connection, runtime)`
 * MediaEngine  — what `bind()` returns (frozen)
 * MediaContext — operation context threaded through domain verbs
 *
 * Construction is `defineMedia(shape).bind(connection, runtime)` — there is no
 * `createMedia(config)` and no flat `MediaConfig`. The shape/runtime split follows
 * the Kernel Construction Standard §6.2: immutable, I/O-free policy is describe-time;
 * the live connection and every live collaborator (drivers, transport, bridges,
 * cache, logger, authorize callback) is bind-time.
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
import type { StorageDriver } from '../types/storage.js';
import type { IMediaDocument } from '../types/media.js';
import type {
  FileTypesConfig,
  FolderConfig,
  DeduplicationConfig,
  SoftDeleteConfig,
  ConcurrencyConfig,
  MediaKitLogger,
  VisibilityConfig,
  MediaSigningConfig,
  ServeAuthorize,
  ExternalMediaConfig,
} from '../types/config.js';
import type { MediaCacheConfig, ProcessingConfig } from '../types/processing.js';
import type { UrlSigner } from '../signing/index.js';

// ── MediaShape (describe-time policy — passed to defineMedia) ─
//
// Immutable, I/O-free configuration that determines the persistence SHAPE and the
// serve/transform policy. Nothing here opens a socket, reads a secret at inspection
// time, or holds a live collaborator. Safe to call at import / module-composition time.

export interface MediaShape {
  /**
   * Tenant / scope configuration (PACKAGE_RULES P11).
   *
   * Accepts the canonical {@link TenantConfig} from `@classytic/repo-core/tenant`,
   * or a boolean (`false` disables scoping, `true` enables with defaults). media-kit defaults
   * differ from repo-core's: `fieldType: 'string'`, `required: false`.
   */
  tenant?: MediaTenantInput;

  /** File type restrictions. */
  fileTypes?: FileTypesConfig;
  /** Folder configuration. */
  folders?: FolderConfig;
  /** Image processing config (imgproxy / processor options). */
  processing?: ProcessingConfig;
  /** File deduplication config. */
  deduplication?: DeduplicationConfig;
  /** Soft delete config (wires mongokit softDeletePlugin when enabled). */
  softDelete?: SoftDeleteConfig;
  /** Concurrency control. */
  concurrency?: ConcurrencyConfig;
  /** Suppress warnings about missing optional dependencies. */
  suppressWarnings?: boolean;

  /**
   * Default-visibility policy for new uploads. Per-upload `visibility`
   * overrides `byFolder` rules, which override `default` ('public').
   */
  visibility?: VisibilityConfig;

  /**
   * HMAC URL-signing config. When set, `bind()` constructs ONE `UrlSigner`
   * shared by `repositories.media.getSignedAssetUrl()` and the
   * `AssetTransformService` (which picks it up from the engine automatically).
   * The keys/secret are opaque describe-time config (§6.2); the signer object
   * is constructed at bind time.
   */
  signing?: MediaSigningConfig;

  /**
   * External (reference-only) media policy for `registerExternal()` —
   * currently an origin allowlist. Unset = any absolute http(s) URL.
   */
  external?: ExternalMediaConfig | undefined;

  /**
   * Schema extension point — add fields/indexes without forking.
   */
  schemaOptions?: {
    extraFields?: Record<string, unknown>;
    extraIndexes?: Array<Record<string, 1 | -1 | 'text'>>;
    collection?: string;
    optimizedIndexes?: boolean;
  };

  /** Mongoose auto-index builds. Default `true` (dev); pass `false` in prod (§35). */
  autoIndex?: boolean;

  /**
   * On a model-name collision: default throws (mongokit `ModelCollisionError`);
   * `true` re-registers (test/dev fixtures). Maps to mongokit's `replace` policy,
   * which itself throws under `NODE_ENV=production`.
   */
  forceRecreate?: boolean;
}

// ── MediaRuntime (bind-time collaborators — passed to bind) ───
//
// The live connection is the first `bind` arg; these are the rest. Every live port
// (storage drivers, transport, bridges, cache, logger, authorize callback) belongs
// here, not in the shape.

export interface MediaRuntime {
  /** Direct uploads reserve physical bytes before a signed URL is returned. */
  storageBudget?: StorageBudget;
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
   * defineMedia({ ... }).bind(connection, {
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

  /** Arc-compatible event transport. Default: an internally-created in-process bus. */
  eventTransport?: EventTransport;

  /**
   * Host-implemented bridges for cross-package / external concerns.
   * All bridges are OPTIONAL — media-kit works without any.
   */
  bridges?: MediaBridges;

  /** Cache adapter for read-through caching. */
  cache?: MediaCacheConfig;
  /** Logger instance. */
  logger?: MediaKitLogger;
  /** Additional mongokit plugins to apply to the repository. */
  plugins?: PluginType[];
  /** Pagination configuration. */
  pagination?: PaginationConfig;

  /**
   * Host authorization callback for private media served WITHOUT a valid
   * signature (session access). Threaded to `AssetTransformService` via the
   * engine. Return `true` to allow; `false` or a throw denies with 403
   * (fail-closed). This is the bridge point for `@classytic/access`:
   * implement it with `access.check(...)` — media-kit never imports it.
   */
  authorize?: ServeAuthorize;
}

// ── ResolvedMediaConfig (after merge with defaults) ──────────

export interface ResolvedMediaConfig
  extends Omit<MediaShape & MediaRuntime, 'tenant' | 'eventTransport' | 'autoIndex' | 'forceRecreate'> {
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

// ── MediaEngine (output of bind) ─────────────────────────────

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

  /**
   * Resolve the driver that stores a given media document's bytes
   * (`registry.resolve(media.provider ?? defaultName)`). Satisfies
   * `MediaTransformSource.resolveDriver`, so
   * `createAssetTransform({ media: engine })` serves non-default-provider
   * docs from the correct backend with zero extra host wiring. Throws for
   * external (reference-only) records — check `isExternalMedia()` first.
   */
  readonly resolveDriver: (media: IMediaDocument) => StorageDriver;

  /** Bridges passed in config (frozen). */
  readonly bridges: Readonly<MediaBridges>;

  /**
   * Shared HMAC URL signer — present when `signing` was configured.
   * `AssetTransformService` reads it from here (via MediaTransformSource)
   * unless explicitly overridden in its own config.
   */
  readonly signing?: UrlSigner | undefined;

  /** Host authorize callback — passed through for the transform service. */
  readonly authorize?: ServeAuthorize | undefined;

  /**
   * Reconcile the Media collection's indexes with the compiled schema.
   *
   * REQUIRED by the Kernel Construction Standard §6.4: index reconciliation must
   * be an explicit, callable operation rather than a `bind()` side effect. The
   * engine had no such verb, so the ONLY way media indexes were ever created was
   * mongoose's own `autoIndex` — which every deployment here turns OFF (index
   * builds are deployment maintenance, not per-replica boot work). A host that
   * followed that guidance had no way to build them at all.
   *
   * REJECTS on failure. A silent index sync is worse than none: the collection
   * keeps serving unindexed reads that look merely slow.
   */
  syncIndexes(): Promise<void>;

  /**
   * Release resources. Safe to call multiple times. Closes ONLY an
   * internally-created event bus — a host-supplied transport is never closed.
   */
  close(): Promise<void>;
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
