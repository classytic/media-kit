/**
 * Media Repository — v3
 *
 * The API surface for @classytic/media-kit (PACKAGE_RULES §1).
 * Extends mongokit Repository. Domain verbs live here.
 * Proxy methods removed — callers use inherited mongokit methods directly.
 *
 * Domain verbs:
 *   upload, uploadMany, replace, hardDelete, hardDeleteMany,
 *   move, importFromUrl, addTags, removeTags, setFocalPoint,
 *   purgeDeleted, purgeStalePending, getSignedUploadUrl, confirmUpload,
 *   multipart suite,
 *   folder operations, analytics
 *
 * Verb implementations live in ./verbs/* (one module per domain group);
 * every class method below is a thin delegate so the public API surface —
 * signatures, behavior, JSDoc — is unchanged.
 */

import type { Model } from 'mongoose';
import { Repository, type PluginType, type PaginationConfig } from '@classytic/mongokit';
import type {
  IMediaDocument,
  UploadInput,
  ConfirmUploadInput,
  OperationContext,
  PresignedUploadResult,
  FolderTree,
  FolderStats,
  FolderNode,
  BreadcrumbItem,
  BulkResult,
  RewriteResult,
  FocalPoint,
  ImportOptions,
  ImageAdapter,
  InitiateMultipartInput,
  MultipartUploadSession,
  CompleteMultipartInput,
  SignedPartResult,
  BatchPresignInput,
  BatchPresignResult,
  MediaKitLogger,
  RegisterExternalInput,
  StorageDriver,
} from '../types.js';
import type { UrlSigner } from '../signing/index.js';
import type { SharpModule, SharpInstanceSource } from '../processing/image.js';
import type { EventTransport } from '@classytic/primitives/events';
import type { ResolvedMediaConfig, MediaContext } from '../engine/engine-types.js';
import type { MediaBridges } from '../bridges/types.js';
import type { TransformOpOutput } from '../bridges/transform.bridge.js';
import type { OperationDeps } from '../operations/types.js';
import type { DriverRegistry } from '../providers/driver-registry.js';
import { MEDIA_EVENTS } from '../events/event-constants.js';
import { createMediaEvent } from '../events/helpers.js';
import type { ImageProcessor } from '../processing/image.js';
import { Semaphore } from '../utils/semaphore.js';
import { validateFile as validateFileHelper, getContentType as getContentTypeHelper } from '../operations/helpers.js';
import { uploadVerb, uploadManyVerb, replaceVerb } from './verbs/upload.verbs.js';
import {
  hardDeleteVerb,
  hardDeleteManyVerb,
  purgeDeletedVerb,
  purgeStalePendingVerb,
  purgeExpiredVerb,
  getExpiringSoonVerb,
} from './verbs/delete.verbs.js';
import { moveVerb, importFromUrlVerb, registerExternalVerb } from './verbs/import.verbs.js';
import { addTagsVerb, removeTagsVerb, setFocalPointVerb } from './verbs/annotate.verbs.js';
import {
  getFolderTreeVerb,
  getFolderStatsVerb,
  getBreadcrumbVerb,
  deleteFolderVerb,
  renameFolderVerb,
  getSubfoldersVerb,
} from './verbs/folder.verbs.js';
import {
  resolveSourceVerb,
  resolveSourcesManyVerb,
  getAssetUrlVerb,
  getVariantUrlsVerb,
  getSignedAssetUrlVerb,
  revokeAccessVerb,
  getContextPayloadVerb,
  applyTransformsVerb,
} from './verbs/url.verbs.js';
import {
  getByHashVerb,
  existsByHashVerb,
  getStorageByFolderVerb,
  getTotalStorageUsedVerb,
} from './verbs/lookup.verbs.js';

// ── Constants ────────────────────────────────────────────────

export { STALE_PENDING_MAX_AGE_MS } from './verbs/delete.verbs.js';

// ── Repository Dependencies ──────────────────────────────────

