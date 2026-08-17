/** Folder navigation and bulk rewrite result contracts. */

/**
 * Folder tree node (for FE file explorer)
 */
export interface FolderNode {
  /** Unique identifier (same as path) */
  id: string;
  /** Display name */
  name: string;
  /** Full path */
  path: string;
  /** File stats */
  stats: { count: number; size: number };
  /** Child folders */
  children: FolderNode[];
  /** Latest upload timestamp */
  latestUpload?: Date;
}

/**
 * Folder tree response
 */
export interface FolderTree {
  /** Root folder nodes */
  folders: FolderNode[];
  /** Aggregate stats */
  meta: { totalFiles: number; totalSize: number };
}

/**
 * Breadcrumb item
 */
export interface BreadcrumbItem {
  /** Display name */
  name: string;
  /** Full path to this point */
  path: string;
}

/**
 * Folder stats
 */
export interface FolderStats {
  totalFiles: number;
  totalSize: number;
  avgSize: number;
  mimeTypes: string[];
  oldestFile: Date | null;
  newestFile: Date | null;
}

/**
 * Bulk operation result
 */
export interface BulkResult<T = string> {
  success: T[];
  failed: Array<{ id: T; reason: string }>;
}

/**
 * Result of move/renameFolder operations.
 * Unlike simple `{ modifiedCount }`, exposes per-file failures
 * so callers can retry or reconcile at scale.
 */
export interface RewriteResult {
  modifiedCount: number;
  failed: Array<{ id: string; reason: string }>;
}
