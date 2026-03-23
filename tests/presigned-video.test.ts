/**
 * Presigned Upload, Video Upload & Streaming Cleanup Tests
 *
 * Tests:
 *   1. Presigned URL — generate, simulate upload, confirm, then delete+cleanup
 *   2. Presigned with hash strategies — etag, sha256, skip
 *   3. Presigned with post-confirm processing (image) — confirm + process, then cleanup
 *   4. Multipart upload — initiate, sign parts, upload parts, complete, then delete+cleanup
 *   5. Multipart abort — initiate, abort, verify no orphaned files
 *   6. Batch presigned URLs — generate multiple, confirm all, cleanup all
 *   7. Video upload — upload MP4 via buffer, verify metadata, then delete+cleanup
 *   8. Video streaming — read back video via driver.read() stream, verify integrity
 *   9. Large video via presigned flow — presign, simulate upload, confirm, cleanup
 *  10. Confirm upload validation — nonexistent file, MIME mismatch, size limit
 *
 * Requires MongoDB at localhost:27017.
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { Readable } from 'stream';
import { createMedia } from '../src/media';
import { MemoryStorageDriver } from './helpers/memory-driver';
import type {
  StorageDriver,
  WriteResult,
  FileStat,
  PresignedUploadResult,
  SignedPartResult,
  CompletedPart,
  MediaKit,
} from '../src/types';

const MONGO_URI = 'mongodb://localhost:27017/mediakit-presigned-video-test';

// ============================================
// Extended Memory Driver with Multipart Support
// ============================================

class MultipartMemoryDriver extends MemoryStorageDriver {
  private multipartSessions = new Map<
    string,
    { key: string; contentType: string; parts: Map<number, Buffer>; aborted: boolean }
  >();

  async createMultipartUpload(key: string, contentType: string): Promise<{ uploadId: string }> {
    const uploadId = crypto.randomUUID();
    this.multipartSessions.set(uploadId, {
      key,
      contentType,
      parts: new Map(),
      aborted: false,
    });
    return { uploadId };
  }

  async signUploadPart(
    key: string,
    uploadId: string,
    partNumber: number,
    expiresIn = 3600,
  ): Promise<SignedPartResult> {
    return {
      uploadUrl: `https://cdn.example.com/_multipart/${key}?uploadId=${uploadId}&partNumber=${partNumber}`,
      partNumber,
      expiresIn,
      headers: { 'Content-Type': 'application/octet-stream' },
    };
  }

  /** Simulate uploading a part (test helper) */
  simulatePartUpload(uploadId: string, partNumber: number, data: Buffer): string {
    const session = this.multipartSessions.get(uploadId);
    if (!session) throw new Error(`No session: ${uploadId}`);
    if (session.aborted) throw new Error(`Session aborted: ${uploadId}`);
    session.parts.set(partNumber, data);
    return `"${crypto.createHash('md5').update(data).digest('hex')}"`;
  }

  async completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: CompletedPart[],
  ): Promise<{ etag: string; size: number }> {
    const session = this.multipartSessions.get(uploadId);
    if (!session) throw new Error(`No multipart session: ${uploadId}`);
    if (session.aborted) throw new Error(`Session aborted: ${uploadId}`);

    // Assemble parts in order
    const sortedParts = parts.sort((a, b) => a.partNumber - b.partNumber);
    const buffers: Buffer[] = [];
    for (const part of sortedParts) {
      const data = session.parts.get(part.partNumber);
      if (!data) throw new Error(`Missing part ${part.partNumber}`);
      buffers.push(data);
    }
    const assembled = Buffer.concat(buffers);

    // Write the assembled file
    await this.write(key, assembled, session.contentType);

    // Clean up session
    this.multipartSessions.delete(uploadId);

    const etag = `"${crypto.createHash('md5').update(assembled).digest('hex')}"`;
    return { etag, size: assembled.length };
  }

  async abortMultipartUpload(key: string, uploadId: string): Promise<void> {
    const session = this.multipartSessions.get(uploadId);
    if (session) {
      session.aborted = true;
      session.parts.clear();
      this.multipartSessions.delete(uploadId);
    }
  }

  /** Check if any multipart sessions are still active (for leak tests) */
  get activeSessionCount(): number {
    return this.multipartSessions.size;
  }
}