export interface MediaRepositoryDeps {
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

// ── Repository Class ─────────────────────────────────────────

export class MediaRepository extends Repository<IMediaDocument> {
  /** @internal Exposed for verb modules (./verbs/*) — not part of the public API. */
  public readonly events: EventTransport;
  /** @internal Exposed for verb modules (./verbs/*) — not part of the public API. */
  public readonly registry: DriverRegistry;
  private readonly processor: ImageProcessor | ImageAdapter | null;
  private readonly processorReady: Promise<void> | null;
  /** @internal Exposed for verb modules (./verbs/*) — not part of the public API. */
  public readonly mediaConfig: ResolvedMediaConfig;
  /** @internal Exposed for verb modules (./verbs/*) — not part of the public API. */
  public readonly uploadSemaphore: Semaphore;
  private readonly mediaLogger?: MediaKitLogger;
  /** @internal Exposed for verb modules (./verbs/*) — not part of the public API. */
  public readonly signer: UrlSigner | null;
  public readonly bridges: MediaBridges;

  constructor(
    model: Model<IMediaDocument>,
    plugins: PluginType[],
    deps: MediaRepositoryDeps,
    pagination?: PaginationConfig,
  ) {
    super(model, plugins, pagination);
    this.events = deps.events;
    this.registry = deps.registry;
    this.processor = deps.processor ?? null;
    this.processorReady = deps.processorReady ?? null;
    this.mediaConfig = deps.config;
    this.uploadSemaphore = new Semaphore(deps.config.concurrency?.maxConcurrent ?? 5);
    this.mediaLogger = deps.logger;
    this.signer = deps.signing ?? null;
    this.bridges = deps.bridges ?? {};
  }

  // ── Internal: bridge to legacy operation helpers ──────────

  /**
   * Build OperationDeps for delegating to existing operation helpers.
   *
   * `driver` is the DEFAULT driver — operation flows that target a specific
   * provider (upload/replace with `input.provider`, per-doc routing) must go
   * through {@link _opDepsWith} instead, otherwise storage writes silently
   * land in the default provider's backend.
   *
   * @internal Exposed for verb modules (./verbs/*) — not part of the public API.
   */
  public get _opDeps(): OperationDeps {
    return this._opDepsWith(this.registry.defaultDriver);
  }

  /**
   * Build OperationDeps bound to a SPECIFIC storage driver — used when the
   * target provider is known up front (upload/replace resolve
   * `input.provider ?? doc.provider ?? default`), so `processImage()` writes
   * the `__original` + size variants to the SAME provider as the main file.
   *
   * @internal Exposed for verb modules (./verbs/*) — not part of the public API.
   */
  public _opDepsWith(driver: StorageDriver): OperationDeps {
    // Minimal shim: events emitter that maps new transport → old event emitter shape
    const self = this;
    return {
      config: this.mediaConfig,
      driver,
      registry: this.registry,
      repository: this,
      get processor() {
        return self.processor;
      },
      processorReady: this.processorReady,
      events: {
        emit: async () => {},
        on: () => () => {},
        removeAllListeners: () => {},
        listenerCount: () => 0,
      },
      uploadSemaphore: this.uploadSemaphore,
      logger: this.mediaLogger,
    };
  }

  /**
   * Convert a MediaContext into the operations-layer OperationContext bag.
   * Interfaces don't carry the implicit index signature the ops context
   * requires, so we spread into a fresh literal (same values, by reference).
   *
   * @internal Exposed for verb modules (./verbs/*) — not part of the public API.
   */
  public _opCtx(ctx?: MediaContext): OperationContext | undefined {
    return ctx ? { ...ctx } : undefined;
  }

  /** @internal Exposed for verb modules (./verbs/*) — not part of the public API. */
  public _log(level: 'info' | 'warn' | 'error', message: string, meta?: Record<string, unknown>): void {
    this.mediaLogger?.[level]?.(message, meta);
  }

  /**
   * Best-effort CDN edge eviction after destructive storage ops — see
   * {@link CdnBridge.purge}. A purge failure must never fail the delete/
   * replace that triggered it (the origin object is already gone; the CDN
   * copy ages out via TTL regardless).
   *
   * @internal Exposed for verb modules (./verbs/*) — not part of the public API.
   */
  public async _purgeCdn(keys: string[], ctx?: MediaContext): Promise<void> {
    const purge = this.bridges.cdn?.purge;
    if (!purge || keys.length === 0) return;
    try {
      await purge.call(this.bridges.cdn, keys, {
        ...(ctx?.organizationId !== undefined && { organizationId: String(ctx.organizationId) }),
      });
    } catch (err) {
      this._log('warn', 'CDN purge failed (stale copies age out via cache TTL)', {
        keys,
        error: (err as Error).message,
      });
    }
  }

