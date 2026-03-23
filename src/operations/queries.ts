/**
 * Query operations — getById, getAll, search.
 * Pure repository delegates.
 */

import type { OperationDeps } from './types';
import type { OperationContext, IMediaDocument } from '../types';
import type {
  OffsetPaginationResult,
  KeysetPaginationResult,
  SortSpec,
} from '@classytic/mongokit';

export async function getById(
  deps: OperationDeps,
  id: string,
  context?: OperationContext,
): Promise<IMediaDocument | null> {
  return deps.repository.getMediaById(id, context);
}

export async function getAll(
  deps: OperationDeps,
  params: {
    filters?: Record<string, unknown>;
    sort?: SortSpec | string;
    limit?: number;
    page?: number;
    cursor?: string;
    after?: string;
    search?: string;
  } = {},
  context?: OperationContext,
): Promise<OffsetPaginationResult<IMediaDocument> | KeysetPaginationResult<IMediaDocument>> {
  return deps.repository.getAllMedia(params, context);
}

export async function search(
  deps: OperationDeps,
  query: string,
  params: { limit?: number; page?: number; filters?: Record<string, unknown> } = {},
  context?: OperationContext,
): Promise<OffsetPaginationResult<IMediaDocument> | KeysetPaginationResult<IMediaDocument>> {
  return deps.repository.searchMedia(query, params, context);
}
