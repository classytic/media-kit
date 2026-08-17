/**
 * Analytics & lookup verbs — getByHash, existsByHash, getStorageByFolder,
 * getTotalStorageUsed.
 *
 * Extracted from MediaRepository; each function takes the repository as its
 * first parameter. The class methods in media.repository.ts are thin
 * delegates that preserve the public API surface.
 */

import type { IMediaDocument } from '../../types/media.js';
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
/**
 * Is there already an asset with this content hash?
 *
 * ## `expectedSize` — why a hash match is not enough on its own
 *
 * On the presigned path the hash is COMPUTED BY THE CLIENT (it must be: the
 * lookup happens before any bytes are uploaded). So a caller can claim any
 * hash for any content. The damage is not to itself — it is to the NEXT
 * genuine upload of the real file with that hash, which would short-circuit to
 * the attacker's asset and never upload at all.
 *
 * A full fix means a storage-validated checksum. What is free right now is a
 * consistency check: the caller states the byte size in the same request, and
 * two files with one hash but different sizes cannot both be right. Passing
 * `expectedSize` makes a mismatch REFUSE the dedup — the upload simply proceeds
 * normally, which costs one upload and cannot return the wrong asset.
 *
 * It is a parameter rather than an internal rule because only the caller knows
 * whether it has a trustworthy size; omitting it keeps the old behaviour rather
 * than silently rejecting callers that cannot supply one.
 */
export async function existsByHashVerb(
  repo: MediaRepository,
  hash: string,
  ctx?: MediaContext,
  options?: { expectedSize?: number | undefined },
): Promise<{ exists: boolean; media?: IMediaDocument | undefined }> {
  const media = await repo.getByHash(hash, ctx);
  if (!media) return { exists: false };

  const expected = options?.expectedSize;
  if (typeof expected === 'number' && Number.isFinite(expected) && media.size !== expected) {
    // Same hash, different length — at least one claim is false. Decline the
    // short-circuit rather than hand back an asset that is not this file.
    return { exists: false };
  }

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
