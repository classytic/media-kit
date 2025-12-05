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
} from '../src/utils/folders';

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
});
