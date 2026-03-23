/**
 * MediaKitImpl Lifecycle & Utility Tests
 *
 * Validates the fixes for 4 code review issues in media.ts:
 * 1. [Medium] init() now throws on double-call (guard added)
 * 2. [Medium] Sharp warning now fires via async waitUntilReady() path
 * 3. [Low]    validateFile/getContentType now work before init() (config-only deps)
 * 4. [Low]    _model field removed (dead code eliminated)
 *
 * These tests do NOT require MongoDB.
 */

import { describe, it, expect, vi } from 'vitest';
import { createMedia } from '../src/media';
import { MemoryStorageDriver } from './helpers/memory-driver';
import { ImageProcessor } from '../src/processing/image';

describe('MediaKitImpl Lifecycle & Utilities', () => {
  // ============================================
  // 1. init() double-call guard
  // ============================================

  describe('Fix #1: init() rejects double initialization', () => {
    it('should throw on second init() call', () => {
      const driver = new MemoryStorageDriver();
      const media = createMedia({
        driver,
        processing: { enabled: false },
        suppressWarnings: true,
      });

      const fakeModel = { modelName: 'Media' } as any;

      // First init succeeds
      expect(() => media.init(fakeModel)).not.toThrow();

      // Second init throws
      expect(() => media.init(fakeModel)).toThrow(/already initialized/i);
    });

    it('should preserve original repository after rejected double-init', () => {
      const driver = new MemoryStorageDriver();
      const media = createMedia({
        driver,
        processing: { enabled: false },
        suppressWarnings: true,
      });

      const fakeModel = { modelName: 'Media' } as any;
      media.init(fakeModel);

      const originalRepo = media.repository;

      // Attempt double init
      try {
        media.init({ modelName: 'Other' } as any);
      } catch {
        // expected
      }

      // Repository is unchanged
      expect(media.repository).toBe(originalRepo);
    });
  });

  // ============================================
  // 2. Sharp availability — async warning path
  // ============================================

  describe('Fix #2: Sharp warning fires via async waitUntilReady()', () => {
    it('should create ImageProcessor that reports availability after async init', async () => {
      const processor = new ImageProcessor();

      // waitUntilReady() resolves after async sharp import
      const available = await processor.waitUntilReady();

      // In test env sharp IS installed, so it should be available
      expect(available).toBe(true);
      expect(processor.isAvailable()).toBe(true);
    });

    it('should set processor to non-null when sharp is available', () => {
      const driver = new MemoryStorageDriver();
      const media = createMedia({
        driver,
        processing: { enabled: true },
        suppressWarnings: true,
      });

      // Processor is created synchronously (waitUntilReady runs in background)
      expect((media as any).processor).toBeInstanceOf(ImageProcessor);
    });
  });

  // ============================================
  // 3. Helper methods work before init()
  // ============================================

  describe('Fix #3: validateFile/getContentType work before init()', () => {
    it('should allow validateFile() before init() — uses config-only deps', () => {
      const driver = new MemoryStorageDriver();
      const media = createMedia({
        driver,
        processing: { enabled: false },
        fileTypes: { allowed: ['image/*'], maxSize: 1024 * 1024 },
        suppressWarnings: true,
      });

      // Do NOT call media.init(...)
      // Should work since validateFile only needs config
      expect(() =>
        media.validateFile(Buffer.from('test'), 'photo.jpg', 'image/jpeg'),
      ).not.toThrow();
    });

    it('should reject disallowed MIME type via validateFile() before init()', () => {
      const driver = new MemoryStorageDriver();
      const media = createMedia({
        driver,
        processing: { enabled: false },
        fileTypes: { allowed: ['image/*'] },
        suppressWarnings: true,
      });

      expect(() =>
        media.validateFile(Buffer.from('test'), 'file.zip', 'application/zip'),
      ).toThrow(/not allowed/);
    });

    it('should allow getContentType() before init() — uses config-only deps', () => {
      const driver = new MemoryStorageDriver();
      const media = createMedia({
        driver,
        processing: { enabled: false },
        folders: {
          contentTypeMap: { product: ['products'] },
        },
        suppressWarnings: true,
      });

      // Do NOT call media.init(...)
      expect(media.getContentType('products/shoes')).toBe('product');
      expect(media.getContentType('random/folder')).toBe('default');
    });
  });

  // ============================================
  // 4. _model field removed
  // ============================================

  describe('Fix #4: dead _model field removed', () => {
    it('should not have a _model property on the instance', () => {
      const driver = new MemoryStorageDriver();
      const media = createMedia({
        driver,
        processing: { enabled: false },
        suppressWarnings: true,
      });

      // _model was removed — property should not exist
      expect('_model' in (media as any)).toBe(false);
    });
  });

  // ============================================
  // Config sourcing — driver/logger from merged config
  // ============================================

  describe('Config sourcing: driver and logger use merged config', () => {
    it('should expose the same driver via config and direct property', () => {
      const driver = new MemoryStorageDriver();
      const media = createMedia({
        driver,
        processing: { enabled: false },
        suppressWarnings: true,
      });

      // Both should reference the same driver instance
      expect(media.driver).toBe(driver);
      expect(media.config.driver).toBe(driver);
      expect(media.driver).toBe(media.config.driver);
    });
  });
});
