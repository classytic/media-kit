/**
 * Tag operations — atomic add/remove via repository.
 */

import type { OperationDeps } from './types';
import type { OperationContext, IMediaDocument } from '../types';
import { log } from './helpers';

export async function addTags(
  deps: OperationDeps,
  id: string,
  tags: string[],
  context?: OperationContext,
): Promise<IMediaDocument> {
  const media = await deps.repository.addTags(id, tags, context);
  if (!media) {
    throw new Error(`Media not found: ${id}`);
  }

  log(deps, 'info', 'Tags added', { id, added: tags });
  return media;
}

export async function removeTags(
  deps: OperationDeps,
  id: string,
  tags: string[],
  context?: OperationContext,
): Promise<IMediaDocument> {
  const media = await deps.repository.removeTags(id, tags, context);
  if (!media) {
    throw new Error(`Media not found: ${id}`);
  }

  log(deps, 'info', 'Tags removed', { id, removed: tags });
  return media;
}