  /**
   * Build the options bag used to forward tenant + session context to plugin-
   * routed Repository methods (`getAll`, `getByQuery`, `aggregatePipeline`,
   * `update`, etc.).
   *
   * Reads the org id from `ctx.organizationId` (the canonical field on
   * `MediaContext`) and forwards it under the multiTenantPlugin's configured
   * `contextKey` — defaults to `'organizationId'` but hosts may override.
   * Without this indirection, scoping silently breaks when a host configures
   * a non-default `contextKey`.
   *
   * @internal Exposed for verb modules (./verbs/*) — not part of the public API.
   */
  public _tenantOpts(ctx?: MediaContext): Record<string, unknown> {
    const opts: Record<string, unknown> = {};
    if (ctx?.session !== undefined) opts.session = ctx.session;
    const tenant = this.mediaConfig.tenant;
    if (tenant?.enabled && ctx?.organizationId !== undefined) {
      const contextKey = tenant.contextKey ?? 'organizationId';
      opts[contextKey] = ctx.organizationId;
    } else if (ctx?.organizationId !== undefined) {
      // Tenant scoping disabled — still pass for any custom plugin that reads it.
      opts.organizationId = ctx.organizationId;
    }
    return opts;
  }

  // ============================================================
  // DOMAIN VERBS — Upload
  // ============================================================

  /**
   * Upload a single file with status-driven flow.
   * pending → processing → ready | error.
   * Publishes media:asset.uploaded on success.
   */
  async upload(input: UploadInput, ctx?: MediaContext): Promise<IMediaDocument> {
    return uploadVerb(this, input, ctx);
  }

  /**
   * Upload multiple files. Partial failures do not block successful uploads.
   */
  async uploadMany(inputs: UploadInput[], ctx?: MediaContext): Promise<IMediaDocument[]> {
    return uploadManyVerb(this, inputs, ctx);
  }

  /**
   * Replace file content while preserving the document ID.
   */
  async replace(id: string, input: UploadInput, ctx?: MediaContext): Promise<IMediaDocument> {
    return replaceVerb(this, id, input, ctx);
  }

  // ============================================================
  // DOMAIN VERBS — Delete
  // ============================================================

  /**
   * Hard-delete: removes file from storage AND database.
   * Use repo.delete(id) for soft delete (when softDeletePlugin is wired).
   */
  async hardDelete(id: string, ctx?: MediaContext): Promise<boolean> {
    return hardDeleteVerb(this, id, ctx);
  }

  /**
   * Hard-delete multiple files with semaphore-bounded concurrency.
   */
  async hardDeleteMany(ids: string[], ctx?: MediaContext): Promise<BulkResult> {
    return hardDeleteManyVerb(this, ids, ctx);
  }

  /**
   * Purge soft-deleted files older than a given date.
   * Hard-deletes from both storage and database.
   */
  async purgeDeleted(olderThan?: Date, ctx?: MediaContext): Promise<number> {
    return purgeDeletedVerb(this, olderThan, ctx);
  }

  /**
   * Purge stale `status: 'pending'` rows left behind by crashed or abandoned
   * uploads.
   *
   * `upload()` creates the DB row as `'pending'` BEFORE writing to storage and
   * flips it to `'ready'` at the end — a process crash anywhere in between
   * strands the row (and possibly a storage object) forever. This sweep
   * hard-deletes (storage + DB) every pending row created before the cutoff.
   *
   * - **What counts as stale:** `status: 'pending'` AND `createdAt` older than
   *   `olderThan` (default: {@link STALE_PENDING_MAX_AGE_MS} = 24h ago — a
   *   genuinely in-flight upload never lives that long).
   * - **Cron-safe and idempotent:** already-purged rows simply don't match;
   *   a missing storage object (crash before the write) is tolerated — the
   *   DB row is still removed (`hardDelete()` treats storage deletion as
   *   best-effort and drivers treat missing keys as already-deleted).
   * - Emits `media:asset.purged` with `reason: 'stale_pending'` when anything
   *   was purged.
   *
   * Note: abandoned PRESIGNED uploads are the opposite shape — an unconfirmed
   * storage object with NO DB row (`confirmUpload()` creates the row). Those
   * are invisible to this sweep by design; use a bucket lifecycle rule on the
   * upload prefix instead.
   */
  async purgeStalePending(olderThan?: Date, ctx?: MediaContext): Promise<number> {
    return purgeStalePendingVerb(this, olderThan, ctx);
  }

