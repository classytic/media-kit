/**
 * S3 Integration Test — End-to-end tests with real AWS S3
 *
 * Tests:
 *   1. Standard upload — video file (Buffer → S3 → DB record)
 *   2. Presigned upload — getSignedUploadUrl → PUT → confirmUpload
 *   3. Multipart upload — createMultipartUpload → signParts → PUT parts → completeMultipartUpload
 *   4. Batch presigned URLs — generateBatchPutUrls for multiple files
 *   5. Delete + cleanup — delete removes S3 file AND DB record
 *   6. Soft delete + restore — soft-delete hides, restore brings back, file persists in S3
 *
 * Requires:
 *   - AWS credentials in tests/.env (AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, S3_BUCKET_NAME)
 *   - MongoDB on localhost:27017
 *   - Video file: ../../Rainy_Window_City_Bokeh_Video.mp4 (5.6MB)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import * as dotenv from 'dotenv';
import { createMedia } from '../src/media';
import { S3Provider } from '../src/providers/s3.provider';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, '.env') });

const hasAwsCredentials =
  !!process.env.AWS_ACCESS_KEY_ID &&
  !!process.env.AWS_SECRET_ACCESS_KEY &&
  !!process.env.S3_BUCKET_NAME;

const VIDEO_PATH = path.resolve(__dirname, '../../../Rainy_Window_City_Bokeh_Video.mp4');
const hasVideoFile = fs.existsSync(VIDEO_PATH);

const TEST_FOLDER = 'media-kit-integration-test';

describe.skipIf(!hasAwsCredentials)('S3 Integration', () => {
  let media: ReturnType<typeof createMedia>;
  let Media: mongoose.Model<any>;
  let driver: S3Provider;

  // Track everything for cleanup
  const cleanupIds: string[] = [];
  const cleanupKeys: string[] = [];

  beforeAll(async () => {
    await mongoose.connect('mongodb://localhost:27017/mediakit-s3-integration');

    driver = new S3Provider({
      bucket: process.env.S3_BUCKET_NAME!,
      region: process.env.AWS_REGION || 'eu-north-1',
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
      },
    });

    media = createMedia({
      driver,
      processing: { enabled: false },
      fileTypes: {
        allowed: ['image/*', 'video/*', 'audio/*', 'text/*'],
        maxSize: 100 * 1024 * 1024, // 100MB
      },
      softDelete: { enabled: true, ttlDays: 1 },
      suppressWarnings: true,
    });

    Media = mongoose.model('Test', media.schema);
    media.init(Media);

    await Media.deleteMany({ folder: { $regex: new RegExp(`^${TEST_FOLDER}`) } });
  });

  afterAll(async () => {
    console.log(`\n🧹 Cleaning up ${cleanupKeys.length} S3 files + ${cleanupIds.length} DB records...`);

    for (const key of cleanupKeys) {
      try { await driver.delete(key); } catch { /* ignore */ }
    }
    for (const id of cleanupIds) {
      try { await Media.findByIdAndDelete(id); } catch { /* ignore */ }
    }

    // Also clean any leftover test files
    try {
      for await (const key of driver.list(TEST_FOLDER)) {
        try { await driver.delete(key); } catch { /* ignore */ }
      }
    } catch { /* ignore */ }

    await mongoose.connection.close();
    console.log('✅ Cleanup complete');
  });

  const track = (result: any) => {
    cleanupIds.push(result._id.toString());
    cleanupKeys.push(result.key);
    if (result.variants) {
      for (const v of result.variants) cleanupKeys.push(v.key);
    }
  };

  // ─────────────────────────────────────────────
  // 1. Standard upload — text file
  // ─────────────────────────────────────────────

  it('upload() — text file → S3 + DB', async () => {
    const content = `S3 integration test ${Date.now()}`;
    const buffer = Buffer.from(content);

    const result = await media.upload({
      buffer,
      filename: 'test-text.txt',
      mimeType: 'text/plain',
      folder: TEST_FOLDER,
    });
    track(result);

    console.log('📤 Text upload:', result.url);

    expect(result.url).toContain(process.env.S3_BUCKET_NAME);
    expect(result.mimeType).toBe('text/plain');
    expect(result.status).toBe('ready');
    expect(result.size).toBe(buffer.length);
    expect(result.hash).toBeDefined();

    const doc = await Media.findById(result._id);
    expect(doc).toBeDefined();
    expect(doc!.originalFilename).toBe('test-text.txt');
  }, 30000);

  // ─────────────────────────────────────────────
  // 2. Standard upload — real video file
  // ─────────────────────────────────────────────

  it.skipIf(!hasVideoFile)('upload() — video file (5.6MB) → S3 + DB', async () => {
    const videoBuffer = fs.readFileSync(VIDEO_PATH);
    console.log('📹 Video size:', (videoBuffer.length / 1024 / 1024).toFixed(2), 'MB');

    const result = await media.upload({
      buffer: videoBuffer,
      filename: 'Rainy_Window_City_Bokeh_Video.mp4',
      mimeType: 'video/mp4',
      folder: TEST_FOLDER,
    });
    track(result);

    console.log('📤 Video upload:', result.url);
    console.log('   Key:', result.key);
    console.log('   Size:', result.size, 'bytes');

    expect(result.url).toContain(process.env.S3_BUCKET_NAME);
    expect(result.mimeType).toBe('video/mp4');
    expect(result.status).toBe('ready');
    expect(result.size).toBe(videoBuffer.length);

    // Verify in S3
    expect(await driver.exists(result.key)).toBe(true);
    const stat = await driver.stat(result.key);
    expect(stat.size).toBe(videoBuffer.length);
    expect(stat.contentType).toBe('video/mp4');
  }, 60000);

  // ─────────────────────────────────────────────
  // 3. Presigned upload — getSignedUploadUrl → PUT → confirmUpload
  // ─────────────────────────────────────────────

  it('presigned flow — sign → PUT → confirm', async () => {
    // Step 1: Get presigned URL
    const presigned = await media.getSignedUploadUrl(
      'presigned-test.txt',
      'text/plain',
      { folder: TEST_FOLDER },
    );

    console.log('🔑 Presigned key:', presigned.key);
    expect(presigned.uploadUrl).toContain('X-Amz-Signature');
    expect(presigned.key).toContain(TEST_FOLDER);

    // Step 2: PUT directly to S3
    const fileContent = `Presigned upload at ${new Date().toISOString()}`;
    const putResponse = await fetch(presigned.uploadUrl, {
      method: 'PUT',
      headers: presigned.headers,
      body: fileContent,
    });

    expect(putResponse.ok).toBe(true);
    console.log('📤 PUT:', putResponse.status, putResponse.statusText);

    // Step 3: Confirm (creates DB record)
    const confirmed = await media.confirmUpload({
      key: presigned.key,
      filename: 'presigned-test.txt',
      mimeType: 'text/plain',
      size: Buffer.byteLength(fileContent),
    });
    track(confirmed);

    console.log('✅ Confirmed:', confirmed._id, '→', confirmed.url);

    expect(confirmed.status).toBe('ready');
    expect(confirmed.key).toBe(presigned.key);
    expect(confirmed.hash).toBeDefined();
    expect(confirmed.hash.length).toBeGreaterThan(0);

    // Verify in DB
    const doc = await Media.findById(confirmed._id);
    expect(doc).toBeDefined();
    expect(doc!.status).toBe('ready');
  }, 45000);

  // ─────────────────────────────────────────────
  // 4. Multipart upload — full flow with real video
  // ─────────────────────────────────────────────

  it.skipIf(!hasVideoFile)('multipart flow — initiate → sign parts → PUT → complete', async () => {
    const videoBuffer = fs.readFileSync(VIDEO_PATH);
    const PART_SIZE = 5 * 1024 * 1024; // 5MB — S3 minimum
    const partCount = Math.ceil(videoBuffer.length / PART_SIZE);

    console.log(`📹 Multipart: ${(videoBuffer.length / 1024 / 1024).toFixed(2)}MB in ${partCount} parts`);

    // Step 1: Initiate multipart upload
    const session = await media.initiateMultipartUpload({
      filename: 'multipart-video.mp4',
      contentType: 'video/mp4',
      folder: TEST_FOLDER,
      partCount,
    });

    expect(session.type).toBe('multipart');
    expect(session.uploadId).toBeDefined();
    expect(session.key).toContain(TEST_FOLDER);
    expect(session.parts).toHaveLength(partCount);
    console.log('🔑 Session:', { type: session.type, uploadId: session.uploadId!.substring(0, 20) + '...', parts: session.parts!.length });

    // Step 2: PUT each part to S3 via presigned URLs
    const completedParts: Array<{ partNumber: number; etag: string }> = [];

    for (let i = 0; i < partCount; i++) {
      const start = i * PART_SIZE;
      const end = Math.min(start + PART_SIZE, videoBuffer.length);
      const chunk = videoBuffer.subarray(start, end);

      const partUrl = session.parts![i]!.uploadUrl;
      const response = await fetch(partUrl, {
        method: 'PUT',
        body: chunk,
      });

      expect(response.ok).toBe(true);
      const etag = response.headers.get('etag')!;
      completedParts.push({ partNumber: i + 1, etag });
      console.log(`   Part ${i + 1}/${partCount}: ${(chunk.length / 1024 / 1024).toFixed(2)}MB → ${response.status} (ETag: ${etag.substring(0, 12)}...)`);
    }

    // Step 3: Complete multipart upload (assemble + DB record)
    const result = await media.completeMultipartUpload({
      key: session.key,
      uploadId: session.uploadId!,
      parts: completedParts,
      filename: 'multipart-video.mp4',
      mimeType: 'video/mp4',
      size: videoBuffer.length,
      folder: TEST_FOLDER,
    });
    track(result);

    console.log('✅ Multipart complete:', result._id, '→', result.url);

    expect(result.status).toBe('ready');
    expect(result.mimeType).toBe('video/mp4');
    expect(result.size).toBe(videoBuffer.length);

    // Verify file in S3
    expect(await driver.exists(result.key)).toBe(true);
    const stat = await driver.stat(result.key);
    expect(stat.size).toBe(videoBuffer.length);

    // Verify in DB
    const doc = await Media.findById(result._id);
    expect(doc).toBeDefined();
    expect(doc!.status).toBe('ready');
    expect(doc!.size).toBe(videoBuffer.length);
  }, 120000);

  // ─────────────────────────────────────────────
  // 5. Batch presigned URLs
  // ─────────────────────────────────────────────

  it('batch presigned — generates multiple URLs', async () => {
    const result = await media.generateBatchPutUrls({
      files: [
        { filename: 'segment-0.ts', contentType: 'video/mp2t' },
        { filename: 'segment-1.ts', contentType: 'video/mp2t' },
        { filename: 'segment-2.ts', contentType: 'video/mp2t' },
      ],
      folder: TEST_FOLDER,
      expiresIn: 600,
    });

    expect(result.uploads).toHaveLength(3);
    for (const upload of result.uploads) {
      expect(upload.uploadUrl).toContain('X-Amz-Signature');
      expect(upload.key).toContain(TEST_FOLDER);
      expect(upload.publicUrl).toContain(process.env.S3_BUCKET_NAME);
    }

    console.log('📦 Batch URLs:', result.uploads.map(u => u.key));
  }, 30000);

  // ─────────────────────────────────────────────
  // 6. Delete — removes S3 file AND DB record
  // ─────────────────────────────────────────────

  it('delete() — removes file from S3 + DB record', async () => {
    // Upload a file specifically for deletion test
    const buffer = Buffer.from('delete-me ' + Date.now());
    const uploaded = await media.upload({
      buffer,
      filename: 'delete-test.txt',
      mimeType: 'text/plain',
      folder: TEST_FOLDER,
    });
    // Don't track — we're deleting manually

    const id = uploaded._id.toString();
    const key = uploaded.key;

    // Verify it exists
    expect(await driver.exists(key)).toBe(true);
    expect(await Media.findById(id)).toBeDefined();

    // Delete
    const deleted = await media.delete(id);
    expect(deleted).toBe(true);

    // Verify S3 file is GONE
    expect(await driver.exists(key)).toBe(false);
    console.log('🗑️  S3 file deleted:', key);

    // Verify DB record is GONE
    expect(await Media.findById(id)).toBeNull();
    console.log('🗑️  DB record deleted:', id);
  }, 30000);

  // ─────────────────────────────────────────────
  // 7. Soft delete + restore
  // ─────────────────────────────────────────────

  it('soft delete + restore — hides from queries, file persists in S3', async () => {
    const buffer = Buffer.from('soft-delete test ' + Date.now());
    const uploaded = await media.upload({
      buffer,
      filename: 'soft-delete-test.txt',
      mimeType: 'text/plain',
      folder: TEST_FOLDER,
    });
    track(uploaded);

    const id = uploaded._id.toString();

    // Soft delete
    await media.softDelete(id);
    expect(await media.getById(id)).toBeNull(); // hidden from normal queries

    // Still in trash
    const trashed = await media.getById(id, { includeTrashed: true });
    expect(trashed).toBeDefined();
    expect(trashed!.deletedAt).toBeDefined();

    // S3 file still exists
    expect(await driver.exists(uploaded.key)).toBe(true);
    console.log('🗑️  Soft-deleted (file still in S3):', uploaded.key);

    // Restore
    await media.restore(id);
    const restored = await media.getById(id);
    expect(restored).toBeDefined();
    expect(restored!.deletedAt).toBeFalsy();
    console.log('♻️  Restored:', id);
  }, 30000);

  // ─────────────────────────────────────────────
  // 8. Multipart abort — clean up abandoned uploads
  // ─────────────────────────────────────────────

  it('multipart abort — initiate then abort cleans up', async () => {
    const session = await media.initiateMultipartUpload({
      filename: 'abort-test.mp4',
      contentType: 'video/mp4',
      folder: TEST_FOLDER,
    });

    expect(session.uploadId).toBeDefined();
    console.log('🔑 Initiated for abort:', session.uploadId!.substring(0, 20) + '...');

    // Abort — should not throw
    await media.abortMultipartUpload(session.key, session.uploadId!);
    console.log('🗑️  Multipart aborted successfully');
  }, 30000);
});

export const testInfo = {
  name: 'S3 Integration Test',
  description: 'End-to-end tests: upload, presigned, multipart, batch URLs, delete, soft-delete with real S3',
  requires: ['AWS creds in tests/.env', 'MongoDB on localhost:27017', 'Rainy_Window_City_Bokeh_Video.mp4 in project root'],
};
