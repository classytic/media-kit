/**
 * Focal point operation — set smart-cropping focal point on media.
 */

import type { OperationDeps } from './types';
import type { FocalPoint, OperationContext, IMediaDocument } from '../types';
import { log } from './helpers';

export async function setFocalPoint(
  deps: OperationDeps,
  id: string,
  focalPoint: FocalPoint,
  context?: OperationContext,
): Promise<IMediaDocument> {
  const existing = await deps.repository.getMediaById(id, context);
  if (!existing) {
    throw new Error(`Media not found: ${id}`);
  }

  if (focalPoint.x < 0 || focalPoint.x > 1 || focalPoint.y < 0 || focalPoint.y > 1) {
    throw new Error('Focal point coordinates must be between 0.0 and 1.0');
  }

  const media = await deps.repository.updateMedia(id, { focalPoint }, context);

  log(deps, 'info', 'Focal point set', { id, focalPoint });
  return media;
}
