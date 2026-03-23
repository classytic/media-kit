/**
 * GCS Processing Integration Test
 *
 * Tests real image processing with Sharp + GCS uploads + MongoDB.
 * Validates:
 *   - Image processing pipeline (format conversion, resizing, metadata extraction)
 *   - Processing presets (social-media, web-optimized, high-quality, thumbnail)
 *   - Original handling modes (keep-variant, replace, discard)
 *   - Variant generation + GCS upload
 *   - ThumbHash + dominant color extraction
 *   - Enhanced Sharp options (mozjpeg, smartSubsample)
 *
 * Requires:
 *   - GCS credentials in tests/.env (GCS_BUCKET_NAME, GCS_PROJECT_ID, GCS_KEY_FILENAME)
 *   - MongoDB on localhost:27017
 *   - sharp installed
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import { fileURLToPath } from 'url';
import * as dotenv from 'dotenv';
import { createMedia } from '../src/media';
import { GCSProvider } from '../src/providers/gcs.provider';
import { PROCESSING_PRESETS } from '../src/processing/presets';

// Load test environment
const __filename2 = fileURLToPath(import.meta.url);
const __dirname2 = path.dirname(__filename2);
dotenv.config({ path: path.join(__dirname2, '.env') });

// Resolve key file path relative to tests/ directory
const keyFilename = process.env.GCS_KEY_FILENAME
  ? path.resolve(__dirname2, process.env.GCS_KEY_FILENAME)
  : undefined;

// Skip if GCS credentials not available or key file doesn't exist
const hasGcsCredentials =
  !!process.env.GCS_BUCKET_NAME &&
  !!process.env.GCS_PROJECT_ID &&
  !!keyFilename &&
  fsSync.existsSync(keyFilename);

const TEST_PREFIX = 'media-kit-processing-test';

describe.skipIf(!hasGcsCredentials)('GCS Processing Integration', () => {
  let gcsDriver: GCSProvider;
  const cleanupIds: string[] = [];
  const cleanupKeys: string[] = [];
  let testImageBuffer: Buffer;

  beforeAll(async () => {
    await mongoose.connect('mongodb://localhost:27017/mediakit-processing-test');

    gcsDriver = new GCSProvider({
      bucket: process.env.GCS_BUCKET_NAME!,
      projectId: process.env.GCS_PROJECT_ID!,
      keyFilename,
      makePublic: true,
    });

    // Load test image (800x608 JPEG, 18KB)
    testImageBuffer = await fs.readFile(path.join(__dirname2, 'test-img.jpg'));
  });

  afterAll(async () => {
    // Clean up GCS files
    for (const key of cleanupKeys) {
      try { await gcsDriver.delete(key); } catch { /* ignore */ }
    }
    // Clean up DB records
    for (const id of cleanupIds) {
      try {
        for (const model of Object.values(mongoose.models)) {
          await model.findByIdAndDelete(id).catch(() => {});
        }
      } catch { /* ignore */ }
    }
    console.log(`\n  Cleaned up ${cleanupKeys.length} processing test files`);
    // Clean up models
    Object.keys(mongoose.models).forEach(key => delete mongoose.models[key]);
    await mongoose.connection.close();
  });

  const trackResult = (result: any) => {
    cleanupIds.push(result._id.toString());
    cleanupKeys.push(result.key);
    if (result.variants) {
      for (const v of result.variants) {
        cleanupKeys.push(v.key);
      }
    }
  };

  // ============================================================
  // Basic Processing
  // ============================================================

  it('upload JPEG with processing enabled — converts to WebP', async () => {
    const media = createMedia({
      driver: gcsDriver,
      processing: {
        enabled: true,
        format: 'webp',
        quality: { webp: 80 },
        maxWidth: 600,
        originalHandling: 'discard',
      },
      suppressWarnings: true,
    });

    const Model = mongoose.model('Test', media.schema);
    media.init(Model);

    const result = await media.upload({
      buffer: testImageBuffer,
      filename: 'test-webp-convert.jpg',
      mimeType: 'image/jpeg',
      folder: `${TEST_PREFIX}/basic`,
    });
    trackResult(result);

    console.log('  WebP convert:', result.url, `${result.size} bytes`);

    expect(result.mimeType).toBe('image/webp');
    expect(result.status).toBe('ready');
    expect(result.width).toBeLessThanOrEqual(600);
    expect(result.width).toBeGreaterThan(0);
    expect(result.height).toBeGreaterThan(0);
    // WebP should be smaller than source JPEG at lower resolution
    expect(result.size).toBeLessThan(testImageBuffer.length);
  }, 45000);

  it('upload with mozjpeg — produces optimized JPEG', async () => {
    const media = createMedia({
      driver: gcsDriver,
      processing: {
        enabled: true,
        format: 'jpeg',
        quality: { jpeg: 80 },
        originalHandling: 'discard',
        sharpOptions: { mozjpeg: true },
      },
      suppressWarnings: true,
    });

    const Model = mongoose.model('Test', media.schema);
    media.init(Model);

    const result = await media.upload({
      buffer: testImageBuffer,
      filename: 'test-mozjpeg.jpg',
      mimeType: 'image/jpeg',
      folder: `${TEST_PREFIX}/basic`,
    });
    trackResult(result);

    console.log('  mozjpeg:', result.url, `${result.size} bytes`);

    expect(result.mimeType).toBe('image/jpeg');
    expect(result.status).toBe('ready');
    expect(result.size).toBeGreaterThan(0);
  }, 45000);

  // ============================================================
  // Processing Presets
  // ============================================================

  it('social-media preset — 1080px max, generates thumb + small + medium', async () => {
    const media = createMedia({
      driver: gcsDriver,
      processing: {
        ...PROCESSING_PRESETS['social-media'],
        enabled: true,
        originalHandling: 'discard',
      },
      suppressWarnings: true,
    });

    const Model = mongoose.model('Test', media.schema);
    media.init(Model);

    const result = await media.upload({
      buffer: testImageBuffer,
      filename: 'test-social.jpg',
      mimeType: 'image/jpeg',
      folder: `${TEST_PREFIX}/presets`,
    });
    trackResult(result);

    console.log('  Social preset:', result.url, `${result.size} bytes, variants:`, result.variants.map((v: any) => v.name));

    expect(result.status).toBe('ready');
    expect(result.mimeType).toBe('image/jpeg');
    // Original is 800px wide, so it stays at 800 (no upscale past 1080)
    expect(result.width).toBeLessThanOrEqual(1080);

    // Should have thumb, small, medium variants (but only if source > variant width)
    const variantNames = result.variants.map((v: any) => v.name);
    expect(variantNames).toContain('thumb');
    expect(variantNames).toContain('small');
    expect(variantNames).toContain('medium');

    // Thumb should be 150x150
    const thumb = result.variants.find((v: any) => v.name === 'thumb');
    expect(thumb).toBeDefined();
    expect(thumb!.width).toBeLessThanOrEqual(150);

    // Small should be 320px wide
    const small = result.variants.find((v: any) => v.name === 'small');
    expect(small).toBeDefined();
    expect(small!.width).toBeLessThanOrEqual(320);
  }, 60000);

  it('web-optimized preset — WebP output, 2048px max', async () => {
    const media = createMedia({
      driver: gcsDriver,
      processing: {
        ...PROCESSING_PRESETS['web-optimized'],
        enabled: true,
        originalHandling: 'discard',
      },
      suppressWarnings: true,
    });

    const Model = mongoose.model('Test', media.schema);
    media.init(Model);

    const result = await media.upload({
      buffer: testImageBuffer,
      filename: 'test-web-optimized.jpg',
      mimeType: 'image/jpeg',
      folder: `${TEST_PREFIX}/presets`,
    });
    trackResult(result);

    console.log('  Web-optimized:', result.url, `${result.size} bytes`);

    expect(result.mimeType).toBe('image/webp');
    expect(result.status).toBe('ready');
    expect(result.width).toBeLessThanOrEqual(2048);
  }, 45000);

  it('high-quality preset — preserves original format', async () => {
    const media = createMedia({
      driver: gcsDriver,
      processing: {
        ...PROCESSING_PRESETS['high-quality'],
        enabled: true,
        originalHandling: 'discard',
      },
      suppressWarnings: true,
    });

    const Model = mongoose.model('Test', media.schema);
    media.init(Model);

    const result = await media.upload({
      buffer: testImageBuffer,
      filename: 'test-high-quality.jpg',
      mimeType: 'image/jpeg',
      folder: `${TEST_PREFIX}/presets`,
    });
    trackResult(result);

    console.log('  High-quality:', result.url, `${result.size} bytes`);

    // 'original' format means JPEG stays JPEG
    expect(result.mimeType).toBe('image/jpeg');
    expect(result.status).toBe('ready');
  }, 45000);

  it('thumbnail preset — WebP, max 300px, no original variant', async () => {
    const media = createMedia({
      driver: gcsDriver,
      processing: {
        ...PROCESSING_PRESETS['thumbnail'],
        enabled: true,
      },
      suppressWarnings: true,
    });

    const Model = mongoose.model('Test', media.schema);
    media.init(Model);

    const result = await media.upload({
      buffer: testImageBuffer,
      filename: 'test-thumbnail.jpg',
      mimeType: 'image/jpeg',
      folder: `${TEST_PREFIX}/presets`,
    });
    trackResult(result);

    console.log('  Thumbnail:', result.url, `${result.size} bytes, ${result.width}x${result.height}`);

    expect(result.mimeType).toBe('image/webp');
    expect(result.width).toBeLessThanOrEqual(300);
    expect(result.height).toBeLessThanOrEqual(300);
    // No __original variant (keepOriginal: false in thumbnail preset)
    const hasOriginal = result.variants.some((v: any) => v.name === '__original');
    expect(hasOriginal).toBe(false);
  }, 45000);

  // ============================================================
  // Preset via config.preset field
  // ============================================================

  it('preset field in config — resolves social-media preset', async () => {
    const media = createMedia({
      driver: gcsDriver,
      processing: {
        enabled: true,
        preset: 'social-media',
        originalHandling: 'discard',
      },
      suppressWarnings: true,
    });

    const Model = mongoose.model('Test', media.schema);
    media.init(Model);

    const result = await media.upload({
      buffer: testImageBuffer,
      filename: 'test-preset-field.jpg',
      mimeType: 'image/jpeg',
      folder: `${TEST_PREFIX}/presets`,
    });
    trackResult(result);

    // social-media preset: JPEG output, 1080px max
    expect(result.mimeType).toBe('image/jpeg');
    expect(result.width).toBeLessThanOrEqual(1080);
    expect(result.status).toBe('ready');

    // Should have size variants from the preset
    const variantNames = result.variants.map((v: any) => v.name);
    expect(variantNames).toContain('thumb');
  }, 60000);

  // ============================================================
  // Original Handling Modes
  // ============================================================

  it('originalHandling: keep-variant — stores __original variant', async () => {
    const media = createMedia({
      driver: gcsDriver,
      processing: {
        enabled: true,
        format: 'webp',
        originalHandling: 'keep-variant',
      },
      suppressWarnings: true,
    });

    const Model = mongoose.model('Test', media.schema);
    media.init(Model);

    const result = await media.upload({
      buffer: testImageBuffer,
      filename: 'test-keep-variant.jpg',
      mimeType: 'image/jpeg',
      folder: `${TEST_PREFIX}/original`,
    });
    trackResult(result);

    const original = result.variants.find((v: any) => v.name === '__original');
    expect(original).toBeDefined();
    expect(original!.mimeType).toBe('image/jpeg'); // Original format preserved
    console.log('  Keep-variant: main=', result.mimeType, 'original=', original!.mimeType);
  }, 45000);

  it('originalHandling: discard — no __original variant', async () => {
    const media = createMedia({
      driver: gcsDriver,
      processing: {
        enabled: true,
        format: 'webp',
        originalHandling: 'discard',
      },
      suppressWarnings: true,
    });

    const Model = mongoose.model('Test', media.schema);
    media.init(Model);

    const result = await media.upload({
      buffer: testImageBuffer,
      filename: 'test-discard.jpg',
      mimeType: 'image/jpeg',
      folder: `${TEST_PREFIX}/original`,
    });
    trackResult(result);

    const original = result.variants.find((v: any) => v.name === '__original');
    expect(original).toBeUndefined();
    expect(result.mimeType).toBe('image/webp');
    console.log('  Discard: no __original, main=', result.mimeType);
  }, 45000);

  it('originalHandling: replace — processed is main, no __original', async () => {
    const media = createMedia({
      driver: gcsDriver,
      processing: {
        enabled: true,
        format: 'webp',
        originalHandling: 'replace',
      },
      suppressWarnings: true,
    });

    const Model = mongoose.model('Test', media.schema);
    media.init(Model);

    const result = await media.upload({
      buffer: testImageBuffer,
      filename: 'test-replace.jpg',
      mimeType: 'image/jpeg',
      folder: `${TEST_PREFIX}/original`,
    });
    trackResult(result);

    const original = result.variants.find((v: any) => v.name === '__original');
    expect(original).toBeUndefined();
    expect(result.mimeType).toBe('image/webp');
    console.log('  Replace: no __original, main=', result.mimeType);
  }, 45000);

  // ============================================================
  // Metadata Extraction
  // ============================================================

  it('extracts dominant color + thumbhash', async () => {
    const media = createMedia({
      driver: gcsDriver,
      processing: {
        enabled: true,
        thumbhash: true,
        dominantColor: true,
        originalHandling: 'discard',
      },
      suppressWarnings: true,
    });

    const Model = mongoose.model('Test', media.schema);
    media.init(Model);

    const result = await media.upload({
      buffer: testImageBuffer,
      filename: 'test-metadata.jpg',
      mimeType: 'image/jpeg',
      folder: `${TEST_PREFIX}/metadata`,
    });
    trackResult(result);

    console.log('  Dominant color:', result.dominantColor, 'ThumbHash:', result.thumbhash?.substring(0, 20) + '...');

    // Dominant color should be a hex string
    if (result.dominantColor) {
      expect(result.dominantColor).toMatch(/^#[0-9a-f]{6}$/i);
    }

    // ThumbHash should be a base64 string
    if (result.thumbhash) {
      expect(result.thumbhash.length).toBeGreaterThan(10);
    }

    // Dimensions should be extracted
    expect(result.width).toBeGreaterThan(0);
    expect(result.height).toBeGreaterThan(0);
    expect(result.aspectRatio).toBeGreaterThan(0);
  }, 45000);

  // ============================================================
  // Public URL Accessibility
  // ============================================================

  it('variant URLs are accessible via HTTP', async () => {
    const media = createMedia({
      driver: gcsDriver,
      processing: {
        enabled: true,
        format: 'webp',
        originalHandling: 'keep-variant',
        sizes: [
          { name: 'small', width: 200 },
        ],
      },
      suppressWarnings: true,
    });

    const Model = mongoose.model('Test', media.schema);
    media.init(Model);

    const result = await media.upload({
      buffer: testImageBuffer,
      filename: 'test-urls.jpg',
      mimeType: 'image/jpeg',
      folder: `${TEST_PREFIX}/urls`,
    });
    trackResult(result);

    // Main file should be accessible
    const mainResponse = await fetch(result.url);
    expect(mainResponse.ok).toBe(true);

    // Variant URLs should be accessible
    for (const variant of result.variants) {
      const response = await fetch(variant.url);
      expect(response.ok).toBe(true);
      console.log(`  ${variant.name}: ${variant.url} (${response.status})`);
    }
  }, 60000);
});
