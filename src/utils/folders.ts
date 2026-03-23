/**
 * Folder Utilities
 *
 * Deep folder tree, breadcrumb, path operations, and rename helpers.
 * Supports unlimited nesting levels (GitHub-style folder hierarchy).
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
 * Build a deep folder tree from a flat folder list.
 *
 * Supports unlimited nesting: `images/vacation/2024/summer` creates
 * a 4-level tree: `images > vacation > 2024 > summer`.
 *
 * Stats roll up from leaf nodes to all ancestors.
 *
 * @param folders - Flat list of folders with stats
 * @returns Tree structure for FE file explorer
 */
export function buildFolderTree(folders: FolderStats[]): FolderTree {
  // Map of path → node for fast lookup
  const nodeMap = new Map<string, FolderNode>();
  let totalFiles = 0;
  let totalSize = 0;

  // Ensure a node exists for every segment of a path.
  // Returns or creates the node, guaranteeing all ancestors exist too.
  const ensureNode = (path: string): FolderNode => {
    const existing = nodeMap.get(path);
    if (existing) return existing;

    const parts = path.split('/');
    const name = parts[parts.length - 1]!;

    const node: FolderNode = {
      id: path,
      name,
      path,
      stats: { count: 0, size: 0 },
      children: [],
    };
    nodeMap.set(path, node);

    // Ensure parent exists and link this node as child
    if (parts.length > 1) {
      const parentPath = parts.slice(0, -1).join('/');
      const parent = ensureNode(parentPath);
      // Only add if not already a child (idempotent)
      if (!parent.children.some(c => c.path === path)) {
        parent.children.push(node);
      }
    }

    return node;
  };

  // First pass: create all nodes and set leaf stats
  for (const item of folders) {
    totalFiles += item.count;
    totalSize += item.totalSize;

    const node = ensureNode(item.folder);
    // Set leaf-level stats (files directly in this folder)
    node.stats.count += item.count;
    node.stats.size += item.totalSize;
    if (item.latestUpload) {
      node.latestUpload = !node.latestUpload || item.latestUpload > node.latestUpload
        ? item.latestUpload
        : node.latestUpload;
    }
  }

  // Second pass: roll up stats from children to ancestors
  // Process deepest paths first (longest paths first)
  const allPaths = [...nodeMap.keys()].sort((a, b) => b.split('/').length - a.split('/').length);

  for (const path of allPaths) {
    const node = nodeMap.get(path)!;
    const parts = path.split('/');
    if (parts.length <= 1) continue;

    const parentPath = parts.slice(0, -1).join('/');
    const parent = nodeMap.get(parentPath);
    if (!parent) continue;

    parent.stats.count += node.stats.count;
    parent.stats.size += node.stats.size;

    // Propagate latest upload
    if (node.latestUpload) {
      parent.latestUpload = !parent.latestUpload || node.latestUpload > parent.latestUpload
        ? node.latestUpload
        : parent.latestUpload;
    }
  }

  // Deduplicate: since we rolled up stats from children, root nodes that
  // also have direct files would double-count. We need to undo the second pass
  // for nodes that had their own files AND children. Actually, the approach above
  // is correct: leaf stats are set directly, and roll-up adds children's stats.
  // The leaf's own count is NOT included in children's roll-up, so no duplication.

  // Collect root-level nodes (no '/' in path)
  const roots: FolderNode[] = [];
  for (const [path, node] of nodeMap) {
    if (!path.includes('/')) {
      roots.push(node);
    }
  }

  // Sort children recursively by name
  const sortChildren = (node: FolderNode) => {
    node.children.sort((a, b) => a.name.localeCompare(b.name));
    node.children.forEach(sortChildren);
  };
  roots.sort((a, b) => a.name.localeCompare(b.name));
  roots.forEach(sortChildren);

  return {
    folders: roots,
    meta: { totalFiles, totalSize },
  };
}

/**
 * Get immediate children of a folder path with aggregated stats.
 *
 * @param folders - Flat list of all folders with stats
 * @param parentPath - Parent path to get children for (empty string = root level)
 * @returns Direct child folder nodes with rolled-up stats
 */
export function getDirectChildren(folders: FolderStats[], parentPath: string): FolderNode[] {
  const depth = parentPath ? parentPath.split('/').length + 1 : 1;
  const prefix = parentPath ? `${parentPath}/` : '';

  // Group by immediate child segment
  const childMap = new Map<string, FolderNode>();

  for (const item of folders) {
    // Only consider folders under this parent
    if (parentPath && !item.folder.startsWith(prefix)) continue;
    if (!parentPath && item.folder.includes('/')) {
      // For root: only use the first segment
      const rootSegment = item.folder.split('/')[0]!;
      const childPath = rootSegment;

      if (!childMap.has(childPath)) {
        childMap.set(childPath, {
          id: childPath,
          name: rootSegment,
          path: childPath,
          stats: { count: 0, size: 0 },
          children: [],
        });
      }
      const node = childMap.get(childPath)!;
      node.stats.count += item.count;
      node.stats.size += item.totalSize;
      if (item.latestUpload) {
        node.latestUpload = !node.latestUpload || item.latestUpload > node.latestUpload
          ? item.latestUpload
          : node.latestUpload;
      }
      continue;
    }

    if (parentPath && item.folder === parentPath) continue; // Skip the parent itself

    const parts = item.folder.split('/');
    if (parts.length < depth) continue;

    const childSegment = parts[depth - 1]!;
    const childPath = parentPath ? `${parentPath}/${childSegment}` : childSegment;

    if (!childMap.has(childPath)) {
      childMap.set(childPath, {
        id: childPath,
        name: childSegment,
        path: childPath,
        stats: { count: 0, size: 0 },
        children: [],
      });
    }

    const node = childMap.get(childPath)!;
    node.stats.count += item.count;
    node.stats.size += item.totalSize;
    if (item.latestUpload) {
      node.latestUpload = !node.latestUpload || item.latestUpload > node.latestUpload
        ? item.latestUpload
        : node.latestUpload;
    }
  }

  const children = [...childMap.values()];
  children.sort((a, b) => a.name.localeCompare(b.name));
  return children;
}

/**
 * Compute renamed paths for a bulk folder rename/move.
 *
 * @param paths - Array of existing folder paths
 * @param oldPrefix - Old folder prefix to replace
 * @param newPrefix - New folder prefix
 * @returns Array of `{ oldPath, newPath }` for paths that match the prefix
 */
export function renameFolderPaths(
  paths: string[],
  oldPrefix: string,
  newPrefix: string
): Array<{ oldPath: string; newPath: string }> {
  const results: Array<{ oldPath: string; newPath: string }> = [];

  for (const path of paths) {
    if (path === oldPrefix || path.startsWith(`${oldPrefix}/`)) {
      const newPath = newPrefix + path.slice(oldPrefix.length);
      results.push({ oldPath: path, newPath });
    }
  }

  return results;
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
      name: parts[i]!,
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