  /**
   * Purge all assets whose `expiresAt` is in the past (or before `before`).
   *
   * Queries in batches of 100 to avoid loading the entire collection. Re-queries
   * from the start each batch since hardDelete() shrinks the result set.
   * Fires `media:assets.expired` with purge summary after completion.
   *
   * Safe to call from a cron job — idempotent if some docs were already removed.
   * Does NOT touch soft-deleted files (status is not a filter here; purge is
   * unconditional once expiresAt passes).
   */
  async purgeExpired(before?: Date, ctx?: MediaContext): Promise<BulkResult> {
    return purgeExpiredVerb(this, before, ctx);
  }

  /**
   * Return assets that will expire within `withinHours` from now.
   * Useful for sending pre-expiry notifications before purgeExpired() runs.
   */
  async getExpiringSoon(withinHours: number, ctx?: MediaContext): Promise<IMediaDocument[]> {
    return getExpiringSoonVerb(this, withinHours, ctx);
  }

  // ============================================================
  // DOMAIN VERBS — Move & Import
  // ============================================================

  /**
   * Move files to a different folder. Supports key rewriting.
   */
  async move(ids: string[], targetFolder: string, ctx?: MediaContext): Promise<RewriteResult> {
    return moveVerb(this, ids, targetFolder, ctx);
  }

  /**
   * Import a file from a URL.
   */
  async importFromUrl(url: string, options?: ImportOptions, ctx?: MediaContext): Promise<IMediaDocument> {
    return importFromUrlVerb(this, url, options, ctx);
  }

  /**
   * Register an EXTERNALLY-HOSTED asset (Cloudflare Images delivery URL, an
   * existing CDN object, a partner's hosted image) as a first-class media
   * record — tenancy, visibility, folders, tags, listing, events — WITHOUT
   * media-kit owning the bytes.
   *
   * - The URL is validated (absolute http(s); optional
   *   `external.allowedOrigins` config allowlist) but NEVER fetched — this is
   *   a reference registry, not an importer. Use `importFromUrl()` to re-host
   *   (it carries the SSRF machinery).
   * - The record stores `provider: 'external'` (the canonical discriminator)
   *   and the sentinel key `__external__/<sha256-hex-16-of-url>` — never a
   *   storage location. `hash` is the full SHA-256 of the URL string, so
   *   `existsByHash()` / dedup answer "is this URL already registered?"
   *   within a tenant. Registering the same URL twice creates two records
   *   (no implicit dedup) unless `deduplication` handles it host-side.
   * - Storage-op verbs are external-aware: `hardDelete()` (and every purge
   *   sweep) is DB-only; folder `move()`/`renameFolder()` never rewrite the
   *   sentinel key; the serve path 302-redirects to the stored URL;
   *   `getContextPayload()`/`applyTransforms()`/`replace()` throw typed
   *   errors (no readable bytes).
   * - Emits `media:asset.externalRegistered`.
   *
   * @throws 400 `media.external.invalid_url` — not an absolute http(s) URL
   * @throws 403 `media.external.origin_not_allowed` — origin outside `external.allowedOrigins`
   */
  async registerExternal(input: RegisterExternalInput, ctx?: MediaContext): Promise<IMediaDocument> {
    return registerExternalVerb(this, input, ctx);
  }

  // ============================================================
  // DOMAIN VERBS — Tags & Focal Point
  // ============================================================

  async addTags(id: string, tags: string[], ctx?: MediaContext): Promise<IMediaDocument> {
    return addTagsVerb(this, id, tags, ctx);
  }

