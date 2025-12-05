/**
 * Media Repository
 * 
 * Extends mongokit Repository with media-specific operations.
 * Compatible with any Mongoose model using the media schema.
 * 
 * @example
 * ```ts
 * import { createMediaRepository } from '@classytic/media-kit';
 * 
 * const mediaRepo = createMediaRepository(MediaModel);
 * 
 * // List files with pagination
 * const result = await mediaRepo.getAll({ 
 *   filters: { folder: 'products' },
 *   sort: '-createdAt',
 *   limit: 20 
 * });
 * 
 * // Get folder tree
 * const tree = await mediaRepo.getFolderTree();
 * ```
 */

import type { Model } from 'mongoose';
import type { 
  IMediaDocument, 
  FolderTree, 
  FolderStats, 
  OperationContext,
  MultiTenancyConfig 
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
}

/**
 * Create media repository from model
 * 
 * Works with or without mongokit:
 * - If mongokit is available, extends Repository for full pagination support
 * - Otherwise, provides standalone implementation
 */
export function createMediaRepository(
  model: Model<IMediaDocument>,
  options: MediaRepositoryOptions = {}
): MediaRepository {
  return new MediaRepository(model, options);
}

/**
 * Media Repository Class
 */
export class MediaRepository {
  protected model: Model<IMediaDocument>;
  protected options: MediaRepositoryOptions;

  constructor(model: Model<IMediaDocument>, options: MediaRepositoryOptions = {}) {
    this.model = model;
    this.options = {
      defaultLimit: 20,
      maxLimit: 100,
      ...options,
    };
  }

  /**
   * Get model instance
   */
  getModel(): Model<IMediaDocument> {
    return this.model;
  }

  /**
   * Build query filters with multi-tenancy
   */
  protected buildFilters(
    filters: Record<string, unknown> = {},
    context?: OperationContext
  ): Record<string, unknown> {
    const query = { ...filters };

    // Apply multi-tenancy filter (strict)
    const tenant = this.requireTenantContext(context);
    if (tenant) {
      query[tenant.field] = tenant.organizationId;
    }

    return query;
  }

  /**
   * Ensure tenant information is present when multi-tenancy is enabled
   */
  protected requireTenantContext(context?: OperationContext): { field: string; organizationId: OperationContext['organizationId'] } | null {
    if (!this.options.multiTenancy?.enabled) {
      return null;
    }

    const organizationId = context?.organizationId;
    const field = this.options.multiTenancy.field || 'organizationId';

    if (!organizationId) {
      throw new Error(`Multi-tenancy enabled: '${field}' is required in context`);
    }

    return { field, organizationId };
  }

  // ============================================
  // CRUD OPERATIONS
  // ============================================

  /**
   * Create media document
   */
  async create(
    data: Partial<IMediaDocument>,
    context?: OperationContext
  ): Promise<IMediaDocument> {
    const tenant = this.requireTenantContext(context);
    const doc = new this.model({
      ...data,
      uploadedBy: context?.userId,
      ...(tenant && { [tenant.field]: tenant.organizationId }),
    });

    return doc.save();
  }

  /**
   * Get by ID
   */
  async getById(
    id: string,
    context?: OperationContext
  ): Promise<IMediaDocument | null> {
    const filters = this.buildFilters({ _id: id }, context);
    return this.model.findOne(filters).lean();
  }

  /**
   * Get all with filters
   */
  async getAll(
    params: {
      filters?: Record<string, unknown>;
      sort?: string | Record<string, 1 | -1>;
      limit?: number;
      page?: number;
      after?: string;
    } = {},
    context?: OperationContext
  ): Promise<{
    docs: IMediaDocument[];
    total?: number;
    page?: number;
    pages?: number;
    hasMore?: boolean;
    next?: string;
  }> {
    const {
      filters = {},
      sort = '-createdAt',
      limit = this.options.defaultLimit!,
      page,
    } = params;

    const query = this.buildFilters(filters, context);
    const actualLimit = Math.min(limit, this.options.maxLimit!);

    // Offset pagination
    if (page !== undefined) {
      const skip = (page - 1) * actualLimit;
      const [docs, total] = await Promise.all([
        this.model.find(query).sort(sort).skip(skip).limit(actualLimit).lean(),
        this.model.countDocuments(query),
      ]);

      return {
        docs,
        total,
        page,
        pages: Math.ceil(total / actualLimit),
        hasMore: skip + docs.length < total,
      };
    }

    // Simple list
    const docs = await this.model
      .find(query)
      .sort(sort)
      .limit(actualLimit)
      .lean();

    return { docs };
  }

  /**
   * Update by ID
   */
  async update(
    id: string,
    data: Partial<IMediaDocument>,
    context?: OperationContext
  ): Promise<IMediaDocument | null> {
    const filters = this.buildFilters({ _id: id }, context);
    return this.model.findOneAndUpdate(filters, data, { new: true }).lean();
  }

  /**
   * Delete by ID
   */
  async delete(id: string, context?: OperationContext): Promise<boolean> {
    const filters = this.buildFilters({ _id: id }, context);
    const result = await this.model.deleteOne(filters);
    return result.deletedCount > 0;
  }

  /**
   * Delete many by IDs
   */
  async deleteMany(ids: string[], context?: OperationContext): Promise<number> {
    const filters = this.buildFilters({ _id: { $in: ids } }, context);
    const result = await this.model.deleteMany(filters);
    return result.deletedCount;
  }

  // ============================================
  // FOLDER OPERATIONS
  // ============================================

  /**
   * Get distinct folders with stats
   */
  async getDistinctFolders(context?: OperationContext): Promise<Array<{
    folder: string;
    count: number;
    totalSize: number;
    latestUpload: Date;
  }>> {
    const matchStage = this.buildFilters({}, context);

    const pipeline: any[] = [];
    
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

    return this.model.aggregate(pipeline);
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

    const [stats] = await this.model.aggregate([
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
  getBreadcrumb(folderPath: string) {
    return getBreadcrumb(folderPath);
  }

  /**
   * Get files in a folder
   */
  async getByFolder(
    folder: string,
    params: { limit?: number; sort?: string } = {},
    context?: OperationContext
  ): Promise<IMediaDocument[]> {
    const { limit = 20, sort = '-createdAt' } = params;
    const filters = this.buildFilters({ folder }, context);

    return this.model
      .find(filters)
      .sort(sort)
      .limit(Math.min(limit, this.options.maxLimit!))
      .lean();
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

    const result = await this.model.updateMany(filters, {
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

    return this.model.find(filters).lean();
  }
}

export default createMediaRepository;
