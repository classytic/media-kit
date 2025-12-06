/**
 * Media Repository
 * 
 * Extends mongokit Repository with media-specific operations.
 * Provides full access to mongokit features: pagination, events, plugins, caching.
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
 * const result = await mediaRepo.getAll({ 
 *   filters: { folder: 'products' },
 *   sort: { createdAt: -1 },
 *   limit: 20 
 * });
 * 
 * // Keyset pagination for infinite scroll
 * const stream = await mediaRepo.getAll({ 
 *   sort: { createdAt: -1 }, 
 *   limit: 50 
 * });
 * const next = await mediaRepo.getAll({ 
 *   after: stream.next, 
 *   sort: { createdAt: -1 } 
 * });
 * 
 * // Get folder tree
 * const tree = await mediaRepo.getFolderTree();
 * ```
 */

import { Repository } from '@classytic/mongokit';
import type { Model, ClientSession, PipelineStage } from 'mongoose';
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
  OperationContext,
  MultiTenancyConfig,
  BreadcrumbItem,
} from '../types';
import { buildFolderTree, getBreadcrumb, escapeRegex } from '../utils/folders';

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
 * Extends mongokit Repository with media-specific operations
 */
export class MediaRepository extends Repository<IMediaDocument> {
  protected mediaOptions: MediaRepositoryOptions;

  constructor(
    model: Model<IMediaDocument>, 
    options: MediaRepositoryOptions = {}
  ) {
    // Initialize mongokit Repository with plugins and pagination config
    super(model, options.plugins || [], {
      defaultLimit: options.defaultLimit || 20,
      maxLimit: options.maxLimit || 100,
      ...options.pagination,
    });

    this.mediaOptions = {
      defaultLimit: 20,
      maxLimit: 100,
      ...options,
    };

    // Register multi-tenancy hooks if enabled
    if (options.multiTenancy?.enabled) {
      this._registerMultiTenancyHooks();
    }
  }

  /**
   * Register multi-tenancy before hooks
   */
  private _registerMultiTenancyHooks(): void {
    const field = this.mediaOptions.multiTenancy?.field || 'organizationId';
    const required = this.mediaOptions.multiTenancy?.required ?? false;

    // Inject tenant filter on read operations
    const injectTenantFilter = (context: any) => {
      const orgId = context.organizationId;
      
      if (required && !orgId) {
        throw new Error(`Multi-tenancy enabled: '${field}' is required in context`);
      }
      
      if (orgId) {
        context.filters = context.filters || {};
        context.filters[field] = orgId;
        
        // Also inject into query for getById/getByQuery
        if (context.query) {
          context.query[field] = orgId;
        }
      }
    };

    // Inject tenant field on create
    const injectTenantField = (context: any) => {
      const orgId = context.organizationId;
      
      if (required && !orgId) {
        throw new Error(`Multi-tenancy enabled: '${field}' is required in context`);
      }
      
      if (orgId && context.data) {
        context.data[field] = orgId;
      }
      
      if (orgId && context.dataArray) {
        context.dataArray = context.dataArray.map((d: any) => ({
          ...d,
          [field]: orgId,
        }));
      }
    };

    this.on('before:getById', injectTenantFilter);
    this.on('before:getByQuery', injectTenantFilter);
    this.on('before:getAll', injectTenantFilter);
    this.on('before:aggregatePaginate', injectTenantFilter);
    this.on('before:create', injectTenantField);
    this.on('before:createMany', injectTenantField);
    this.on('before:update', injectTenantFilter);
    this.on('before:delete', injectTenantFilter);
  }

  /**
   * Build query filters with multi-tenancy
   */
  protected buildFilters(
    filters: Record<string, unknown> = {},
    context?: OperationContext
  ): Record<string, unknown> {
    const query = { ...filters };

    if (this.mediaOptions.multiTenancy?.enabled && context?.organizationId) {
      const field = this.mediaOptions.multiTenancy.field || 'organizationId';
      query[field] = context.organizationId;
    }

    return query;
  }

  /**
   * Require tenant context when multi-tenancy is enabled
   */
  protected requireTenantContext(
    context?: OperationContext
  ): { field: string; organizationId: OperationContext['organizationId'] } | null {
    if (!this.mediaOptions.multiTenancy?.enabled) {
      return null;
    }

    const organizationId = context?.organizationId;
    const field = this.mediaOptions.multiTenancy.field || 'organizationId';

    if (!organizationId && this.mediaOptions.multiTenancy.required) {
      throw new Error(`Multi-tenancy enabled: '${field}' is required in context`);
    }

    if (!organizationId) {
      return null;
    }

    return { field, organizationId };
  }

  // ============================================
  // MEDIA-SPECIFIC CRUD OPERATIONS
  // ============================================