  async removeTags(id: string, tags: string[], ctx?: MediaContext): Promise<IMediaDocument> {
    return removeTagsVerb(this, id, tags, ctx);
  }

  async setFocalPoint(id: string, focalPoint: FocalPoint, ctx?: MediaContext): Promise<IMediaDocument> {
    return setFocalPointVerb(this, id, focalPoint, ctx);
  }

  // ============================================================
  // DOMAIN VERBS — Presigned Uploads
  // ============================================================

  async getSignedUploadUrl(
    filename: string,
    contentType: string,
    options: { folder?: string; expiresIn?: number; size?: number } = {},
    ctx?: MediaContext,
  ): Promise<PresignedUploadResult> {
    const { getSignedUploadUrl: fn } = await import('../operations/presigned.js');
    return fn(this._opDeps, filename, contentType, options, this._opCtx(ctx));
  }

  async confirmUpload(input: ConfirmUploadInput, ctx?: MediaContext): Promise<IMediaDocument> {
    const { confirmUpload: fn } = await import('../operations/presigned.js');
    const result = await fn(this._opDeps, input, this._opCtx(ctx));

    await this.events.publish(
      createMediaEvent(
        MEDIA_EVENTS.UPLOAD_CONFIRMED,
        {
          assetId: String(result._id),
          key: result.key,
          filename: result.filename,
          mimeType: result.mimeType,
          size: result.size,
        },
        ctx,
        { resource: 'media', resourceId: String(result._id) },
      ),
    );

    return result;
  }

  async initiateMultipartUpload(input: InitiateMultipartInput, ctx?: MediaContext): Promise<MultipartUploadSession> {
    const { initiateMultipartUpload: fn } = await import('../operations/presigned.js');
    return fn(this._opDeps, input, this._opCtx(ctx));
  }

  async signUploadPart(
    key: string,
    uploadId: string,
    partNumber: number,
    expiresIn?: number,
  ): Promise<SignedPartResult> {
    const { signUploadPart: fn } = await import('../operations/presigned.js');
    return fn(this._opDeps, key, uploadId, partNumber, expiresIn);
  }

  async signUploadParts(
    key: string,
    uploadId: string,
    partNumbers: number[],
    expiresIn?: number,
  ): Promise<SignedPartResult[]> {
    const { signUploadParts: fn } = await import('../operations/presigned.js');
    return fn(this._opDeps, key, uploadId, partNumbers, expiresIn);
  }

  async completeMultipartUpload(input: CompleteMultipartInput, ctx?: MediaContext): Promise<IMediaDocument> {
    const { completeMultipartUpload: fn } = await import('../operations/presigned.js');
    const result = await fn(this._opDeps, input, this._opCtx(ctx));

    await this.events.publish(
      createMediaEvent(
        MEDIA_EVENTS.MULTIPART_COMPLETED,
        {
          assetId: String(result._id),
          key: result.key,
          filename: result.filename,
          size: result.size,
        },
        ctx,
        { resource: 'media', resourceId: String(result._id) },
      ),
    );

    return result;
  }

  async abortMultipartUpload(key: string, uploadId: string, ctx?: MediaContext): Promise<void> {
    const { abortMultipartUpload: fn } = await import('../operations/presigned.js');
    return fn(this._opDeps, key, uploadId, this._opCtx(ctx));
  }

  async generateBatchPutUrls(input: BatchPresignInput, ctx?: MediaContext): Promise<BatchPresignResult> {
    const { generateBatchPutUrls: fn } = await import('../operations/presigned.js');
    return fn(this._opDeps, input, this._opCtx(ctx));
  }

  // ============================================================
  // DOMAIN VERBS — Folder Operations
  // ============================================================

  async getFolderTree(ctx?: MediaContext): Promise<FolderTree> {
    return getFolderTreeVerb(this, ctx);
  }

  async getFolderStats(folder: string, ctx?: MediaContext): Promise<FolderStats> {
    return getFolderStatsVerb(this, folder, ctx);
  }

  getBreadcrumb(folder: string): BreadcrumbItem[] {
    return getBreadcrumbVerb(folder);
  }

