/**
 * Media Repository
 *
 * Extends mongokit Repository with media-specific operations.
 * Uses mongokit's multiTenantPlugin for tenant isolation instead of hand-rolled hooks.
 * Soft-delete query filtering is registered as lightweight hooks (not softDeletePlugin,
 * because media-kit needs delete() = hard delete, softDelete() = separate operation).
 *
 * @example
 * ```ts
 * import { createMediaRepository } from '@classytic/media-kit';
 *
 * const mediaRepo = createMediaRepository(MediaModel, {
 *   multiTenancy: { enabled: true, field: 'organizationId' }
 * });
 *
 * // Mongokit pagination (auto-detects offset vs keyset)
 * const result = await mediaRepo.getAllMedia({
 *   filters: { folder: 'products' },
 *   sort: { createdAt: -1 },
 *   limit: 20
 * });
 * ```
 */

import { Repository, multiTenantPlugin, cachePlugin, aggregateHelpersPlugin, methodRegistryPlugin, QueryParser } from '@classytic/mongokit';
import type { ParsedQuery, QueryParserOptions, PopulateOption } from '@classytic/mongokit';
import type { Model, PipelineStage } from 'mongoose';
import type {
  PluginType,
  PaginationConfig,
  OffsetPaginationResult,
  KeysetPaginationResult,
  SortSpec,
} from '@classytic/mongokit';
import type {
  IMediaDocument,
  FolderTree,
  FolderStats,
  FolderNode,
  OperationContext,
  MultiTenancyConfig,
  BreadcrumbItem,
  FocalPoint,
} from '../types';
import { buildFolderTree, getBreadcrumb, getDirectChildren, escapeRegex } from '../utils/folders';

/**
 * Repository options
 */
export interface MediaRepositoryOptions {
  /** Default limit for pagination */
  defaultLimit?: number;
  /** Maximum limit for pagination */
  maxLimit?: number;
  /** Multi-tenancy config */
  multiTenancy?: MultiTenancyConfig;
  /** Mongokit plugins to apply */
  plugins?: PluginType[];
  /** Pagination configuration */
  pagination?: PaginationConfig;
  /** QueryParser options for URL-based filtering. Set false to disable. */
  queryParser?: QueryParserOptions | false;
  /** Cache adapter config for read-through caching */
  cache?: {
    adapter: {
      get(key: string): Promise<string | null>;
      set(key: string, value: string, ttl?: number): Promise<void>;
      del(key: string): Promise<void>;
      clear(pattern: string): Promise<void>;
    };
    byIdTtl?: number;
    queryTtl?: number;
    prefix?: string;
  };
}

/**
 * Folder aggregation result
 */
export interface FolderAggregateResult {
  folder: string;
  count: number;
  totalSize: number;
  latestUpload: Date;
}

/**
 * Media Repository Class
 * Extends mongokit Repository with media-specific operations.
 *
 * Uses multiTenantPlugin for automatic tenant isolation on all mongokit lifecycle
 * operations (getById, getAll, create, update, delete).
 *
 * For direct Model operations (tags, focal point, aggregation), uses _buildQueryFilters()
 * to manually apply tenant + soft-delete filters.
 */
export class MediaRepository extends Repository<IMediaDocument> {
  protected mediaOptions: MediaRepositoryOptions;
  public readonly queryParser: QueryParser | null;

