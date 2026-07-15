/**
 * Annotation verbs — addTags, removeTags, setFocalPoint.
 *
 * Extracted from MediaRepository; each function takes the repository as its
 * first parameter. The class methods in media.repository.ts are thin
 * delegates that preserve the public API surface.
 */

import type { IMediaDocument, FocalPoint } from '../../types.js';
import type { MediaContext } from '../../engine/engine-types.js';
import { MEDIA_EVENTS } from '../../events/event-constants.js';
import { createMediaEvent } from '../../events/helpers.js';
import type { MediaRepository } from '../media.repository.js';

export async function addTagsVerb(
  repo: MediaRepository,
  id: string,
  tags: string[],
  ctx?: MediaContext,
): Promise<IMediaDocument> {
  // Route through `repo.findOneAndUpdate` (the repo method) — NOT
  // `repo.Model.findOneAndUpdate` (the raw mongoose call). The repo
  // method threads the `before:findOneAndUpdate` plugin pipeline so
  // multi-tenant scope, soft-delete filter, audit, and cache
  // invalidation all fire. The raw mongoose call bypasses every
  // plugin — a silent cross-tenant write surface.
  const result = await repo.findOneAndUpdate({ _id: id }, { $addToSet: { tags: { $each: tags } } }, {
    returnDocument: 'after',
    ...(ctx?.organizationId !== undefined && { organizationId: ctx.organizationId }),
    ...(ctx?.session !== undefined && { session: ctx.session }),
  } as Record<string, unknown>);
  if (!result) throw new Error(`Media ${id} not found`);

  await repo.events.publish(
    createMediaEvent(
      MEDIA_EVENTS.ASSET_TAGGED,
      {
        assetId: id,
        tags,
      },
      ctx,
      { resource: 'media', resourceId: id },
    ),
  );

  return result;
}

export async function removeTagsVerb(
  repo: MediaRepository,
  id: string,
  tags: string[],
  ctx?: MediaContext,
): Promise<IMediaDocument> {
  const result = await repo.findOneAndUpdate({ _id: id }, { $pull: { tags: { $in: tags } } }, {
    returnDocument: 'after',
    ...(ctx?.organizationId !== undefined && { organizationId: ctx.organizationId }),
    ...(ctx?.session !== undefined && { session: ctx.session }),
  } as Record<string, unknown>);
  if (!result) throw new Error(`Media ${id} not found`);

  await repo.events.publish(
    createMediaEvent(
      MEDIA_EVENTS.ASSET_UNTAGGED,
      {
        assetId: id,
        tags,
      },
      ctx,
      { resource: 'media', resourceId: id },
    ),
  );

  return result;
}

export async function setFocalPointVerb(
  repo: MediaRepository,
  id: string,
  focalPoint: FocalPoint,
  ctx?: MediaContext,
): Promise<IMediaDocument> {
  if (focalPoint.x < 0 || focalPoint.x > 1 || focalPoint.y < 0 || focalPoint.y > 1) {
    throw new Error('Focal point coordinates must be between 0 and 1');
  }
  const result = await repo.findOneAndUpdate({ _id: id }, { $set: { focalPoint } }, {
    returnDocument: 'after',
    ...(ctx?.organizationId !== undefined && { organizationId: ctx.organizationId }),
    ...(ctx?.session !== undefined && { session: ctx.session }),
  } as Record<string, unknown>);
  if (!result) throw new Error(`Media ${id} not found`);

  await repo.events.publish(
    createMediaEvent(
      MEDIA_EVENTS.FOCAL_POINT_SET,
      {
        assetId: id,
        focalPoint,
      },
      ctx,
      { resource: 'media', resourceId: id },
    ),
  );

  return result;
}