  async deleteFolder(folder: string, ctx?: MediaContext): Promise<BulkResult> {
    return deleteFolderVerb(this, folder, ctx);
  }

  async renameFolder(oldPath: string, newPath: string, ctx?: MediaContext): Promise<RewriteResult> {
    return renameFolderVerb(this, oldPath, newPath, ctx);
  }

  async getSubfolders(parentPath: string, ctx?: MediaContext): Promise<FolderNode[]> {
    return getSubfoldersVerb(this, parentPath, ctx);
  }

  // ============================================================
  // DOMAIN VERBS — Bridges (source resolution, CDN URLs)
  // ============================================================

  /**
   * Resolve a single media doc's polymorphic source via SourceBridge.
   * Returns `null` when no source set, no bridge configured, or bridge returns null.
   */
  async resolveSource(media: IMediaDocument, ctx?: MediaContext): Promise<unknown | null> {
    return resolveSourceVerb(this, media, ctx);
  }

  /**
   * Batch-resolve polymorphic sources for a list of media docs.
   * Returns a Map<sourceId, sourceDoc> — use to enrich list responses without N+1.
   */
  async resolveSourcesMany(medias: IMediaDocument[], ctx?: MediaContext): Promise<Map<string, unknown>> {
    return resolveSourcesManyVerb(this, medias, ctx);
  }

  /**
   * Get the CDN-transformed URL for a media key. Falls back to driver.getPublicUrl
   * when no CdnBridge is configured.
   */
  async getAssetUrl(media: IMediaDocument, options?: { signed?: boolean; expiresIn?: number }): Promise<string> {
    return getAssetUrlVerb(this, media, options);
  }

  /**
   * Get CDN-transformed URLs for all variants of a media doc.
   * Returns an array of `{ name, url }` — variants pass through their own URL
   * when no CdnBridge is configured.
   */
  async getVariantUrls(
    media: IMediaDocument,
    options?: { signed?: boolean; expiresIn?: number },
  ): Promise<Array<{ name: string; url: string }>> {
    return getVariantUrlsVerb(this, media, options);
  }

  // ============================================================
  // DOMAIN VERBS — Private media (signing, revocation, LLM context)
  // ============================================================

  /**
   * Resolve an id-or-document argument to a document (plugin-routed read for ids).
   *
   * @internal Exposed for verb modules (./verbs/*) — not part of the public API.
   */
  public async _resolveDoc(idOrDoc: string | IMediaDocument, ctx?: MediaContext): Promise<IMediaDocument> {
    if (typeof idOrDoc !== 'string') return idOrDoc;
    const media = await this.getById(idOrDoc, { ...ctx, throwOnNotFound: false });
    if (!media) throw new Error(`Media ${idOrDoc} not found`);
    return media;
  }

  /**
   * Resolve a Sharp module — shared processor instance first, bare import as fallback.
   *
   * @internal Exposed for verb modules (./verbs/*) — not part of the public API.
   */
  public async _getSharp(): Promise<SharpModule | null> {
    try {
      if (this.processor && 'getSharpInstance' in this.processor) {
        return await (this.processor as ImageAdapter & SharpInstanceSource).getSharpInstance();
      }
      return (await import('sharp')).default;
    } catch {
      return null;
    }
  }

  /**
   * Mint a signed serve URL for an asset: `${servePath}/${id}[/variant]?e=...&kid=...&v=...&sig=...`.
   *
   * Requires engine `signing` config (`{ keys|secret, servePath, ... }`) —
   * throws a typed 500 `HttpError` (`code: 'media.signing.not_configured'`)
   * otherwise. The signature covers id, variant, expiry, kid, tokenVersion,
   * and every claim; `revokeAccess()` invalidates all outstanding URLs.
   *
   * When a CdnBridge is configured the minted URL is passed through
   * `bridges.cdn.transform(key, url, { signed: true, ... })` — the bridge
   * wins, so hosts can offload to CloudFront/edge signing instead.
   *
   * LLM note: URLs handed to LLM providers are re-fetched anonymously on
   * every chat-history replay — mint them with an `expiresIn` that covers the
   * conversation's lifetime, and do NOT re-sign the same asset per message
   * (a changing URL breaks Anthropic prompt caching). For indefinite access
   * prefer `getContextPayload()` (base64) or provider file ids.
   */
  async getSignedAssetUrl(
    idOrDoc: string | IMediaDocument,
    options: { variant?: string; expiresIn?: number; claims?: Record<string, string> } = {},
    ctx?: MediaContext,
  ): Promise<string> {
    return getSignedAssetUrlVerb(this, idOrDoc, options, ctx);
  }

