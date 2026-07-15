/**
 * Analytics & lookup verbs — getByHash, existsByHash, getStorageByFolder,
 * getTotalStorageUsed.
 *
 * Extracted from MediaRepository; each function takes the repository as its
 * first parameter. The class methods in media.repository.ts are thin
 * delegates that preserve the public API surface.
 */

import type { IMediaDocument } from '../../types.js';
import type { MediaContext } from '../../engine/engine-types.js';
import type { MediaRepository } from '../media.repository.js';

export async function getByHashVerb(
  repo: MediaRepository,
  hash: string,
  ctx?: MediaContext,
): Promise<IMediaDocument | null> {
  // Plugin-routed read — multiTenantPlugin scopes on the configured
  // tenant field (not always 'organizationId'); softDeletePlugin
  // applies the deleted-at filter.
  return (await repo.getByQuery({ hash }, {
    ...repo._tenantOpts(ctx),
    throwOnNotFound: false,
  } as Record<string, unknown>)) as IMediaDocument | null;
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
export async function existsByHashVerb(
  repo: MediaRepository,
  hash: string,
  ctx?: MediaContext,
): Promise<{ exists: boolean; media?: IMediaDocument | undefined }> {
  const media = await repo.getByHash(hash, ctx);
  if (!media) return { exists: false };
  return { exists: true, media };
}

export async function getStorageByFolderVerb(
  repo: MediaRepository,
  ctx?: MediaContext,
): Promise<Array<{ folder: string; totalSize: number; count: number }>> {
  return (await repo.aggregatePipeline(
    [
      { $group: { _id: '$folder', totalSize: { $sum: '$size' }, count: { $sum: 1 } } },
      { $project: { folder: '$_id', totalSize: 1, count: 1, _id: 0 } },
      { $sort: { totalSize: -1 } },
    ],
    repo._tenantOpts(ctx),
  )) as Array<{ folder: string; totalSize: number; count: number }>;
}

export async function getTotalStorageUsedVerb(repo: MediaRepository, ctx?: MediaContext): Promise<number> {
  const [result] = (await repo.aggregatePipeline(
    [{ $group: { _id: null, total: { $sum: '$size' } } }],
    repo._tenantOpts(ctx),
  )) as Array<{ total: number }>;
  return result?.total ?? 0;
}
