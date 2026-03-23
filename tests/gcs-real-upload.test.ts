/**
 * GCS Real Upload Test — Integration test with actual Google Cloud Storage
 *
 * Part 1: Driver-level tests (GCSProvider directly)
 *   - write, read, stat, exists, copy, delete, list
 *   - Signed read URLs, presigned upload URLs
 *
 * Part 2: Media-kit integration (createMedia + GCSProvider + MongoDB)
 *   - Standard upload (Buffer → GCS → DB record)
 *   - Presigned upload flow (getSignedUploadUrl → PUT → confirmUpload)
 *   - Soft delete + restore
 *   - Public URL accessibility
 *
 * Requires:
 *   - GCS credentials in tests/.env (GCS_BUCKET_NAME, GCS_PROJECT_ID, GCS_KEY_FILENAME)
 *   - MongoDB on localhost:27017
 *
 * Bucket: classytic-crm (europe-north1, fine-grained access, makePublic enabled)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';
import * as path from 'path';
import * as fs from 'fs';
import { fileURLToPath } from 'url';
import * as dotenv from 'dotenv';
import { createMedia } from '../src/media';
import { GCSProvider } from '../src/providers/gcs.provider';

// Load test environment
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, '.env') });

// Resolve key file path relative to tests/ directory
const keyFilename = process.env.GCS_KEY_FILENAME
  ? path.resolve(__dirname, process.env.GCS_KEY_FILENAME)
  : undefined;

// Skip if GCS credentials not available or key file doesn't exist
const hasGcsCredentials =
  !!process.env.GCS_BUCKET_NAME &&
  !!process.env.GCS_PROJECT_ID &&
  !!keyFilename &&
  fs.existsSync(keyFilename);

const TEST_PREFIX = 'media-kit-test';

// ============================================================
// Part 1: Driver-Level Tests (no MongoDB)
// ============================================================

describe.skipIf(!hasGcsCredentials)('GCS Driver Test', () => {
  let driver: GCSProvider;
  let uploadedKey: string;
  const testKeys: string[] = [];

  const trackKey = (key: string) => { testKeys.push(key); return key; };

  beforeAll(() => {
    driver = new GCSProvider({
      bucket: process.env.GCS_BUCKET_NAME!,
      projectId: process.env.GCS_PROJECT_ID!,
      keyFilename,
      makePublic: true,
    });
  });

  afterAll(async () => {
    console.log(`\n🧹 Cleaning up ${testKeys.length} driver test file(s)...`);
    for (const key of testKeys) {
      try { await driver.delete(key); } catch { /* ignore */ }
    }
  });

  it('write() — upload buffer, returns WriteResult with public URL', async () => {
    const buffer = Buffer.from('hello gcs driver test');
    const key = `${TEST_PREFIX}/driver-test-${Date.now()}.txt`;

    const result = await driver.write(key, buffer, 'text/plain');
    uploadedKey = trackKey(result.key);

    console.log('📤 Write:', { url: result.url, size: result.size });

    expect(result.url).toContain('storage.googleapis.com');
    expect(result.url).toContain(process.env.GCS_BUCKET_NAME);
    expect(result.key).toBe(key);
    expect(result.size).toBe(buffer.length);
  }, 30000);

  it('exists() — true for uploaded, false for nonexistent', async () => {
    expect(await driver.exists(uploadedKey)).toBe(true);
    expect(await driver.exists(`${TEST_PREFIX}/nope-${Date.now()}.txt`)).toBe(false);
  }, 15000);

  it('stat() — returns size and contentType', async () => {
    const stat = await driver.stat(uploadedKey);
    expect(stat.contentType).toBe('text/plain');
    expect(stat.size).toBe(21); // 'hello gcs driver test'.length
    expect(stat.etag).toBeDefined();
  }, 15000);

  it('read() — streams back correct content', async () => {
    const stream = await driver.read(uploadedKey);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    expect(Buffer.concat(chunks).toString('utf-8')).toBe('hello gcs driver test');
  }, 15000);

  it('copy() — creates a copy, both files exist', async () => {
    const destKey = trackKey(`${TEST_PREFIX}/copied-${Date.now()}.txt`);
    const result = await driver.copy!(uploadedKey, destKey);

    expect(result.key).toBe(destKey);
    expect(await driver.exists(uploadedKey)).toBe(true);
    expect(await driver.exists(destKey)).toBe(true);
  }, 30000);

  it('getSignedUrl() — returns a signed read URL', async () => {
    const url = await driver.getSignedUrl!(uploadedKey, 600);
    expect(url).toContain('https://');
    expect(url).toContain('Signature');
  }, 15000);

  it('getSignedUploadUrl() — returns presigned upload URL structure', async () => {
    const key = `${TEST_PREFIX}/presigned-${Date.now()}.txt`;
    const result = await driver.getSignedUploadUrl!(key, 'text/plain', 600);

    expect(result.uploadUrl).toContain('X-Goog-Signature');
    expect(result.key).toBe(key);
    expect(result.publicUrl).toContain(process.env.GCS_BUCKET_NAME);
    expect(result.expiresIn).toBe(600);
    expect(result.headers!['Content-Type']).toBe('text/plain');
    // Don't track — file not actually uploaded
  }, 15000);

  it('list() — yields keys matching prefix', async () => {
    const keys: string[] = [];
    for await (const key of driver.list(TEST_PREFIX)) {
      keys.push(key);
      if (keys.length >= 10) break; // safety limit
    }
    expect(keys.length).toBeGreaterThanOrEqual(1);
    expect(keys.every(k => k.startsWith(TEST_PREFIX))).toBe(true);
  }, 15000);

  it('delete() — removes file, returns true; false for nonexistent', async () => {
    // Upload, delete, verify gone
    const key = `${TEST_PREFIX}/delete-me-${Date.now()}.txt`;
    await driver.write(key, Buffer.from('bye'), 'text/plain');

    expect(await driver.delete(key)).toBe(true);
    expect(await driver.exists(key)).toBe(false);
    expect(await driver.delete(`${TEST_PREFIX}/nope-${Date.now()}.txt`)).toBe(false);
  }, 30000);
});