describe('Presigned Upload, Video & Streaming', () => {
  beforeAll(async () => {
    await mongoose.connect(MONGO_URI);
  });

  afterAll(async () => {
    await mongoose.disconnect();
  });

  beforeEach(async () => {
    const collections = await mongoose.connection.db?.collections();
    if (collections) {
      for (const collection of collections) {
        await collection.deleteMany({});
      }
    }
    Object.keys(mongoose.models).forEach((key) => {
      delete mongoose.models[key];
    });
  });

  // =================================================================
  // 1. Presigned Upload — full lifecycle + cleanup
  // =================================================================

  describe('presigned upload lifecycle', () => {
    it('should generate presigned URL, confirm upload, then delete + cleanup', async () => {
      const driver = new MultipartMemoryDriver();
      const media = createMedia({
        driver,
        processing: { enabled: false },
        suppressWarnings: true,
      });
      const Media = mongoose.model('Test', media.schema);
      media.init(Media);

      // Step 1: Get presigned URL
      const presigned = await media.getSignedUploadUrl('document.pdf', 'application/pdf', {
        folder: 'documents',
      });

      expect(presigned.uploadUrl).toBeDefined();
      expect(presigned.key).toContain('documents/');
      expect(presigned.expiresIn).toBeGreaterThan(0);

      // Step 2: Simulate browser upload
      const fileBuffer = Buffer.from('PDF file content here');
      driver.simulateExternalUpload(presigned.key, fileBuffer, 'application/pdf');

      // Step 3: Confirm
      const confirmed = await media.confirmUpload({
        key: presigned.key,
        filename: 'document.pdf',
        mimeType: 'application/pdf',
        size: fileBuffer.length,
      });

      expect(confirmed.status).toBe('ready');
      expect(confirmed.key).toBe(presigned.key);
      expect(confirmed.folder).toBe('documents');
      expect(confirmed.size).toBe(fileBuffer.length);

      // Step 4: Delete and verify cleanup
      const id = (confirmed as any)._id.toString();
      await media.delete(id);

      expect(await driver.exists(presigned.key)).toBe(false);
      expect(driver.size).toBe(0);
      expect(await media.getById(id)).toBeNull();
    });

    it('should generate presigned URL with custom expiry', async () => {
      const driver = new MultipartMemoryDriver();
      const media = createMedia({
        driver,
        processing: { enabled: false },
        suppressWarnings: true,
      });
      const Media = mongoose.model('Test', media.schema);
      media.init(Media);

      const presigned = await media.getSignedUploadUrl('file.txt', 'text/plain', {
        folder: 'temp',
        expiresIn: 600,
      });

      expect(presigned.expiresIn).toBe(600);
    });

    it('should fire presigned upload events', async () => {
      const driver = new MultipartMemoryDriver();
      const media = createMedia({
        driver,
        processing: { enabled: false },
        suppressWarnings: true,
      });
      const Media = mongoose.model('Test', media.schema);
      media.init(Media);

      const beforeEvents: unknown[] = [];
      const afterEvents: unknown[] = [];
      media.on('before:presignedUpload', (e: unknown) => beforeEvents.push(e));
      media.on('after:presignedUpload', (e: unknown) => afterEvents.push(e));

      await media.getSignedUploadUrl('event-test.jpg', 'image/jpeg');

      expect(beforeEvents).toHaveLength(1);
      expect(afterEvents).toHaveLength(1);
    });
  });

  // =================================================================
  // 2. Presigned confirm — hash strategies
  // =================================================================

  describe('confirm upload hash strategies', () => {
    it('hashStrategy: skip — uses placeholder hash', async () => {
      const driver = new MultipartMemoryDriver();
      const media = createMedia({
        driver,
        processing: { enabled: false },
        suppressWarnings: true,
      });
      const Media = mongoose.model('Test', media.schema);
      media.init(Media);

      const presigned = await media.getSignedUploadUrl('skip.txt', 'text/plain');
      driver.simulateExternalUpload(presigned.key, Buffer.from('data'), 'text/plain');

      const confirmed = await media.confirmUpload({
        key: presigned.key,
        filename: 'skip.txt',
        mimeType: 'text/plain',
        size: 4,
        hashStrategy: 'skip',
      });

      expect(confirmed.hash).toBeDefined();
      expect(confirmed.hash.length).toBeGreaterThan(0);
    });

    it('hashStrategy: etag — uses ETag from storage stat', async () => {
      const driver = new MultipartMemoryDriver();
      const media = createMedia({
        driver,
        processing: { enabled: false },
        suppressWarnings: true,
      });
      const Media = mongoose.model('Test', media.schema);
      media.init(Media);

      const presigned = await media.getSignedUploadUrl('etag.txt', 'text/plain');
      const buf = Buffer.from('etag content');
      driver.simulateExternalUpload(presigned.key, buf, 'text/plain');

      const confirmed = await media.confirmUpload({
        key: presigned.key,
        filename: 'etag.txt',
        mimeType: 'text/plain',
        size: buf.length,
        hashStrategy: 'etag',
      });

      // MemoryStorageDriver returns MD5-based ETag from stat()
      const expectedEtag = `"${crypto.createHash('md5').update(buf).digest('hex')}"`;
      expect(confirmed.hash).toBe(expectedEtag);
    });

    it('hashStrategy: sha256 — streams file for real hash', async () => {
      const driver = new MultipartMemoryDriver();
      const media = createMedia({
        driver,
        processing: { enabled: false },
        suppressWarnings: true,
      });
      const Media = mongoose.model('Test', media.schema);
      media.init(Media);

      const presigned = await media.getSignedUploadUrl('sha.txt', 'text/plain');
      const buf = Buffer.from('sha256 content');
      driver.simulateExternalUpload(presigned.key, buf, 'text/plain');

      const confirmed = await media.confirmUpload({
        key: presigned.key,
        filename: 'sha.txt',
        mimeType: 'text/plain',
        size: buf.length,
        hashStrategy: 'sha256',
      });

      // Should be a real sha256 hash
      const expectedHash = crypto.createHash('sha256').update(buf).digest('hex');
      expect(confirmed.hash).toBe(expectedHash);
    });
  });

  // =================================================================
  // 3. Presigned confirm — validation errors
  // =================================================================

  describe('confirm upload validation', () => {
    it('should reject confirm for nonexistent key', async () => {
      const driver = new MultipartMemoryDriver();
      const media = createMedia({
        driver,
        processing: { enabled: false },
        suppressWarnings: true,
      });
      const Media = mongoose.model('Test', media.schema);
      media.init(Media);

      await expect(
        media.confirmUpload({
          key: 'fake/key.txt',
          filename: 'missing.txt',
          mimeType: 'text/plain',
          size: 100,
        }),
      ).rejects.toThrow(/not found in storage/i);
    });

    it('should reject confirm if file exceeds maxSize', async () => {
      const driver = new MultipartMemoryDriver();
      const media = createMedia({
        driver,
        processing: { enabled: false },
        fileTypes: { maxSize: 10 }, // 10 bytes
        suppressWarnings: true,
      });
      const Media = mongoose.model('Test', media.schema);
      media.init(Media);

      const presigned = await media.getSignedUploadUrl('big.txt', 'text/plain');
      // Upload a file larger than maxSize
      const bigBuf = Buffer.alloc(100, 'x');
      driver.simulateExternalUpload(presigned.key, bigBuf, 'text/plain');

      await expect(
        media.confirmUpload({
          key: presigned.key,
          filename: 'big.txt',
          mimeType: 'text/plain',
          size: bigBuf.length,
        }),
      ).rejects.toThrow(/exceeds limit/i);
    });

    it('should reject confirm if MIME type is not allowed', async () => {
      const driver = new MultipartMemoryDriver();
      const media = createMedia({
        driver,
        processing: { enabled: false },
        fileTypes: { allowed: ['image/jpeg', 'image/png'] },
        suppressWarnings: true,
      });
      const Media = mongoose.model('Test', media.schema);
      media.init(Media);

      const presigned = await media.getSignedUploadUrl('hack.exe', 'application/x-msdownload');
      driver.simulateExternalUpload(presigned.key, Buffer.from('exe'), 'application/x-msdownload');

      await expect(
        media.confirmUpload({
          key: presigned.key,
          filename: 'hack.exe',
          mimeType: 'application/x-msdownload',
          size: 3,
        }),
      ).rejects.toThrow(/not allowed/i);
    });
  });

  // =================================================================
  // 4. Presigned confirm with post-processing + cleanup
  // =================================================================

  describe('presigned with post-confirm processing', () => {
    it('should process image after confirm and delete all on cleanup', async () => {
      const driver = new MultipartMemoryDriver();
      const media = createMedia({
        driver,
        processing: {
          enabled: true,
          format: 'webp',
          maxWidth: 200,
          keepOriginal: true,
        },
        suppressWarnings: true,
      });
      const Media = mongoose.model('Test', media.schema);
      media.init(Media);

      // Upload a real image via presigned flow
      const testImage = fs.readFileSync(path.join(__dirname, 'test-img.jpg'));
      const presigned = await media.getSignedUploadUrl('photo.jpg', 'image/jpeg', {
        folder: 'photos',
      });
      driver.simulateExternalUpload(presigned.key, testImage, 'image/jpeg');

      // Confirm with process: true
      const confirmed = await media.confirmUpload({
        key: presigned.key,
        filename: 'photo.jpg',
        mimeType: 'image/jpeg',
        size: testImage.length,
        process: true,
      });

      expect(confirmed.status).toBe('ready');
      expect(confirmed.width).toBeGreaterThan(0);
      expect(confirmed.height).toBeGreaterThan(0);

      // Should have __original variant from processing
      if (confirmed.variants.length > 0) {
        const origVariant = confirmed.variants.find((v: any) => v.name === '__original');
        if (origVariant) {
          expect(await driver.exists((origVariant as any).key)).toBe(true);
        }
      }

      // Delete and verify ALL files cleaned
      const id = (confirmed as any)._id.toString();
      const allKeys = [confirmed.key, ...confirmed.variants.map((v: any) => v.key)];

      await media.delete(id);

      for (const key of allKeys) {
        expect(await driver.exists(key)).toBe(false);
      }
      expect(await media.getById(id)).toBeNull();
    });
  });

  // =================================================================
  // 5. Multipart upload — full lifecycle + cleanup
  // =================================================================

  describe('multipart upload lifecycle', () => {
    it('should initiate, upload parts, complete, then delete + cleanup', async () => {
      const driver = new MultipartMemoryDriver();
      const media = createMedia({
        driver,
        processing: { enabled: false },
        suppressWarnings: true,
      });
      const Media = mongoose.model('Test', media.schema);
      media.init(Media);

      // Step 1: Initiate
      const session = await media.initiateMultipartUpload({
        filename: 'large-file.mp4',
        contentType: 'video/mp4',
        folder: 'uploads',
      });

      expect(session.type).toBe('multipart');
      expect(session.key).toContain('uploads/');
      expect(session.uploadId).toBeDefined();

      // Step 2: Sign parts
      const part1Signed = await media.signUploadPart(session.key, session.uploadId!, 1);
      const part2Signed = await media.signUploadPart(session.key, session.uploadId!, 2);

      expect(part1Signed.partNumber).toBe(1);
      expect(part2Signed.partNumber).toBe(2);
      expect(part1Signed.uploadUrl).toContain('partNumber=1');

      // Step 3: Simulate part uploads
      const part1Data = Buffer.alloc(1024, 'A');
      const part2Data = Buffer.alloc(512, 'B');
      const etag1 = driver.simulatePartUpload(session.uploadId!, 1, part1Data);
      const etag2 = driver.simulatePartUpload(session.uploadId!, 2, part2Data);

      // Step 4: Complete
      const completed = await media.completeMultipartUpload({
        key: session.key,
        uploadId: session.uploadId!,
        parts: [
          { partNumber: 1, etag: etag1 },
          { partNumber: 2, etag: etag2 },
        ],
        filename: 'large-file.mp4',
        mimeType: 'video/mp4',
        size: part1Data.length + part2Data.length,
      });

      expect(completed.status).toBe('ready');
      expect(completed.size).toBe(1536); // 1024 + 512
      expect(completed.key).toBe(session.key);

      // Verify assembled file
      const stored = driver.getBuffer(session.key);
      expect(stored).toBeDefined();
      expect(stored!.length).toBe(1536);
      expect(stored!.subarray(0, 3).toString()).toBe('AAA');
      expect(stored!.subarray(1024, 1027).toString()).toBe('BBB');

      // Step 5: Delete and cleanup
      const id = (completed as any)._id.toString();
      await media.delete(id);

      expect(driver.size).toBe(0);
      expect(await driver.exists(session.key)).toBe(false);
    });

    it('should sign all parts upfront when partCount is provided', async () => {
      const driver = new MultipartMemoryDriver();
      const media = createMedia({
        driver,
        processing: { enabled: false },
        suppressWarnings: true,
      });
      const Media = mongoose.model('Test', media.schema);
      media.init(Media);

      const session = await media.initiateMultipartUpload({
        filename: 'big.bin',
        contentType: 'application/octet-stream',
        partCount: 3,
      });

      expect(session.parts).toBeDefined();
      expect(session.parts).toHaveLength(3);
      expect(session.parts![0]!.partNumber).toBe(1);
      expect(session.parts![1]!.partNumber).toBe(2);
      expect(session.parts![2]!.partNumber).toBe(3);
    });

    it('should sign multiple parts at once with signUploadParts', async () => {
      const driver = new MultipartMemoryDriver();
      const media = createMedia({
        driver,
        processing: { enabled: false },
        suppressWarnings: true,
      });
      const Media = mongoose.model('Test', media.schema);
      media.init(Media);

      const session = await media.initiateMultipartUpload({
        filename: 'parts.bin',
        contentType: 'application/octet-stream',
      });

      const parts = await media.signUploadParts(session.key, session.uploadId!, [1, 2, 3, 4]);

      expect(parts).toHaveLength(4);
      expect(parts[0]!.partNumber).toBe(1);
      expect(parts[3]!.partNumber).toBe(4);
    });
  });

  // =================================================================
  // 6. Multipart abort — no orphans
  // =================================================================

  describe('multipart abort', () => {
    it('should abort cleanly with no orphaned files', async () => {
      const driver = new MultipartMemoryDriver();
      const media = createMedia({
        driver,
        processing: { enabled: false },
        suppressWarnings: true,
      });
      const Media = mongoose.model('Test', media.schema);
      media.init(Media);

      const session = await media.initiateMultipartUpload({
        filename: 'aborted.bin',
        contentType: 'application/octet-stream',
        folder: 'temp',
      });

      // Upload some parts
      driver.simulatePartUpload(session.uploadId!, 1, Buffer.alloc(100, 'x'));
      driver.simulatePartUpload(session.uploadId!, 2, Buffer.alloc(100, 'y'));

      // Abort
      await media.abortMultipartUpload(session.key, session.uploadId!);

      // No files in storage
      expect(driver.size).toBe(0);
      expect(driver.activeSessionCount).toBe(0);
    });

    it('should throw when driver does not support multipart', async () => {
      const { MinimalStorageDriver } = await import('./helpers/memory-driver');
      const minimalDriver = new MinimalStorageDriver();
      const media = createMedia({
        driver: minimalDriver,
        processing: { enabled: false },
        suppressWarnings: true,
      });
      const Media = mongoose.model('Test', media.schema);
      media.init(Media);

      await expect(
        media.initiateMultipartUpload({
          filename: 'test.bin',
          contentType: 'application/octet-stream',
        }),
      ).rejects.toThrow(/does not support/i);
    });
  });

  // =================================================================
  // 7. Batch presigned URLs
  // =================================================================

  describe('batch presigned URLs', () => {
    it('should generate presigned URLs for multiple files', async () => {
      const driver = new MultipartMemoryDriver();
      const media = createMedia({
        driver,
        processing: { enabled: false },
        suppressWarnings: true,
      });
      const Media = mongoose.model('Test', media.schema);
      media.init(Media);

      const result = await media.generateBatchPutUrls({
        files: [
          { filename: 'img1.jpg', contentType: 'image/jpeg' },
          { filename: 'img2.png', contentType: 'image/png' },
          { filename: 'doc.pdf', contentType: 'application/pdf' },
        ],
        folder: 'batch',
      });

      expect(result.uploads).toHaveLength(3);
      for (const upload of result.uploads) {
        expect(upload.uploadUrl).toBeDefined();
        expect(upload.key).toContain('batch/');
        expect(upload.publicUrl).toBeDefined();
      }
    });

    it('should confirm all batch uploads and clean up all on delete', async () => {
      const driver = new MultipartMemoryDriver();
      const media = createMedia({
        driver,
        processing: { enabled: false },
        suppressWarnings: true,
      });
      const Media = mongoose.model('Test', media.schema);
      media.init(Media);

      const batch = await media.generateBatchPutUrls({
        files: [
          { filename: 'a.txt', contentType: 'text/plain' },
          { filename: 'b.txt', contentType: 'text/plain' },
        ],
        folder: 'batch',
      });

      // Simulate uploads
      const ids: string[] = [];
      for (let i = 0; i < batch.uploads.length; i++) {
        const upload = batch.uploads[i]!;
        const content = Buffer.from(`file-${i}`);
        driver.simulateExternalUpload(upload.key, content, 'text/plain');

        const confirmed = await media.confirmUpload({
          key: upload.key,
          filename: ['a.txt', 'b.txt'][i]!,
          mimeType: 'text/plain',
          size: content.length,
        });
        ids.push((confirmed as any)._id.toString());
      }

      expect(driver.size).toBe(2);

      // Delete all
      const result = await media.deleteMany(ids);
      expect(result.success).toHaveLength(2);
      expect(driver.size).toBe(0);
    });
  });

  // =================================================================
  // 8. Video upload — buffer upload + streaming read + cleanup
  // =================================================================

  describe('video upload & streaming', () => {
    let videoBuffer: Buffer;

    beforeAll(() => {
      videoBuffer = fs.readFileSync(path.join(__dirname, 'test-video.mp4'));
    });

    it('should upload video via buffer and verify storage', async () => {
      const driver = new MultipartMemoryDriver();
      const media = createMedia({
        driver,
        processing: { enabled: false },
        suppressWarnings: true,
      });
      const Media = mongoose.model('Test', media.schema);
      media.init(Media);

      const uploaded = await media.upload({
        buffer: videoBuffer,
        filename: 'Rainy_Window_City_Bokeh_Video.mp4',
        mimeType: 'video/mp4',
        folder: 'videos',
      });

      expect(uploaded.status).toBe('ready');
      expect(uploaded.mimeType).toBe('video/mp4');
      expect(uploaded.size).toBe(videoBuffer.length);
      expect(uploaded.folder).toBe('videos');
      expect(uploaded.originalFilename).toBe('Rainy_Window_City_Bokeh_Video.mp4');

      // Verify file exists in storage
      expect(await driver.exists(uploaded.key)).toBe(true);

      // Read back via stream and verify integrity
      const stream = await driver.read(uploaded.key);
      const chunks: Buffer[] = [];
      for await (const chunk of stream) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as unknown as Uint8Array));
      }
      const readBack = Buffer.concat(chunks);

      expect(readBack.length).toBe(videoBuffer.length);
      expect(readBack.equals(videoBuffer)).toBe(true);

      // Cleanup
      const id = (uploaded as any)._id.toString();
      await media.delete(id);
      expect(driver.size).toBe(0);
    });

    it('should upload video via presigned flow and stream back', async () => {
      const driver = new MultipartMemoryDriver();
      const media = createMedia({
        driver,
        processing: { enabled: false },
        suppressWarnings: true,
      });
      const Media = mongoose.model('Test', media.schema);
      media.init(Media);

      // Presign
      const presigned = await media.getSignedUploadUrl(
        'Rainy_Window_City_Bokeh_Video.mp4',
        'video/mp4',
        { folder: 'videos' },
      );

      // Simulate upload
      driver.simulateExternalUpload(presigned.key, videoBuffer, 'video/mp4');

      // Confirm
      const confirmed = await media.confirmUpload({
        key: presigned.key,
        filename: 'Rainy_Window_City_Bokeh_Video.mp4',
        mimeType: 'video/mp4',
        size: videoBuffer.length,
        hashStrategy: 'sha256',
      });

      expect(confirmed.status).toBe('ready');
      expect(confirmed.size).toBe(videoBuffer.length);

      // Verify SHA256 is real
      const expectedHash = crypto.createHash('sha256').update(videoBuffer).digest('hex');
      expect(confirmed.hash).toBe(expectedHash);

      // Stream read with range (first 1KB)
      const rangeStream = await driver.read(presigned.key, { start: 0, end: 1023 });
      const rangeChunks: Buffer[] = [];
      for await (const chunk of rangeStream) {
        rangeChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as unknown as Uint8Array));
      }
      const rangeData = Buffer.concat(rangeChunks);
      expect(rangeData.length).toBe(1024);
      expect(rangeData.equals(videoBuffer.subarray(0, 1024))).toBe(true);

      // Cleanup
      await media.delete((confirmed as any)._id.toString());
      expect(driver.size).toBe(0);
    });

    it('should upload video via multipart and verify assembled content', async () => {
      const driver = new MultipartMemoryDriver();
      const media = createMedia({
        driver,
        processing: { enabled: false },
        suppressWarnings: true,
      });
      const Media = mongoose.model('Test', media.schema);
      media.init(Media);

      // Split video into 3 chunks
      const chunkSize = Math.ceil(videoBuffer.length / 3);
      const chunks = [
        videoBuffer.subarray(0, chunkSize),
        videoBuffer.subarray(chunkSize, chunkSize * 2),
        videoBuffer.subarray(chunkSize * 2),
      ];

      // Initiate multipart
      const session = await media.initiateMultipartUpload({
        filename: 'Rainy_Window_City_Bokeh_Video.mp4',
        contentType: 'video/mp4',
        folder: 'videos',
        partCount: 3,
      });

      // Upload each part
      const completedParts: CompletedPart[] = [];
      for (let i = 0; i < chunks.length; i++) {
        const etag = driver.simulatePartUpload(session.uploadId!, i + 1, chunks[i]!);
        completedParts.push({ partNumber: i + 1, etag });
      }

      // Complete
      const completed = await media.completeMultipartUpload({
        key: session.key,
        uploadId: session.uploadId!,
        parts: completedParts,
        filename: 'Rainy_Window_City_Bokeh_Video.mp4',
        mimeType: 'video/mp4',
        size: videoBuffer.length,
      });

      expect(completed.status).toBe('ready');
      expect(completed.size).toBe(videoBuffer.length);

      // Verify assembled content matches original
      const stored = driver.getBuffer(session.key);
      expect(stored).toBeDefined();
      expect(stored!.length).toBe(videoBuffer.length);
      expect(stored!.equals(videoBuffer)).toBe(true);

      // No leaked sessions
      expect(driver.activeSessionCount).toBe(0);

      // Cleanup
      await media.delete((completed as any)._id.toString());
      expect(driver.size).toBe(0);
    });

    it('should delete video and leave zero storage footprint', async () => {
      const driver = new MultipartMemoryDriver();
      const media = createMedia({
        driver,
        processing: { enabled: false },
        suppressWarnings: true,
      });
      const Media = mongoose.model('Test', media.schema);
      media.init(Media);

      // Upload 3 videos
      const videos = [];
      for (let i = 0; i < 3; i++) {
        const v = await media.upload({
          buffer: videoBuffer,
          filename: `video-${i}.mp4`,
          mimeType: 'video/mp4',
          folder: 'videos',
        });
        videos.push(v);
      }

      expect(driver.size).toBe(3);

      // Delete all
      const ids = videos.map((v) => (v as any)._id.toString());
      const result = await media.deleteMany(ids);

      expect(result.success).toHaveLength(3);
      expect(result.failed).toHaveLength(0);
      expect(driver.size).toBe(0);
    });
  });

  // =================================================================
  // 9. Streaming read verification
  // =================================================================

  describe('streaming read', () => {
    it('should stream back uploaded file with byte-exact integrity', async () => {
      const driver = new MultipartMemoryDriver();
      const media = createMedia({
        driver,
        processing: { enabled: false },
        suppressWarnings: true,
      });
      const Media = mongoose.model('Test', media.schema);
      media.init(Media);

      // Upload a known-content buffer (use text/plain to pass MIME validation)
      const content = crypto.randomBytes(4096);
      const uploaded = await media.upload({
        buffer: content,
        filename: 'random.bin',
        mimeType: 'text/plain',
        folder: 'test',
      });

      // Stream back
      const stream = await driver.read(uploaded.key);
      const readChunks: Buffer[] = [];
      for await (const chunk of stream) {
        readChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as unknown as Uint8Array));
      }
      const readBack = Buffer.concat(readChunks);

      expect(readBack.equals(content)).toBe(true);

      // Range read — middle 100 bytes
      const rangeStream = await driver.read(uploaded.key, { start: 1000, end: 1099 });
      const rangeChunks: Buffer[] = [];
      for await (const chunk of rangeStream) {
        rangeChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as unknown as Uint8Array));
      }
      const rangeData = Buffer.concat(rangeChunks);
      expect(rangeData.length).toBe(100);
      expect(rangeData.equals(content.subarray(1000, 1100))).toBe(true);
    });

    it('should throw when reading nonexistent key', async () => {
      const driver = new MultipartMemoryDriver();

      await expect(driver.read('nonexistent/key.bin')).rejects.toThrow(/not found/i);
    });

    it('should handle read after delete gracefully', async () => {
      const driver = new MultipartMemoryDriver();
      const media = createMedia({
        driver,
        processing: { enabled: false },
        suppressWarnings: true,
      });
      const Media = mongoose.model('Test', media.schema);
      media.init(Media);

      const uploaded = await media.upload({
        buffer: Buffer.from('temporary'),
        filename: 'temp.txt',
        mimeType: 'text/plain',
        folder: 'test',
      });

      const key = uploaded.key;
      await media.delete((uploaded as any)._id.toString());

      // Reading after delete should throw
      await expect(driver.read(key)).rejects.toThrow(/not found/i);
    });
  });

  // =================================================================
  // 10. Mixed workflow: upload image + video, delete selectively
  // =================================================================

  describe('mixed media workflow', () => {
    let testImage: Buffer;
    let testVideo: Buffer;

    beforeAll(() => {
      testImage = fs.readFileSync(path.join(__dirname, 'test-img.jpg'));
      testVideo = fs.readFileSync(path.join(__dirname, 'test-video.mp4'));
    });

    it('should handle mixed image+video uploads with selective deletion', async () => {
      const driver = new MultipartMemoryDriver();
      const media = createMedia({
        driver,
        processing: {
          enabled: true,
          format: 'webp',
          maxWidth: 200,
          keepOriginal: true,
        },
        suppressWarnings: true,
      });
      const Media = mongoose.model('Test', media.schema);
      media.init(Media);

      // Upload image (will be processed with variants)
      const image = await media.upload({
        buffer: testImage,
        filename: 'photo.jpg',
        mimeType: 'image/jpeg',
        folder: 'media',
      });

      // Upload video (no processing, just stored)
      const video = await media.upload({
        buffer: testVideo,
        filename: 'clip.mp4',
        mimeType: 'video/mp4',
        folder: 'media',
      });

      const imageId = (image as any)._id.toString();
      const videoId = (video as any)._id.toString();

      // Image has variants, video doesn't
      expect(image.variants.length).toBeGreaterThanOrEqual(1);
      expect(video.variants).toEqual([]);

      const totalFiles = 1 + image.variants.length + 1; // image main + variants + video
      expect(driver.size).toBe(totalFiles);

      // Delete only the image — video should remain
      await media.delete(imageId);

      expect(await driver.exists(image.key)).toBe(false);
      for (const v of image.variants) {
        expect(await driver.exists((v as any).key)).toBe(false);
      }
      expect(await driver.exists(video.key)).toBe(true);
      expect(driver.size).toBe(1);

      // Now delete the video
      await media.delete(videoId);
      expect(driver.size).toBe(0);
    });

    it('should soft-delete video, verify streaming still works, then purge', async () => {
      const driver = new MultipartMemoryDriver();
      const media = createMedia({
        driver,
        processing: { enabled: false },
        softDelete: { enabled: true, ttlDays: 0 },
        suppressWarnings: true,
      });
      const Media = mongoose.model('Test', media.schema);
      media.init(Media);

      const video = await media.upload({
        buffer: testVideo,
        filename: 'softdel.mp4',
        mimeType: 'video/mp4',
        folder: 'videos',
      });

      const id = (video as any)._id.toString();

      // Soft delete
      await media.softDelete(id);

      // File still in storage — streaming still works
      expect(await driver.exists(video.key)).toBe(true);
      const stream = await driver.read(video.key);
      const chunks: Buffer[] = [];
      for await (const chunk of stream) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as unknown as Uint8Array));
      }
      expect(Buffer.concat(chunks).length).toBe(testVideo.length);

      // Hidden from queries
      expect(await media.getById(id)).toBeNull();

      // Purge removes from storage
      const futureDate = new Date(Date.now() + 60_000);
      await media.purgeDeleted(futureDate);

      expect(await driver.exists(video.key)).toBe(false);
      expect(driver.size).toBe(0);
    });
  });
});