  constructor(
    model: Model<IMediaDocument>,
    options: MediaRepositoryOptions = {}
  ) {
    const plugins: PluginType[] = [];

    // Use mongokit's multiTenantPlugin for automatic tenant isolation
    if (options.multiTenancy?.enabled) {
      plugins.unshift(multiTenantPlugin({
        tenantField: options.multiTenancy.field || 'organizationId',
        contextKey: 'organizationId',
        required: options.multiTenancy.required ?? false,
      }));
    }

    // Core plugins (always enabled)
    plugins.push(methodRegistryPlugin());
    plugins.push(aggregateHelpersPlugin());

    // Cache plugin (optional — user provides adapter)
    if (options.cache) {
      plugins.push(cachePlugin({
        adapter: options.cache.adapter as any,
        byIdTtl: options.cache.byIdTtl ?? 60,
        queryTtl: options.cache.queryTtl ?? 30,
        prefix: options.cache.prefix ?? 'mk',
      }));
    }

    // User-provided plugins come after built-in ones
    if (options.plugins) {
      plugins.push(...options.plugins);
    }

    super(model, plugins, {
      defaultLimit: options.defaultLimit || 20,
      maxLimit: options.maxLimit || 100,
      ...options.pagination,
    });

    this.mediaOptions = {
      defaultLimit: 20,
      maxLimit: 100,
      ...options,
    };

    // Pre-configured QueryParser for URL-based filtering
    if (options.queryParser !== false) {
      this.queryParser = new QueryParser({
        searchMode: 'regex',
        searchFields: ['filename', 'originalFilename', 'title', 'description', 'tags', 'alt'],
        maxLimit: options.maxLimit || 100,
        allowedFilterFields: [
          'folder', 'mimeType', 'size', 'status', 'tags', 'uploadedBy',
          'width', 'height', 'createdAt', 'updatedAt', 'hash',
        ],
        allowedSortFields: [
          'filename', 'size', 'mimeType', 'createdAt', 'updatedAt', 'folder', 'width', 'height',
        ],
        enableLookups: false,
        enableAggregations: false,
        ...(typeof options.queryParser === 'object' ? options.queryParser : {}),
      } as QueryParserOptions);
    } else {
      this.queryParser = null;
    }

    // Register soft-delete query filtering hooks.
    // We don't use softDeletePlugin because media-kit needs delete() = hard delete.
    // Instead we register lightweight hooks that auto-exclude trashed docs.
    this._registerSoftDeleteFilters();
  }

  /**
   * Register hooks that auto-inject { deletedAt: null } into read queries,
   * unless context.includeDeleted is true.
   */
  private _registerSoftDeleteFilters(): void {
    const injectFilter = (context: any) => {
      if (context.includeDeleted) return;

      // getAll uses context.filters
      if (context.operation === 'getAll' || context.operation === 'aggregatePaginate') {
        context.filters = { ...context.filters, deletedAt: null };
      }
      // getById/getByQuery use context.query
      if (context.operation === 'getById' || context.operation === 'getByQuery') {
        context.query = { ...(context.query || {}), deletedAt: null };
      }
    };

    this.on('before:getAll', injectFilter);
    this.on('before:getById', injectFilter);
    this.on('before:getByQuery', injectFilter);
    this.on('before:aggregatePaginate', injectFilter);
  }

  // ============================================
  // CONTEXT HELPERS
  // ============================================

  /**
   * Convert media-kit OperationContext to mongokit options.
   * Maps includeTrashed → includeDeleted so the soft-delete hooks work.
   * Passes organizationId so multiTenantPlugin can read it.
   */
  private _toRepoOptions(context?: OperationContext): Record<string, unknown> {
    if (!context) return {};
    const { includeTrashed, ...rest } = context;
    return {
      ...rest,
      ...(includeTrashed !== undefined && { includeDeleted: includeTrashed }),
    };
  }

  /**
   * Parse URL query params into a mongokit-compatible query.
   * App-level API routes call this with `req.query`.
   *
   * @example
   * ```ts
   * const parsed = mediaRepo.parseQuery(req.query);
   * const result = await mediaRepo.getAllMedia(parsed, context);
   * ```
   */
  parseQuery(query: Record<string, unknown>): ParsedQuery {
    if (!this.queryParser) {
      throw new Error('QueryParser is disabled. Set queryParser options to enable.');
    }
    return this.queryParser.parse(query);
  }

  /**
   * Build query filters for direct Model operations that bypass mongokit lifecycle.
   * Applies both soft-delete and multi-tenancy filters.
   */
  private _buildQueryFilters(
    filters: Record<string, unknown> = {},
    context?: OperationContext
  ): Record<string, unknown> {
    const query: Record<string, unknown> = { ...filters };

    // Soft delete filter
    if (!context?.includeTrashed) {
      query.deletedAt = null;
    }

    // Tenant filter — enforce required mode (mirrors requireTenant in operations/helpers)
    if (this.mediaOptions.multiTenancy?.enabled) {
      const field = this.mediaOptions.multiTenancy.field || 'organizationId';
      if (!context?.organizationId && this.mediaOptions.multiTenancy.required) {
        throw new Error(`Multi-tenancy required: '${field}' is missing in context`);
      }
      if (context?.organizationId) {
        query[field] = context.organizationId;
      }
    }

    return query;
  }