// ============================================================
// Part 2: Media-Kit Integration Tests (GCS + MongoDB)
// ============================================================

describe.skipIf(!hasGcsCredentials)('GCS Media-Kit Integration', () => {
  let media: ReturnType<typeof createMedia>;
  let Media: mongoose.Model<any>;
  const cleanupIds: string[] = [];
  const cleanupKeys: string[] = [];

  beforeAll(async () => {
    await mongoose.connect('mongodb://localhost:27017/mediakit-gcs-test');

    const gcsDriver = new GCSProvider({
      bucket: process.env.GCS_BUCKET_NAME!,
      projectId: process.env.GCS_PROJECT_ID!,
      keyFilename,
      makePublic: true,
    });

    media = createMedia({
      driver: gcsDriver,
      processing: { enabled: false },
      fileTypes: {
        allowed: ['image/*', 'video/*', 'audio/*', 'text/*'],
        maxSize: 50 * 1024 * 1024,
      },
      softDelete: { enabled: true, ttlDays: 1 },
      suppressWarnings: true,
    });

    Media = mongoose.model('Test', media.schema);
    media.init(Media);

    // Clean up previous test data
    await Media.deleteMany({ folder: { $regex: /^test\// } });
  });

  afterAll(async () => {
    // Clean up GCS files
    for (const key of cleanupKeys) {
      try { await media.driver.delete(key); } catch { /* ignore */ }
    }
    // Clean up DB records
    for (const id of cleanupIds) {
      try { await Media.findByIdAndDelete(id); } catch { /* ignore */ }
    }
    console.log(`\n🧹 Cleaned up ${cleanupKeys.length} integration test files`);
    await mongoose.connection.close();
  });

  const trackResult = (result: any) => {
    cleanupIds.push(result._id.toString());
    cleanupKeys.push(result.key);
  };

  // --- Standard Upload ---

  it('upload() — text file → GCS + DB record', async () => {
    const content = `media-kit GCS test ${Date.now()}`;
    const buffer = Buffer.from(content);

    const result = await media.upload({
      buffer,
      filename: 'integration-test.txt',
      mimeType: 'text/plain',
      folder: 'test/integration',
    });
    trackResult(result);

    console.log('📤 Upload:', result.url);

    expect(result.url).toContain('storage.googleapis.com');
    expect(result.mimeType).toBe('text/plain');
    expect(result.status).toBe('ready');
    expect(result.size).toBe(buffer.length);
    expect(result.hash).toBeDefined();
    expect(result.hash.length).toBe(64); // SHA-256

    const doc = await Media.findById(result._id);
    expect(doc).toBeDefined();
    expect(doc!.originalFilename).toBe('integration-test.txt');
  }, 30000);

  it('upload() — PNG image with alt text', async () => {
    // Minimal 1x1 PNG
    const pngBuffer = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==',
      'base64'
    );

    const result = await media.upload({
      buffer: pngBuffer,
      filename: 'test-pixel.png',
      mimeType: 'image/png',
      folder: 'test/integration',
      alt: 'Test pixel image',
    });
    trackResult(result);

    expect(result.mimeType).toBe('image/png');
    expect(result.alt).toBe('Test pixel image');
    console.log('🖼️  Image:', result.url);
  }, 30000);

  // --- Presigned Upload Flow ---

  it('presigned flow — getSignedUploadUrl → PUT → confirmUpload', async () => {
    // Step 1: Get presigned URL
    const presigned = await media.getSignedUploadUrl(
      'presigned-flow.txt',
      'text/plain',
      { folder: 'test/integration' }
    );

    console.log('🔑 Presigned key:', presigned.key);

    expect(presigned.uploadUrl).toContain('X-Goog-Signature');
    expect(presigned.key).toContain('test/integration');

    // Step 2: PUT to GCS via presigned URL (simulates browser upload)
    const fileContent = `Presigned upload at ${new Date().toISOString()}`;
    const putResponse = await fetch(presigned.uploadUrl, {
      method: 'PUT',
      headers: presigned.headers,
      body: fileContent,
    });

    expect(putResponse.ok).toBe(true);
    console.log('📤 PUT:', putResponse.status, putResponse.statusText);

    // Step 3: Confirm upload (creates DB record with storage-verified metadata)
    const confirmed = await media.confirmUpload({
      key: presigned.key,
      filename: 'presigned-flow.txt',
      mimeType: 'text/plain',
      size: Buffer.byteLength(fileContent),
    });
    trackResult(confirmed);

    console.log('✅ Confirmed:', confirmed._id, '→', confirmed.url);

    expect(confirmed.status).toBe('ready');
    expect(confirmed.key).toBe(presigned.key);
    expect(confirmed.hash).toBeDefined();
    expect(confirmed.hash.length).toBeGreaterThan(0); // hash format depends on strategy (etag/sha256/skip)
    expect(confirmed.mimeType).toBe('text/plain');

    // Verify DB
    const doc = await Media.findById(confirmed._id);
    expect(doc).toBeDefined();
    expect(doc!.status).toBe('ready');
  }, 45000);

  // --- Public URL Accessibility ---

  it('public URL — uploaded file is fetchable via HTTP', async () => {
    const content = 'public access test ' + Date.now();
    const result = await media.upload({
      buffer: Buffer.from(content),
      filename: 'public-test.txt',
      mimeType: 'text/plain',
      folder: 'test/integration',
    });
    trackResult(result);

    const response = await fetch(result.url);
    expect(response.ok).toBe(true);

    const body = await response.text();
    expect(body).toBe(content);
    console.log('🌐 Public URL verified:', result.url);
  }, 30000);

  // --- Soft Delete + Restore ---

  it('soft delete + restore — hides from queries, restores, file persists', async () => {
    const result = await media.upload({
      buffer: Buffer.from('soft-delete test'),
      filename: 'soft-delete.txt',
      mimeType: 'text/plain',
      folder: 'test/integration',
    });
    trackResult(result);
    const id = result._id.toString();

    // Soft delete
    await media.softDelete(id);
    expect(await media.getById(id)).toBeNull();

    // Still in trash
    const trashed = await media.getById(id, { includeTrashed: true });
    expect(trashed).toBeDefined();
    expect(trashed!.deletedAt).toBeDefined();

    // File still in GCS
    expect(await media.driver.exists(result.key)).toBe(true);

    // Restore
    await media.restore(id);
    const restored = await media.getById(id);
    expect(restored).toBeDefined();
    expect(restored!.deletedAt).toBeFalsy(); // null or undefined after restore
    console.log('♻️  Soft-delete + restore verified');
  }, 30000);

  // --- Hash Integrity ---

  it('hash — upload computes correct SHA-256', async () => {
    const buffer = Buffer.from('hash integrity check');
    const result = await media.upload({
      buffer,
      filename: 'hash-check.txt',
      mimeType: 'text/plain',
      folder: 'test/integration',
    });
    trackResult(result);

    // Compute expected hash
    const crypto = await import('crypto');
    const expected = crypto.createHash('sha256').update(buffer).digest('hex');

    expect(result.hash).toBe(expected);
    console.log('🔗 Hash verified:', result.hash.substring(0, 16) + '...');
  }, 30000);
});

export const testInfo = {
  name: 'GCS Real Upload Test',
  description: 'Tests GCSProvider + media-kit integration against real GCS bucket with MongoDB',
  requires: ['GCS_BUCKET_NAME, GCS_PROJECT_ID, GCS_KEY_FILENAME in tests/.env', 'MongoDB on localhost:27017'],
};