  /**
   * Revoke every outstanding signed URL for an asset by bumping its
   * `tokenVersion` (`$inc`). Signed URLs embed the version they were minted
   * with; verification compares it to the doc's current value, so old URLs
   * fail with `version_mismatch` immediately. Routed through the plugin
   * pipeline (`findOneAndUpdate`) so tenant scoping and cache invalidation
   * fire like any other update.
   */
  async revokeAccess(idOrDoc: string | IMediaDocument, ctx?: MediaContext): Promise<IMediaDocument> {
    return revokeAccessVerb(this, idOrDoc, ctx);
  }

  /**
   * Load an asset's bytes for LLM context (works regardless of visibility —
   * this is a server-side read, the caller IS the trust boundary).
   *
   * - Streams from the driver with a hard cap (`maxBytes`, default 25MB) —
   *   exceeding it throws a 413 `HttpError` (`code: 'media.context.too_large'`).
   * - Images larger than `maxDimension` (default 1568px — Anthropic's token
   *   sweet spot; hard limits are 10MB / 8000px per image) are downscaled
   *   (fit inside, no enlargement) when sharp is available.
   * - Output is byte-stable for unchanged inputs — replaying the same base64
   *   in chat history is prompt-cache-friendly, unlike re-signed URLs.
   * - Bedrock/Vertex only accept base64 images — this is the portable path.
   *
   * @returns `{ data, contentType, bytes }` where `data` is a base64 string
   * (default), a `data:` URL, or a raw Buffer depending on `options.as`.
   */
  async getContextPayload(
    idOrDoc: string | IMediaDocument,
    options: { as?: 'base64' | 'dataUrl' | 'buffer'; maxDimension?: number; maxBytes?: number } = {},
    ctx?: MediaContext,
  ): Promise<{ data: string | Buffer; contentType: string; bytes: number }> {
    return getContextPayloadVerb(this, idOrDoc, options, ctx);
  }

  /**
   * Apply a pipeline of transform ops to an existing asset buffer.
   *
   * Ops are resolved from `bridges.transform.ops` and executed in order.
   * The asset's current buffer is read from storage, piped through each op,
   * and the result returned (NOT persisted). Callers decide what to do —
   * stream to response, cache in CDN, save as a new variant, etc.
   *
   * This is the primitive for building ImageKit-style URL transforms
   * (`GET /transform/:id?op=bg-remove,upscale&scale=4`).
   *
   * @throws if the media is not found, no TransformBridge configured, or any op is unknown
   */
  async applyTransforms(
    mediaId: string,
    options: { ops: string[]; params?: Record<string, string> },
    ctx?: MediaContext,
  ): Promise<TransformOpOutput> {
    return applyTransformsVerb(this, mediaId, options, ctx);
  }

  // ============================================================
  // DOMAIN VERBS — Analytics & Lookups
  // ============================================================

  async getByHash(hash: string, ctx?: MediaContext): Promise<IMediaDocument | null> {
    return getByHashVerb(this, hash, ctx);
  }

  /**
   * Pre-upload dedup handshake — "do you already have this file?".
   *
   * The WhatsApp "instant forward" recipe: the client hashes the file FIRST
   * (SHA-256 via `crypto.subtle.digest`), asks the server, and on a hit
   * skips the upload entirely, reusing the returned media's id (the same
   * `returnExisting` semantics `upload()` applies after receiving bytes —
   * this verb just moves the check before the bytes travel).
   *
   * Tenant-scoped through the SAME plugin-routed read as `getByHash()` —
   * NEVER cross-tenant. A globally-scoped answer would be an existence
   * oracle: anyone could probe "has someone, anywhere, uploaded this file?"
   * by hash. The same content uploaded by another tenant therefore reports
   * `exists: false` by design. Hosts MUST require auth on the endpoint that
   * proxies this verb. Full recipe: docs/guides/upload-profiles.mdx.
   *
   * Note: presigned confirms hash with a placeholder by default
   * (`hashStrategy: 'skip'`) — for the handshake to hit, confirm with a
   * real content hash (`hashStrategy: 'sha256'`) or store the client's
   * SHA-256 via server `upload()` with dedup enabled.
   */
  async existsByHash(
    hash: string,
    ctx?: MediaContext,
  ): Promise<{ exists: boolean; media?: IMediaDocument | undefined }> {
    return existsByHashVerb(this, hash, ctx);
  }

