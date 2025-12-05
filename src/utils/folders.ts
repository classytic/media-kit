/**
 * Folder Utilities
 * 
 * Helpers for folder tree, breadcrumb, and path operations.
 */

import type { FolderNode, FolderTree, BreadcrumbItem } from '../types';

/**
 * Folder with stats (from aggregation)
 */
interface FolderStats {
  folder: string;
  count: number;
  totalSize: number;
  latestUpload?: Date;
}

/**
 * Build folder tree from flat folder list
 * 
 * @param folders - Flat list of folders with stats
 * @returns Tree structure for FE file explorer
 */
export function buildFolderTree(folders: FolderStats[]): FolderTree {
  const tree: Record<string, FolderNode> = {};
  let totalFiles = 0;
  let totalSize = 0;

  for (const item of folders) {
    const parts = item.folder.split('/');
    const baseFolder = parts[0];

    totalFiles += item.count;
    totalSize += item.totalSize;

    // Initialize base folder node
    if (!tree[baseFolder]) {
      tree[baseFolder] = {
        id: baseFolder,
        name: baseFolder,
        path: baseFolder,
        stats: { count: 0, size: 0 },
        children: [],
      };
    }

    // Accumulate stats to base folder
    tree[baseFolder].stats.count += item.count;
    tree[baseFolder].stats.size += item.totalSize;

    // Add nested folders as children
    if (parts.length > 1) {
      tree[baseFolder].children.push({
        id: item.folder,
        name: parts.slice(1).join('/'),
        path: item.folder,
        stats: {
          count: item.count,
          size: item.totalSize,
        },
        children: [],
        latestUpload: item.latestUpload,
      });
    }
  }

  return {
    folders: Object.values(tree),
    meta: { totalFiles, totalSize },
  };
}

/**
 * Get breadcrumb trail for a folder path
 * 
 * @param folderPath - Full folder path (e.g., 'products/featured/summer')
 * @returns Breadcrumb items from root to current
 */
export function getBreadcrumb(folderPath: string): BreadcrumbItem[] {
  if (!folderPath) return [];

  const parts = folderPath.split('/').filter(Boolean);
  const breadcrumb: BreadcrumbItem[] = [];

  for (let i = 0; i < parts.length; i++) {
    breadcrumb.push({
      name: parts[i],
      path: parts.slice(0, i + 1).join('/'),
    });
  }

  return breadcrumb;
}

/**
 * Extract base folder from path
 */
export function extractBaseFolder(folderPath: string): string {
  return folderPath.split('/')[0] || '';
}

/**
 * Validate that folder starts with an allowed base folder
 */
export function isValidFolder(folderPath: string, allowedBaseFolders: string[]): boolean {
  const baseFolder = extractBaseFolder(folderPath);
  return allowedBaseFolders.includes(baseFolder);
}

/**
 * Normalize folder path
 * - Remove leading/trailing slashes
 * - Remove duplicate slashes
 * - Convert to lowercase (optional)
 */
export function normalizeFolderPath(path: string, lowercase = false): string {
  let normalized = path
    .replace(/\/+/g, '/') // Remove duplicate slashes
    .replace(/^\/|\/$/g, ''); // Remove leading/trailing slashes
  
  if (lowercase) {
    normalized = normalized.toLowerCase();
  }
  
  return normalized;
}

/**
 * Escape special regex characters for folder matching
 */
export function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