  // ============================================
  // MEDIA-SPECIFIC CRUD OPERATIONS
  // ============================================

  /**
   * Create media document with context support.
   */
  async createMedia(
    data: Partial<IMediaDocument>,
    context?: OperationContext
  ): Promise<IMediaDocument> {
    return this.create({
      ...data,
      uploadedBy: context?.userId,
    } as Record<string, unknown>, this._toRepoOptions(context));
  }

  /**
   * Get media by ID with tenant + soft-delete isolation.
   * Returns null if not found (unlike mongokit's default 404 behavior).
   */
  async getMediaById(
    id: string,
    context?: OperationContext
  ): Promise<IMediaDocument | null> {
    return this.getById(id, {
      lean: true,
      throwOnNotFound: false,
      ...this._toRepoOptions(context),
    });
  }

  /**
   * Get all media with filters and context.
   * Leverages mongokit's smart pagination (auto-detects offset vs keyset).
   */
  async getAllMedia(
    params: {
      filters?: Record<string, unknown>;
      sort?: SortSpec | string;
      limit?: number;
      page?: number;
      cursor?: string;
      after?: string;
      search?: string;
      select?: Record<string, 0 | 1>;
      populateOptions?: PopulateOption[];
    } = {},
    context?: OperationContext
  ): Promise<OffsetPaginationResult<IMediaDocument> | KeysetPaginationResult<IMediaDocument>> {
    const { select, ...getAllParams } = params;
    return this.getAll(getAllParams, {
      ...this._toRepoOptions(context),
      ...(select && { select }),
    });
  }

  /**
   * Update media by ID with tenant isolation via multiTenantPlugin hooks.
   */
  async updateMedia(
    id: string,
    data: Partial<IMediaDocument>,
    context?: OperationContext
  ): Promise<IMediaDocument> {
    return this.update(id, data as Record<string, unknown>, this._toRepoOptions(context));
  }

  /**
   * Delete media by ID (hard delete) with tenant isolation.
   */
  async deleteMedia(id: string, context?: OperationContext): Promise<boolean> {
    try {
      const result = await this.delete(id, this._toRepoOptions(context));
      return result.success;
    } catch (err: any) {
      // 404 from mongokit = not found or wrong tenant
      if (err.status === 404 || err.statusCode === 404) {
        return false;
      }
      throw err;
    }
  }

  /**
   * Delete many media by IDs with context.
   * Iterates through mongokit's delete() lifecycle per ID so hooks fire correctly.
   */
  async deleteManyMedia(ids: string[], context?: OperationContext): Promise<number> {
    let deletedCount = 0;
    const opts = this._toRepoOptions(context);

    for (const id of ids) {
      try {
        const result = await this.delete(id, opts);
        if (result.success) deletedCount++;
      } catch {
        // Skip not-found or failed deletes
      }
    }

    return deletedCount;
  }

  // ============================================
  // SOFT DELETE OPERATIONS
  // ============================================

  /**
   * Soft delete a media document by setting deletedAt.
   */
  async softDelete(
    id: string,
    context?: OperationContext
  ): Promise<IMediaDocument | null> {
    try {
      return await this.update(id, { deletedAt: new Date() } as any, this._toRepoOptions(context));
    } catch (err: any) {
      if (err.status === 404 || err.statusCode === 404) return null;
      throw err;
    }
  }

  /**
   * Restore a soft-deleted media document.
   */
  async restore(
    id: string,
    context?: OperationContext
  ): Promise<IMediaDocument | null> {
    // Must include trashed to find the soft-deleted doc
    const opts = this._toRepoOptions({ ...context, includeTrashed: true });
    try {
      return await this.update(id, { deletedAt: null } as any, opts);
    } catch (err: any) {
      if (err.status === 404 || err.statusCode === 404) return null;
      throw err;
    }
  }