  async getStorageByFolder(ctx?: MediaContext): Promise<Array<{ folder: string; totalSize: number; count: number }>> {
    return getStorageByFolderVerb(this, ctx);
  }

  async getTotalStorageUsed(ctx?: MediaContext): Promise<number> {
    return getTotalStorageUsedVerb(this, ctx);
  }

  // ============================================================
  // DOMAIN VERBS — Utilities
  // ============================================================

  validateFile(buffer: Buffer, filename: string, mimeType: string): void {
    validateFileHelper({ config: this.mediaConfig }, buffer, filename, mimeType);
  }

  getContentType(folder: string): string {
    return getContentTypeHelper({ config: this.mediaConfig }, folder);
  }

  // ============================================================
  // INTERNAL — v2 compat bridge methods (used by operation helpers)
  // ============================================================

  /** @internal Used by operation helpers that expect v2 repo API */
  async createMedia(
    data: Record<string, unknown>,
    context?: OperationContext | Record<string, unknown>,
  ): Promise<IMediaDocument> {
    return this.create(data, context as Parameters<MediaRepository['create']>[1]);
  }

  /** @internal */
  async getMediaById(id: string, context?: OperationContext | Record<string, unknown>): Promise<IMediaDocument | null> {
    return this.getById(id, { ...(context || {}), throwOnNotFound: false });
  }

  /** @internal */
  async updateMedia(
    id: string,
    data: Record<string, unknown>,
    context?: OperationContext | Record<string, unknown>,
  ): Promise<IMediaDocument> {
    const updated = await this.update(id, data, context as Parameters<MediaRepository['update']>[2]);
    if (!updated) throw new Error(`[media-kit] Media not found: ${id}`);
    return updated;
  }

  /** @internal */
  async deleteMedia(id: string, context?: OperationContext | Record<string, unknown>): Promise<boolean> {
    try {
      await this.delete(id, { ...(context || {}), mode: 'hard' });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * @internal Unscoped key-existence probe used by confirmUpload's ownership
   * guard. Deliberately bypasses the plugin pipeline: the check must see
   * EVERY tenant's rows (including soft-deleted ones) — a tenant-scoped read
   * would let tenant A "confirm" (and later hard-delete) an object already
   * registered to tenant B under the same storage key.
   */
  async isKeyRegistered(key: string): Promise<boolean> {
    const found = await this.Model.exists({ key });
    return found !== null;
  }

  /**
   * @internal
   * Apply per-document updates and return BOTH which ids landed in the DB
   * AND which failed (with reason). Callers MUST use `succeededIds` to gate
   * any storage cleanup — silently swallowing failures while another phase
   * deletes the old object would corrupt storage.
   */
  async bulkUpdateMedia(
    updates: Array<{ id: string; data: Record<string, unknown> }>,
    context?: OperationContext | Record<string, unknown>,
  ): Promise<{
    modifiedCount: number;
    succeededIds: Set<string>;
    failed: Array<{ id: string; reason: string }>;
  }> {
    const succeededIds = new Set<string>();
    const failed: Array<{ id: string; reason: string }> = [];
    for (const { id, data } of updates) {
      try {
        const result = await this.update(id, data, context as Parameters<MediaRepository['update']>[2]);
        if (result === null) {
          failed.push({ id, reason: 'Update returned null (not found or scoped out)' });
          continue;
        }
        succeededIds.add(id);
      } catch (err) {
        failed.push({ id, reason: (err as Error).message });
      }
    }
    return { modifiedCount: succeededIds.size, succeededIds, failed };
  }
}
