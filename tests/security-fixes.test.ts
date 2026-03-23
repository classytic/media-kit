/**
 * Security Fix Tests
 *
 * Tests for three specific security/correctness issues:
 *   1. Multipart completion must enforce fileTypes.allowed + maxSize (policy bypass)
 *   2. replace() must clean up main file on DB failure (orphan leak)
 *   3. StorageRouter must route resumable abort/status to the correct driver (misrouting)
 *
 * Requires MongoDB at localhost:27017.
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import crypto from 'crypto';
import { createMedia } from '../src/media';
import { MemoryStorageDriver } from './helpers/memory-driver';
import { StorageRouter } from '../src/providers/router';
import type {
  StorageDriver,
  WriteResult,
  SignedPartResult,
  CompletedPart,
  ResumableUploadSession,
} from '../src/types';

const MONGO_URI = 'mongodb://localhost:27017/mediakit-security-fixes-test';

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

  simulatePartUpload(uploadId: string, partNumber: number, data: Buffer): string {
    const session = this.multipartSessions.get(uploadId);
    if (!session) throw new Error(`No session: ${uploadId}`);
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

    const sortedParts = parts.sort((a, b) => a.partNumber - b.partNumber);
    const buffers: Buffer[] = [];
    for (const part of sortedParts) {
      const data = session.parts.get(part.partNumber);
      if (!data) throw new Error(`Missing part ${part.partNumber}`);
      buffers.push(data);
    }
    const assembled = Buffer.concat(buffers);
    await this.write(key, assembled, session.contentType);
    this.multipartSessions.delete(uploadId);

    const etag = `"${crypto.createHash('md5').update(assembled).digest('hex')}"`;
    return { etag, size: assembled.length };
  }

  async abortMultipartUpload(key: string, uploadId: string): Promise<void> {
    this.multipartSessions.delete(uploadId);
  }
}

// ============================================
// Resumable Memory Driver (GCS-style)
// ============================================

class ResumableMemoryDriver extends MemoryStorageDriver {
  readonly name: string;
  public abortedSessions: string[] = [];
  public statusChecks: string[] = [];

  constructor(driverName: string) {
    super();
    this.name = driverName;
  }

  async createResumableUpload(
    key: string,
    contentType: string,
    _options?: { size?: number },
  ): Promise<ResumableUploadSession> {
    const sessionId = crypto.randomUUID();
    return {
      uploadUrl: `https://${this.name}.example.com/resumable/${sessionId}`,
      key,
      publicUrl: `https://${this.name}.example.com/${key}`,
      minChunkSize: 256 * 1024,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    };
  }

  async abortResumableUpload(sessionUri: string): Promise<void> {
    this.abortedSessions.push(sessionUri);
  }

  async getResumableUploadStatus(sessionUri: string): Promise<{ uploadedBytes: number }> {
    this.statusChecks.push(sessionUri);
    return { uploadedBytes: 1024 };
  }
}

describe('Security Fixes', () => {
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

  // ============================================
  // 1. MULTIPART POLICY ENFORCEMENT
  // ============================================

  describe('multipart completion enforces upload policy', () => {
    it('should reject disallowed MIME type on multipart complete', async () => {
      const driver = new MultipartMemoryDriver();
      const media = createMedia({
        driver,
        processing: { enabled: false },
        suppressWarnings: true,
        fileTypes: { allowed: ['image/jpeg', 'image/png'] },
      });
      const Media = mongoose.model('Test', media.schema);
      media.init(Media);

      // Initiate multipart for a disallowed type
      const session = await media.initiateMultipartUpload({
        filename: 'malware.exe',
        contentType: 'application/x-msdownload',
      });

      // Simulate uploading a part
      const etag = driver.simulatePartUpload(
        (session as any).uploadId,
        1,
        Buffer.from('evil content'),
      );

      // Complete should throw — MIME type not allowed
      await expect(
        media.completeMultipartUpload({
          key: session.key,
          uploadId: (session as any).uploadId,
          parts: [{ partNumber: 1, etag }],
          filename: 'malware.exe',
          mimeType: 'application/x-msdownload',
          size: 12,
        }),
      ).rejects.toThrow(/not allowed/);
    });

    it('should reject file exceeding maxSize on multipart complete', async () => {
      const driver = new MultipartMemoryDriver();
      const media = createMedia({
        driver,
        processing: { enabled: false },
        suppressWarnings: true,
        fileTypes: { maxSize: 1024 }, // 1KB limit
      });
      const Media = mongoose.model('Test', media.schema);
      media.init(Media);

      const session = await media.initiateMultipartUpload({
        filename: 'large.txt',
        contentType: 'text/plain',
      });

      // Upload 2KB (exceeds 1KB limit)
      const bigBuffer = Buffer.alloc(2048, 'x');
      const etag = driver.simulatePartUpload(
        (session as any).uploadId,
        1,
        bigBuffer,
      );

      await expect(
        media.completeMultipartUpload({
          key: session.key,
          uploadId: (session as any).uploadId,
          parts: [{ partNumber: 1, etag }],
          filename: 'large.txt',
          mimeType: 'text/plain',
          size: 2048,
        }),
      ).rejects.toThrow(/exceeds limit/);
    });

    it('should allow valid file through multipart complete', async () => {
      const driver = new MultipartMemoryDriver();
      const media = createMedia({
        driver,
        processing: { enabled: false },
        suppressWarnings: true,
        fileTypes: { allowed: ['text/plain'], maxSize: 10240 },
      });
      const Media = mongoose.model('Test', media.schema);
      media.init(Media);

      const session = await media.initiateMultipartUpload({
        filename: 'valid.txt',
        contentType: 'text/plain',
      });

      const etag = driver.simulatePartUpload(
        (session as any).uploadId,
        1,
        Buffer.from('valid content'),
      );

      const result = await media.completeMultipartUpload({
        key: session.key,
        uploadId: (session as any).uploadId,
        parts: [{ partNumber: 1, etag }],
        filename: 'valid.txt',
        mimeType: 'text/plain',
        size: 13,
      });

      expect(result.filename).toBe('valid.txt');
      expect(result.mimeType).toBe('text/plain');
    });
  });

  // ============================================
  // 2. REPLACE ORPHAN CLEANUP
  // ============================================

  describe('replace() cleans up main file on DB failure', () => {
    it('should delete new main file from storage if DB update fails', async () => {
      const driver = new MemoryStorageDriver();
      const media = createMedia({
        driver,
        processing: { enabled: false },
        suppressWarnings: true,
      });
      const Media = mongoose.model('Test', media.schema);
      media.init(Media);

      // Upload original
      const original = await media.upload({
        buffer: Buffer.from('original content'),
        filename: 'photo.txt',
        mimeType: 'text/plain',
        folder: 'general',
      });

      const originalKey = original.key;
      expect(await driver.exists(originalKey)).toBe(true);

      // Spy on the repository to make updateMedia throw after the storage write
      const repo = (media as any).deps.repository;
      const origUpdateMedia = repo.updateMedia.bind(repo);
      let newKeyWritten: string | undefined;

      // Intercept driver.write to capture the new key
      const origWrite = driver.write.bind(driver);
      vi.spyOn(driver, 'write').mockImplementation(async (key, data, ct) => {
        newKeyWritten = key;
        return origWrite(key, data, ct);
      });

      // Make updateMedia throw to simulate DB failure
      vi.spyOn(repo, 'updateMedia').mockRejectedValueOnce(new Error('DB connection lost'));

      // replace() should throw
      await expect(
        media.replace(original._id.toString(), {
          buffer: Buffer.from('replacement content'),
          filename: 'new-photo.txt',
          mimeType: 'text/plain',
        }),
      ).rejects.toThrow('DB connection lost');

      // The new main file should have been cleaned up from storage
      expect(newKeyWritten).toBeDefined();
      expect(await driver.exists(newKeyWritten!)).toBe(false);

      // Original file should still be intact
      expect(await driver.exists(originalKey)).toBe(true);
    });
  });

  // ============================================
  // 3. STORAGE ROUTER RESUMABLE ROUTING
  // ============================================

  describe('StorageRouter routes resumable abort/status correctly', () => {
    it('should route abort to the driver that created the session, not default', async () => {
      const defaultDriver = new ResumableMemoryDriver('default-gcs');
      const altDriver = new ResumableMemoryDriver('alt-gcs');

      const router = new StorageRouter({
        drivers: {
          'default-gcs': defaultDriver,
          'alt-gcs': altDriver,
        },
        routes: [
          { prefix: 'alt/', driver: 'alt-gcs' },
        ],
        default: 'default-gcs',
      });

      // Create resumable upload on alt driver (key starts with 'alt/')
      const session = await router.createResumableUpload('alt/video.mp4', 'video/mp4');

      // Abort should go to alt driver, not default
      await router.abortResumableUpload(session.uploadUrl);

      expect(altDriver.abortedSessions).toContain(session.uploadUrl);
      expect(defaultDriver.abortedSessions).not.toContain(session.uploadUrl);
    });

    it('should route status check to the driver that created the session', async () => {
      const defaultDriver = new ResumableMemoryDriver('default-gcs');
      const altDriver = new ResumableMemoryDriver('alt-gcs');

      const router = new StorageRouter({
        drivers: {
          'default-gcs': defaultDriver,
          'alt-gcs': altDriver,
        },
        routes: [
          { prefix: 'alt/', driver: 'alt-gcs' },
        ],
        default: 'default-gcs',
      });

      const session = await router.createResumableUpload('alt/video.mp4', 'video/mp4');
      await router.getResumableUploadStatus(session.uploadUrl);

      expect(altDriver.statusChecks).toContain(session.uploadUrl);
      expect(defaultDriver.statusChecks).toHaveLength(0);
    });

    it('should fall back to default driver for unknown session URIs', async () => {
      const defaultDriver = new ResumableMemoryDriver('default-gcs');
      const altDriver = new ResumableMemoryDriver('alt-gcs');

      const router = new StorageRouter({
        drivers: {
          'default-gcs': defaultDriver,
          'alt-gcs': altDriver,
        },
        routes: [
          { prefix: 'alt/', driver: 'alt-gcs' },
        ],
        default: 'default-gcs',
      });

      // Unknown session URI → falls back to default
      await router.abortResumableUpload('https://unknown.example.com/session/123');
      expect(defaultDriver.abortedSessions).toHaveLength(1);
      expect(altDriver.abortedSessions).toHaveLength(0);
    });

    it('should route default-prefix keys to default driver correctly', async () => {
      const defaultDriver = new ResumableMemoryDriver('default-gcs');
      const altDriver = new ResumableMemoryDriver('alt-gcs');

      const router = new StorageRouter({
        drivers: {
          'default-gcs': defaultDriver,
          'alt-gcs': altDriver,
        },
        routes: [
          { prefix: 'alt/', driver: 'alt-gcs' },
        ],
        default: 'default-gcs',
      });

      // Create on default driver (no 'alt/' prefix)
      const session = await router.createResumableUpload('uploads/video.mp4', 'video/mp4');
      await router.abortResumableUpload(session.uploadUrl);

      expect(defaultDriver.abortedSessions).toContain(session.uploadUrl);
      expect(altDriver.abortedSessions).toHaveLength(0);
    });
  });
});