  /**
   * Purge (hard-delete) all soft-deleted documents older than the given date.
   * Returns the IDs of purged documents so the caller can clean up storage.
   */
  async purgeDeleted(
    olderThan?: Date,
    context?: OperationContext
  ): Promise<string[]> {
    const trashedOpts = this._toRepoOptions({ ...context, includeTrashed: true });

    const deletedAtFilter: Record<string, unknown> = olderThan
      ? { deletedAt: { $ne: null, $lt: olderThan } }
      : { deletedAt: { $ne: null } };

    // Find all matching documents
    const result = await this.getAll({
      filters: deletedAtFilter,
      limit: 10000,
    }, trashedOpts);

    const ids = result.docs.map(doc => doc._id.toString());

    // Hard-delete each through mongokit lifecycle
    for (const id of ids) {
      try {
        await this.delete(id, trashedOpts);
      } catch {
        // Skip failed deletes
      }
    }

    return ids;
  }

  // ============================================
  // TAG OPERATIONS
  // ============================================

  /**
   * Add tags to a media document using $addToSet with $each
   */
  async addTags(
    id: string,
    tags: string[],
    context?: OperationContext
  ): Promise<IMediaDocument | null> {
    const filters = this._buildQueryFilters({ _id: id }, context);

    const doc = await this.Model.findOneAndUpdate(
      filters,
      { $addToSet: { tags: { $each: tags } } },
      { returnDocument: 'after' }
    ).lean();

    return doc as IMediaDocument | null;
  }

  /**
   * Remove tags from a media document using $pull with $in
   */
  async removeTags(
    id: string,
    tags: string[],
    context?: OperationContext
  ): Promise<IMediaDocument | null> {
    const filters = this._buildQueryFilters({ _id: id }, context);

    const doc = await this.Model.findOneAndUpdate(
      filters,
      { $pull: { tags: { $in: tags } } },
      { returnDocument: 'after' }
    ).lean();

    return doc as IMediaDocument | null;
  }

  /**
   * Find all media with a specific tag
   */
  async findByTag(
    tag: string,
    params: {
      limit?: number;
      page?: number;
      sort?: SortSpec | string;
      after?: string;
    } = {},
    context?: OperationContext
  ): Promise<OffsetPaginationResult<IMediaDocument> | KeysetPaginationResult<IMediaDocument>> {
    return this.getAllMedia({
      ...params,
      filters: { tags: tag },
    }, context);
  }

  // ============================================
  // FOCAL POINT
  // ============================================

  /**
   * Set the focal point for a media document (used for smart cropping)
   */
  async setFocalPoint(
    id: string,
    focalPoint: FocalPoint,
    context?: OperationContext
  ): Promise<IMediaDocument | null> {
    const filters = this._buildQueryFilters({ _id: id }, context);

    const doc = await this.Model.findOneAndUpdate(
      filters,
      { $set: { focalPoint } },
      { returnDocument: 'after' }
    ).lean();

    return doc as IMediaDocument | null;
  }

  // ============================================
  // FOLDER OPERATIONS
  // ============================================

  /**
   * Get distinct folders with stats using aggregation
   */
  async getDistinctFolders(context?: OperationContext): Promise<FolderAggregateResult[]> {
    const matchStage = this._buildQueryFilters({}, context);

    const pipeline: PipelineStage[] = [];

    if (Object.keys(matchStage).length > 0) {
      pipeline.push({ $match: matchStage });
    }

    pipeline.push(
      {
        $group: {
          _id: '$folder',
          count: { $sum: 1 },
          totalSize: { $sum: '$size' },
          latestUpload: { $max: '$createdAt' },
        },
      },
      {
        $project: {
          _id: 0,
          folder: '$_id',
          count: 1,
          totalSize: 1,
          latestUpload: 1,
        },
      },
      { $sort: { folder: 1 } }
    );

    return this.aggregate<FolderAggregateResult>(pipeline);
  }

  /**
   * Get folder tree for UI navigation
   */
  async getFolderTree(context?: OperationContext): Promise<FolderTree> {
    const folders = await this.getDistinctFolders(context);
    return buildFolderTree(folders);
  }

