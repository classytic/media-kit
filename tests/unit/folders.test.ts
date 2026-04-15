/**
 * Folder Utilities Tests
 */

import { describe, it, expect } from 'vitest';
import {
  buildFolderTree,
  getBreadcrumb,
  extractBaseFolder,
  isValidFolder,
  normalizeFolderPath,
  escapeRegex,
  getDirectChildren,
  renameFolderPaths,
} from '../../src/utils/folders';

describe('Folder Utilities', () => {
  describe('buildFolderTree', () => {
    it('should build tree from flat folder list', () => {
      const folders = [
        { folder: 'products', count: 10, totalSize: 1000, latestUpload: new Date() },
        { folder: 'products/featured', count: 5, totalSize: 500, latestUpload: new Date() },
        { folder: 'products/electronics', count: 3, totalSize: 300, latestUpload: new Date() },
        { folder: 'users', count: 20, totalSize: 2000, latestUpload: new Date() },
      ];

      const tree = buildFolderTree(folders);

      expect(tree.folders).toHaveLength(2);
      expect(tree.meta.totalFiles).toBe(38);
      expect(tree.meta.totalSize).toBe(3800);

      const products = tree.folders.find(f => f.id === 'products');
      expect(products).toBeDefined();
      expect(products!.stats.count).toBe(18); // 10 + 5 + 3
      expect(products!.children).toHaveLength(2);
    });

    it('should handle empty folder list', () => {
      const tree = buildFolderTree([]);
      expect(tree.folders).toHaveLength(0);
      expect(tree.meta.totalFiles).toBe(0);
    });

    it('should handle single level folders', () => {
      const folders = [
        { folder: 'images', count: 10, totalSize: 1000, latestUpload: new Date() },
      ];

      const tree = buildFolderTree(folders);
      expect(tree.folders).toHaveLength(1);
      expect(tree.folders[0].children).toHaveLength(0);
    });
  });

  describe('getBreadcrumb', () => {
    it('should return breadcrumb for nested path', () => {
      const breadcrumb = getBreadcrumb('products/electronics/phones');

      expect(breadcrumb).toHaveLength(3);
      expect(breadcrumb[0]).toEqual({ name: 'products', path: 'products' });
      expect(breadcrumb[1]).toEqual({ name: 'electronics', path: 'products/electronics' });
      expect(breadcrumb[2]).toEqual({ name: 'phones', path: 'products/electronics/phones' });
    });

    it('should return single item for root folder', () => {
      const breadcrumb = getBreadcrumb('products');

      expect(breadcrumb).toHaveLength(1);
      expect(breadcrumb[0]).toEqual({ name: 'products', path: 'products' });
    });

    it('should return empty array for empty path', () => {
      expect(getBreadcrumb('')).toHaveLength(0);
    });
  });

  describe('extractBaseFolder', () => {
    it('should extract base folder from nested path', () => {
      expect(extractBaseFolder('products/electronics/phones')).toBe('products');
    });

    it('should return same for single segment', () => {
      expect(extractBaseFolder('products')).toBe('products');
    });

    it('should return empty string for empty path', () => {
      expect(extractBaseFolder('')).toBe('');
    });
  });

  describe('isValidFolder', () => {
    const allowed = ['products', 'users', 'blog'];

    it('should validate allowed base folder', () => {
      expect(isValidFolder('products', allowed)).toBe(true);
      expect(isValidFolder('products/featured', allowed)).toBe(true);
    });

    it('should reject invalid base folder', () => {
      expect(isValidFolder('invalid', allowed)).toBe(false);
      expect(isValidFolder('invalid/subfolder', allowed)).toBe(false);
    });
  });

  describe('normalizeFolderPath', () => {
    it('should remove leading/trailing slashes', () => {
      expect(normalizeFolderPath('/products/')).toBe('products');
      expect(normalizeFolderPath('/products/featured/')).toBe('products/featured');
    });

    it('should remove duplicate slashes', () => {
      expect(normalizeFolderPath('products//featured')).toBe('products/featured');
      expect(normalizeFolderPath('products///featured//images')).toBe('products/featured/images');
    });

    it('should optionally lowercase', () => {
      expect(normalizeFolderPath('Products/Featured', true)).toBe('products/featured');
    });
  });

  describe('escapeRegex', () => {
    it('should escape special characters', () => {
      expect(escapeRegex('products.featured')).toBe('products\\.featured');
      expect(escapeRegex('test(1)')).toBe('test\\(1\\)');
    });
  });

  describe('buildFolderTree deep hierarchy', () => {
    it('should build a 4-level deep tree correctly', () => {
      const folders = [
        { folder: 'images/vacation/2024/summer', count: 8, totalSize: 800, latestUpload: new Date('2024-08-01') },
      ];

      const tree = buildFolderTree(folders);

      // Root level should have one entry: "images"
      expect(tree.folders).toHaveLength(1);
      const images = tree.folders[0];
      expect(images.name).toBe('images');
      expect(images.path).toBe('images');

      // Second level: "vacation"
      expect(images.children).toHaveLength(1);
      const vacation = images.children[0];
      expect(vacation.name).toBe('vacation');
      expect(vacation.path).toBe('images/vacation');

      // Third level: "2024"
      expect(vacation.children).toHaveLength(1);
      const year = vacation.children[0];
      expect(year.name).toBe('2024');
      expect(year.path).toBe('images/vacation/2024');

      // Fourth level: "summer"
      expect(year.children).toHaveLength(1);
      const summer = year.children[0];
      expect(summer.name).toBe('summer');
      expect(summer.path).toBe('images/vacation/2024/summer');
      expect(summer.children).toHaveLength(0);
    });

    it('should have segment-only names, not full sub-paths', () => {
      const folders = [
        { folder: 'a/b/c/d', count: 1, totalSize: 100, latestUpload: new Date() },
      ];

      const tree = buildFolderTree(folders);
      const a = tree.folders[0];
      const b = a.children[0];
      const c = b.children[0];
      const d = c.children[0];

      expect(a.name).toBe('a');
      expect(b.name).toBe('b');
      expect(c.name).toBe('c');
      expect(d.name).toBe('d');
    });

    it('should roll up stats to all ancestors', () => {
      const folders = [
        { folder: 'images/vacation/2024/summer', count: 8, totalSize: 800, latestUpload: new Date() },
        { folder: 'images/vacation/2024/winter', count: 4, totalSize: 400, latestUpload: new Date() },
        { folder: 'images/vacation/2023', count: 6, totalSize: 600, latestUpload: new Date() },
      ];

      const tree = buildFolderTree(folders);

      const images = tree.folders[0];
      // images should aggregate everything: 8 + 4 + 6 = 18
      expect(images.stats.count).toBe(18);
      expect(images.stats.size).toBe(1800);

      const vacation = images.children[0];
      // vacation also aggregates all its descendants: 8 + 4 + 6 = 18
      expect(vacation.stats.count).toBe(18);
      expect(vacation.stats.size).toBe(1800);

      const year2024 = vacation.children.find(c => c.name === '2024')!;
      // 2024 aggregates summer + winter: 8 + 4 = 12
      expect(year2024.stats.count).toBe(12);
      expect(year2024.stats.size).toBe(1200);

      const year2023 = vacation.children.find(c => c.name === '2023')!;
      // 2023 is a leaf
      expect(year2023.stats.count).toBe(6);
      expect(year2023.stats.size).toBe(600);
    });

    it('should handle a mix of deep and shallow paths in the same tree', () => {
      const folders = [
        { folder: 'docs', count: 3, totalSize: 300, latestUpload: new Date() },
        { folder: 'images/vacation/2024/summer', count: 8, totalSize: 800, latestUpload: new Date() },
        { folder: 'images/profile', count: 2, totalSize: 200, latestUpload: new Date() },
      ];

      const tree = buildFolderTree(folders);

      // Two root-level nodes: docs, images
      expect(tree.folders).toHaveLength(2);
      expect(tree.meta.totalFiles).toBe(13);
      expect(tree.meta.totalSize).toBe(1300);

      const docs = tree.folders.find(f => f.name === 'docs')!;
      expect(docs.stats.count).toBe(3);
      expect(docs.children).toHaveLength(0);

      const images = tree.folders.find(f => f.name === 'images')!;
      // images aggregates vacation/2024/summer (8) + profile (2) = 10
      expect(images.stats.count).toBe(10);
      expect(images.children).toHaveLength(2); // profile, vacation
    });
  });

  describe('getDirectChildren', () => {
    const folders = [
      { folder: 'images', count: 5, totalSize: 500, latestUpload: new Date('2024-01-01') },
      { folder: 'images/vacation', count: 3, totalSize: 300, latestUpload: new Date('2024-06-01') },
      { folder: 'images/vacation/2024', count: 7, totalSize: 700, latestUpload: new Date('2024-08-01') },
      { folder: 'images/profile', count: 2, totalSize: 200, latestUpload: new Date('2024-03-01') },
      { folder: 'docs', count: 10, totalSize: 1000, latestUpload: new Date('2024-02-01') },
      { folder: 'docs/legal', count: 4, totalSize: 400, latestUpload: new Date('2024-04-01') },
    ];

    it('should return root-level children when parentPath is empty', () => {
      const children = getDirectChildren(folders, '');

      expect(children).toHaveLength(2);
      const names = children.map(c => c.name);
      expect(names).toContain('images');
      expect(names).toContain('docs');
    });

    it('should return children of a nested path', () => {
      const children = getDirectChildren(folders, 'images');

      expect(children).toHaveLength(2);
      const names = children.map(c => c.name);
      expect(names).toContain('vacation');
      expect(names).toContain('profile');
    });

    it('should aggregate stats from subfolders into direct children', () => {
      const children = getDirectChildren(folders, 'images');

      const vacation = children.find(c => c.name === 'vacation')!;
      // vacation (3) + vacation/2024 (7) = 10
      expect(vacation.stats.count).toBe(10);
      expect(vacation.stats.size).toBe(1000);

      const profile = children.find(c => c.name === 'profile')!;
      expect(profile.stats.count).toBe(2);
      expect(profile.stats.size).toBe(200);
    });

    it('should return empty array for a path with no children', () => {
      const children = getDirectChildren(folders, 'docs/legal');
      expect(children).toHaveLength(0);
    });
  });

  describe('renameFolderPaths', () => {
    it('should perform a basic rename on an exact match', () => {
      const paths = ['photos', 'photos/vacation', 'docs'];
      const result = renameFolderPaths(paths, 'photos', 'images');

      expect(result).toContainEqual({ oldPath: 'photos', newPath: 'images' });
    });

    it('should rename sub-paths that start with the old prefix', () => {
      const paths = ['photos', 'photos/vacation', 'photos/vacation/2024', 'docs'];
      const result = renameFolderPaths(paths, 'photos', 'images');

      expect(result).toHaveLength(3);
      expect(result).toContainEqual({ oldPath: 'photos', newPath: 'images' });
      expect(result).toContainEqual({ oldPath: 'photos/vacation', newPath: 'images/vacation' });
      expect(result).toContainEqual({ oldPath: 'photos/vacation/2024', newPath: 'images/vacation/2024' });
    });

    it('should exclude non-matching paths from the result', () => {
      const paths = ['photos', 'photos/vacation', 'docs', 'docs/legal'];
      const result = renameFolderPaths(paths, 'photos', 'images');

      const resultPaths = result.map(r => r.oldPath);
      expect(resultPaths).not.toContain('docs');
      expect(resultPaths).not.toContain('docs/legal');
      expect(result).toHaveLength(2);
    });
  });
});