  /**
   * Create media document with context support
   */
  async createMedia(
    data: Partial<IMediaDocument>,
    context?: OperationContext
  ): Promise<IMediaDocument> {
    const tenant = this.requireTenantContext(context);
    const createData = {
      ...data,
      uploadedBy: context?.userId,
      ...(tenant && { [tenant.field]: tenant.organizationId }),
    };

    return this.create(createData as Record<string, unknown>);
  }

  /**
   * Get media by ID with tenant context
   * Returns null if not found (unlike mongokit's default 404 behavior)
   */
  async getMediaById(
    id: string,
    context?: OperationContext
  ): Promise<IMediaDocument | null> {
    // Build context with tenant info for mongokit hooks
    const repoContext = {
      organizationId: context?.organizationId,
    };
    
    // Merge context into options for hook access
    // Use throwOnNotFound: false to return null instead of throwing 404
    return this.getById(id, { 
      lean: true,
      throwOnNotFound: false,
      ...(repoContext as any),
    });
  }

  /**
   * Get all media with filters and context
   * Leverages mongokit's smart pagination (auto-detects offset vs keyset)
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
    } = {},
    context?: OperationContext
  ): Promise<OffsetPaginationResult<IMediaDocument> | KeysetPaginationResult<IMediaDocument>> {
    const filters = this.buildFilters(params.filters || {}, context);
    
    return this.getAll({
      ...params,
      filters,
    });
  }

  /**
   * Update media by ID with context
   */
  async updateMedia(
    id: string,
    data: Partial<IMediaDocument>,
    context?: OperationContext
  ): Promise<IMediaDocument> {
    // For update, we need to ensure tenant isolation
    if (this.mediaOptions.multiTenancy?.enabled && context?.organizationId) {
      // First verify the document belongs to this tenant
      const existing = await this.getMediaById(id, context);
      if (!existing) {
        throw new Error('Media not found');
      }
    }

    return this.update(id, data as Record<string, unknown>);
  }

  /**
   * Delete media by ID with context
   */
  async deleteMedia(id: string, context?: OperationContext): Promise<boolean> {
    // For delete, we need to ensure tenant isolation
    if (this.mediaOptions.multiTenancy?.enabled && context?.organizationId) {
      const existing = await this.getMediaById(id, context);
      if (!existing) {
        return false;
      }
    }

    const result = await this.delete(id);
    return result.success;
  }

  /**
   * Delete many media by IDs with context
   */
  async deleteManyMedia(ids: string[], context?: OperationContext): Promise<number> {
    const filters = this.buildFilters({ _id: { $in: ids } }, context);
    const result = await this.Model.deleteMany(filters);
    return result.deletedCount;
  }

  // ============================================
  // FOLDER OPERATIONS
  // ============================================

  /**
   * Get distinct folders with stats using aggregation
   */
  async getDistinctFolders(context?: OperationContext): Promise<FolderAggregateResult[]> {
    const matchStage = this.buildFilters({}, context);

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

    const matchStage = this.buildFilters({ folder: folderQuery }, context);

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
    ]);

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
   * Move files to a different folder
   */
  async moveToFolder(
    ids: string[],
    targetFolder: string,
    context?: OperationContext
  ): Promise<{ modifiedCount: number }> {
    const baseFolder = targetFolder.split('/')[0];
    const filters = this.buildFilters({ _id: { $in: ids } }, context);

    const result = await this.Model.updateMany(filters, {
      $set: { folder: targetFolder, baseFolder },
    });

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

    const filters = this.buildFilters({ folder: folderQuery }, context);

    return this.Model.find(filters).lean();
  }

  /**
   * Search media with text search
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
    const filters = this.buildFilters({ hash }, context);
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

    const filters = this.buildFilters({ folder: folderQuery }, context);
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
    const matchStage = this.buildFilters({}, context);

    const [result] = await this.aggregate<{ total: number }>([
      ...(Object.keys(matchStage).length > 0 ? [{ $match: matchStage }] : []),
      {
        $group: {
          _id: null,
          total: { $sum: '$size' },
        },
      },
    ]);

    return result?.total || 0;
  }

  /**
   * Get storage breakdown by folder
   */
  async getStorageByFolder(context?: OperationContext): Promise<Array<{
    folder: string;
    size: number;
    count: number;
    percentage: number;
  }>> {
    const matchStage = this.buildFilters({}, context);

    const results = await this.aggregate<{
      folder: string;
      size: number;
      count: number;
    }>([
      ...(Object.keys(matchStage).length > 0 ? [{ $match: matchStage }] : []),
      {
        $group: {
          _id: '$baseFolder',
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
}

/**
 * Create media repository from model
 * 
 * @example
 * ```ts
 * const mediaRepo = createMediaRepository(MediaModel, {
 *   plugins: [cachePlugin({ adapter: redisCache })],
 *   multiTenancy: { enabled: true }
 * });
 * ```
 */
export function createMediaRepository(
  model: Model<IMediaDocument>,
  options: MediaRepositoryOptions = {}
): MediaRepository {
  return new MediaRepository(model, options);
}

export default createMediaRepository;