  /**
   * Get stats for a specific folder
   */
  async getFolderStats(
    folderPath: string,
    context?: OperationContext,
    includeSubfolders = true
  ): Promise<FolderStats> {
    const folderQuery = includeSubfolders
      ? { $regex: `^${escapeRegex(folderPath)}` }
      : folderPath;

    const matchStage = this._buildQueryFilters({ folder: folderQuery }, context);

    const [stats] = await this.aggregate<FolderStats & { _id: null }>([
      { $match: matchStage },
      {
        $group: {
          _id: null,
          totalFiles: { $sum: 1 },
          totalSize: { $sum: '$size' },
          avgSize: { $avg: '$size' },
          mimeTypes: { $addToSet: '$mimeType' },
          oldestFile: { $min: '$createdAt' },
          newestFile: { $max: '$createdAt' },
        },
      },
    ], context as Record<string, unknown>);

    return stats || {
      totalFiles: 0,
      totalSize: 0,
      avgSize: 0,
      mimeTypes: [],
      oldestFile: null,
      newestFile: null,
    };
  }

  /**
   * Get breadcrumb for folder path
   */
  getBreadcrumb(folderPath: string): BreadcrumbItem[] {
    return getBreadcrumb(folderPath);
  }

  /**
   * Get files in a folder with pagination
   */
  async getByFolder(
    folder: string,
    params: {
      limit?: number;
      sort?: SortSpec | string;
      page?: number;
      after?: string;
    } = {},
    context?: OperationContext
  ): Promise<OffsetPaginationResult<IMediaDocument> | KeysetPaginationResult<IMediaDocument>> {
    return this.getAllMedia({
      ...params,
      filters: { folder },
    }, context);
  }

  /**
   * Move files to a different folder.
   */
  async moveToFolder(
    ids: string[],
    targetFolder: string,
    context?: OperationContext
  ): Promise<{ modifiedCount: number }> {
    const filters = this._buildQueryFilters({ _id: { $in: ids } }, context);

    const result = await this.Model.updateMany(filters, {
      $set: { folder: targetFolder },
    });

    return { modifiedCount: result.modifiedCount };
  }

  /**
   * Get multiple media documents by IDs with tenant filtering.
   */
  async getMediaByIds(
    ids: string[],
    context?: OperationContext,
  ): Promise<IMediaDocument[]> {
    const filters = this._buildQueryFilters({ _id: { $in: ids } }, context);
    return this.Model.find(filters).lean();
  }

  /**
   * Bulk update individual media documents.
   * Each entry specifies an ID and a set of fields to update.
   */
  async bulkUpdateMedia(
    updates: Array<{ id: string; data: Record<string, unknown> }>,
    context?: OperationContext,
  ): Promise<{ modifiedCount: number }> {
    if (updates.length === 0) return { modifiedCount: 0 };

    const bulkOps = updates.map(({ id, data }) => ({
      updateOne: {
        filter: this._buildQueryFilters({ _id: id }, context),
        update: { $set: data },
      },
    }));

    const result = await this.Model.bulkWrite(bulkOps);
    return { modifiedCount: result.modifiedCount };
  }

  /**
   * Get all files in folder (for deletion)
   */
  async getFilesInFolder(
    folderPath: string,
    context?: OperationContext,
    includeSubfolders = true
  ): Promise<IMediaDocument[]> {
    const folderQuery = includeSubfolders
      ? { $regex: `^${escapeRegex(folderPath)}` }
      : folderPath;

    const filters = this._buildQueryFilters({ folder: folderQuery }, context);

    return this.Model.find(filters).lean();
  }

  /**
   * Search media (delegates to mongokit's built-in search via getAll)
   */
  async searchMedia(
    searchTerm: string,
    params: {
      filters?: Record<string, unknown>;
      limit?: number;
      page?: number;
    } = {},
    context?: OperationContext
  ): Promise<OffsetPaginationResult<IMediaDocument> | KeysetPaginationResult<IMediaDocument>> {
    return this.getAllMedia({
      ...params,
      search: searchTerm,
    }, context);
  }

  /**
   * Get media by hash (for deduplication)
   */
  async getByHash(
    hash: string,
    context?: OperationContext
  ): Promise<IMediaDocument | null> {
    const filters = this._buildQueryFilters({ hash }, context);
    return this.Model.findOne(filters).lean();
  }

