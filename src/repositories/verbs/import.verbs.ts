/**
 * Move & import verbs — move, importFromUrl, registerExternal.
 *
 * Extracted from MediaRepository; each function takes the repository as its
 * first parameter. The class methods in media.repository.ts are thin
 * delegates that preserve the public API surface.
 */

import type { IMediaDocument, RewriteResult, ImportOptions, RegisterExternalInput } from '../../types.js';
import type { MediaContext } from '../../engine/engine-types.js';
import { MEDIA_EVENTS } from '../../events/event-constants.js';
import { createMediaEvent } from '../../events/helpers.js';
import { resolveVisibility } from '../../utils/visibility.js';
import { normalizeFolderPath } from '../../utils/folders.js';
import {
  EXTERNAL_PROVIDER,
  assertExternalUrl,
  assertExternalOriginAllowed,
  buildExternalKey,
  externalUrlHash,
} from '../../utils/external.js';
import {
  deriveAspectRatio,
  generateTitle,
  rewriteKey,
  executeKeyRewrite,
  type RewritableFile,
} from '../../operations/helpers.js';
import type { MediaRepository } from '../media.repository.js';

/**
 * Move files to a different folder. Supports key rewriting.
 */
export async function moveVerb(
  repo: MediaRepository,
  ids: string[],
  targetFolder: string,
  ctx?: MediaContext,
): Promise<RewriteResult> {
  const normalizedTarget = normalizeFolderPath(targetFolder);
  const rewriteKeys = repo.mediaConfig.folders?.rewriteKeys !== false;

  if (!rewriteKeys) {
    // Metadata-only move — plugin-routed so multiTenant + softDelete scope.
    const result = await repo.updateMany(
      { _id: { $in: ids } },
      { $set: { folder: normalizedTarget } },
      repo._tenantOpts(ctx) as Parameters<MediaRepository['updateMany']>[2],
    );
    const modifiedCount = result.modifiedCount ?? 0;
    await repo.events.publish(
      createMediaEvent(
        MEDIA_EVENTS.ASSET_MOVED,
        {
          assetIds: ids,
          fromFolder: '',
          toFolder: normalizedTarget,
          modifiedCount,
        },
        ctx,
      ),
    );
    return { modifiedCount, failed: [] };
  }

  // Full key rewrite — load via plugin-routed read so cross-tenant ids
  // can't leak into the rewrite plan.
  const found = await repo.getAll({ filters: { _id: { $in: ids } } }, {
    lean: true,
    ...repo._tenantOpts(ctx),
  } as Record<string, unknown>);
  const files = (Array.isArray(found) ? found : (found as { data: unknown[] }).data) as unknown as RewritableFile[];
  const result = await executeKeyRewrite(
    repo._opDeps,
    files,
    (file) => ({ newKey: rewriteKey(file.key, normalizedTarget), newFolder: normalizedTarget }),
    (variantKey) => rewriteKey(variantKey, normalizedTarget),
    'progress:move',
    repo._opCtx(ctx),
  );

  await repo.events.publish(
    createMediaEvent(
      MEDIA_EVENTS.ASSET_MOVED,
      {
        assetIds: ids,
        fromFolder: '',
        toFolder: normalizedTarget,
        modifiedCount: result.modifiedCount,
      },
      ctx,
    ),
  );

  return result;
}

/**
 * Import a file from a URL.
 */
export async function importFromUrlVerb(
  repo: MediaRepository,
  url: string,
  options?: ImportOptions,
  ctx?: MediaContext,
): Promise<IMediaDocument> {
  // Delegate to existing import logic (has SSRF protection)
  const { importFromUrl: importFn } = await import('../../operations/url-import.js');
  const result = await importFn(repo._opDeps, url, options, repo._opCtx(ctx));

  await repo.events.publish(
    createMediaEvent(
      MEDIA_EVENTS.ASSET_IMPORTED,
      {
        assetId: String(result._id),
        sourceUrl: url,
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
export async function registerExternalVerb(
  repo: MediaRepository,
  input: RegisterExternalInput,
  ctx?: MediaContext,
): Promise<IMediaDocument> {
  const url = assertExternalUrl(input.url);
  assertExternalOriginAllowed(url, repo.mediaConfig.external?.allowedOrigins);

  const targetFolder = normalizeFolderPath(input.folder || repo.mediaConfig.folders?.defaultFolder || 'general');
  // Same precedence as uploads: explicit > byFolder rule > config default > 'public'.
  const visibility = resolveVisibility(repo.mediaConfig.visibility, targetFolder, input.visibility);
  const key = buildExternalKey(input.url);

  // Filename: explicit > last URL path segment > sentinel-derived fallback.
  const pathSegment = decodeURIComponent(url.pathname.split('/').filter(Boolean).pop() ?? '');
  const filename = input.filename || pathSegment || `external-${externalUrlHash(input.url).slice(0, 16)}`;
  const sourceProvider = input.sourceProvider ?? EXTERNAL_PROVIDER;

  const media = await repo.create(
    {
      filename,
      originalFilename: filename,
      title: input.title || generateTitle(filename),
      mimeType: input.mimeType ?? 'application/octet-stream',
      size: input.size ?? 0,
      url: input.url,
      key,
      hash: externalUrlHash(input.url),
      provider: EXTERNAL_PROVIDER,
      status: 'ready',
      visibility,
      tokenVersion: 0,
      folder: targetFolder,
      tags: input.tags ?? [],
      variants: [],
      metadata: input.metadata ?? {},
      providerMetadata: { sourceProvider },
      width: input.width,
      height: input.height,
      aspectRatio: deriveAspectRatio(input.width, input.height),
      ...(input.alt !== undefined && { alt: input.alt }),
      ...(input.thumbhash !== undefined && { thumbhash: input.thumbhash }),
      ...(input.dominantColor !== undefined && { dominantColor: input.dominantColor }),
    },
    { session: ctx?.session, organizationId: ctx?.organizationId },
  );

  repo._log('info', 'External media registered', { id: media._id, url: input.url, sourceProvider });

  await repo.events.publish(
    createMediaEvent(
      MEDIA_EVENTS.ASSET_EXTERNAL_REGISTERED,
      {
        assetId: String(media._id),
        url: input.url,
        sourceProvider,
        filename: media.filename,
        mimeType: media.mimeType,
        size: media.size,
        folder: media.folder,
        key: media.key,
      },
      ctx,
      { resource: 'media', resourceId: String(media._id) },
    ),
  );

  return media;
}