  /**
   * Count media in folder
   */
  async countInFolder(
    folder: string,
    context?: OperationContext,
    includeSubfolders = true
  ): Promise<number> {
    const folderQuery = includeSubfolders
      ? { $regex: `^${escapeRegex(folder)}` }
      : folder;

    const filters = this._buildQueryFilters({ folder: folderQuery }, context);
    return this.count(filters);
  }

  /**
   * Get media by MIME type
   */
  async getByMimeType(
    mimeType: string | string[],
    params: { limit?: number; page?: number } = {},
    context?: OperationContext
  ): Promise<OffsetPaginationResult<IMediaDocument> | KeysetPaginationResult<IMediaDocument>> {
    const mimeFilter = Array.isArray(mimeType)
      ? { $in: mimeType }
      : mimeType.includes('*')
        ? { $regex: `^${mimeType.replace('*', '.*')}` }
        : mimeType;

    return this.getAllMedia({
      ...params,
      filters: { mimeType: mimeFilter },
    }, context);
  }

  /**
   * Get recent uploads
   */
  async getRecentUploads(
    limit = 10,
    context?: OperationContext
  ): Promise<IMediaDocument[]> {
    const result = await this.getAllMedia({
      sort: { createdAt: -1 },
      limit,
    }, context);

    return result.docs;
  }

  /**
   * Get total storage used
   */
  async getTotalStorageUsed(context?: OperationContext): Promise<number> {
    const filters = this._buildQueryFilters({}, context);
    return (this as any).sum('size', filters) ?? 0;
  }

  /**
   * Get storage breakdown by folder.
   */
  async getStorageByFolder(context?: OperationContext): Promise<Array<{
    folder: string;
    size: number;
    count: number;
    percentage: number;
  }>> {
    const matchStage = this._buildQueryFilters({}, context);

    const results = await this.aggregate<{
      folder: string;
      size: number;
      count: number;
    }>([
      ...(Object.keys(matchStage).length > 0 ? [{ $match: matchStage }] : []),
      {
        $group: {
          _id: '$folder',
          size: { $sum: '$size' },
          count: { $sum: 1 },
        },
      },
      {
        $project: {
          _id: 0,
          folder: '$_id',
          size: 1,
          count: 1,
        },
      },
      { $sort: { size: -1 } },
    ]);

    const totalSize = results.reduce((sum, r) => sum + r.size, 0);

    return results.map(r => ({
      ...r,
      percentage: totalSize > 0 ? Math.round((r.size / totalSize) * 100) : 0,
    }));
  }

  // ============================================
  // ADVANCED FOLDER OPERATIONS
  // ============================================

  /**
   * Rename/move a folder and all its subfolders.
   */
  async renameFolder(
    oldPath: string,
    newPath: string,
    context?: OperationContext
  ): Promise<{ modifiedCount: number }> {
    const escapedOld = escapeRegex(oldPath);

    const folderRegex = new RegExp(`^${escapedOld}(/|$)`);
    const matchFilters = this._buildQueryFilters({ folder: { $regex: folderRegex } }, context);

    const docs = await this.Model.find(matchFilters, { _id: 1, folder: 1 }).lean();

    if (docs.length === 0) {
      return { modifiedCount: 0 };
    }

    const bulkOps = docs.map((doc: any) => {
      const newFolder = doc.folder === oldPath
        ? newPath
        : newPath + doc.folder.slice(oldPath.length);

      return {
        updateOne: {
          filter: { _id: doc._id },
          update: { $set: { folder: newFolder } },
        },
      };
    });

    const result = await this.Model.bulkWrite(bulkOps);
    return { modifiedCount: result.modifiedCount };
  }

  /**
   * Get immediate subfolders of a path with aggregated stats.
   */
  async getSubfolders(
    parentPath: string,
    context?: OperationContext
  ): Promise<FolderNode[]> {
    const folders = await this.getDistinctFolders(context);
    return getDirectChildren(folders, parentPath);
  }
}

/**
 * Create media repository from model
 */
export function createMediaRepository(
  model: Model<IMediaDocument>,
  options: MediaRepositoryOptions = {}
): MediaRepository {
  return new MediaRepository(model, options);
}

export default createMediaRepository;
