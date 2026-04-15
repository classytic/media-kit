/**
 * E2E tests — full MediaEngine with real S3 driver.
 *
 * Exercises the engine end-to-end:
 *   - upload → file in S3 + doc in MongoDB
 *   - replace → new file in S3, old deleted
 *   - hardDelete → removes from S3 + DB
 *   - move → rewrites S3 keys
 *   - events → published through transport
 *
 * Gated by S3 credentials in tests/.env.
 * Uses mongodb-memory-server for DB (so tests are fully isolated from
 * any real Mongo deployment).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mongoose, { type Connection } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createMedia } from '../../src/engine/create-media.js';
import { S3Provider } from '../../src/providers/s3.provider.js';
import type { MediaEngine } from '../../src/engine/engine-types.js';
import { MEDIA_EVENTS } from '../../src/events/event-constants.js';
import { hasS3, s3Config, testKeyPrefix } from '../helpers/env.js';

const describeE2E = hasS3() ? describe : describe.skip;

describeE2E('E2E — MediaEngine with real S3 driver', () => {
  let engine: MediaEngine;
  let mongo: MongoMemoryServer;
  let connection: Connection;
  let driver: S3Provider;
  const prefix = testKeyPrefix('engine-s3');

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    connection = await mongoose.createConnection(mongo.getUri()).asPromise();

    const cfg = s3Config();
    driver = new S3Provider({
      bucket: cfg.bucket,
      region: cfg.region,
      credentials: {
        accessKeyId: cfg.accessKeyId,
        secretAccessKey: cfg.secretAccessKey,
      },
    });

    engine = await createMedia({
      connection,
      driver,
      suppressWarnings: true,
      processing: { enabled: false }, // skip Sharp for e2e speed
      folders: { defaultFolder: prefix },
    });
  }, 60_000);

  afterAll(async () => {
    // Cleanup: delete all test keys under prefix
    try {
      if (driver?.list) {
        for await (const key of driver.list(prefix)) {
          try {
            await driver.delete(key);
          } catch {
            // ignore
          }
        }
      }
    } finally {
      await engine?.dispose();
      await connection?.close();
      await mongo?.stop();
    }
  }, 60_000);

  describe('upload → S3 + MongoDB', () => {
    it('writes file to S3 and persists doc with status "ready"', async () => {
      const buffer = Buffer.from('e2e upload content', 'utf-8');
      const media = await engine.repositories.media.upload({
        buffer,
        filename: 'upload-test.txt',
        mimeType: 'text/plain',
        folder: prefix,
      });

      expect(media.status).toBe('ready');
      expect(media.key).toContain(prefix);
      expect(media.size).toBe(buffer.length);
      expect(media.url).toContain('amazonaws');
      expect(await driver.exists(media.key)).toBe(true);
    });

    it('publishes media:asset.uploaded through the transport', async () => {
      const events: any[] = [];
      await engine.events.subscribe(MEDIA_EVENTS.ASSET_UPLOADED, async (e) => {
        events.push(e);
      });

      const media = await engine.repositories.media.upload({
        buffer: Buffer.from('event test'),
        filename: 'event-test.txt',
        mimeType: 'text/plain',
        folder: prefix,
      });

      expect(events).toHaveLength(1);
      expect(events[0].payload.assetId).toBe(String(media._id));
      expect(events[0].payload.key).toBe(media.key);
    });
  });

  describe('replace → new file in S3', () => {
    it('replaces content while keeping same _id, cleans up old file', async () => {
      const original = await engine.repositories.media.upload({
        buffer: Buffer.from('original content'),
        filename: 'replace-test.txt',
        mimeType: 'text/plain',
        folder: prefix,
      });
      const originalKey = original.key;

      const replaced = await engine.repositories.media.replace(String(original._id), {
        buffer: Buffer.from('replaced content xyz'),
        filename: 'replace-test.txt',
        mimeType: 'text/plain',
        folder: prefix,
      });

      expect(String(replaced._id)).toBe(String(original._id));
      expect(replaced.size).toBe('replaced content xyz'.length);
      expect(replaced.key).not.toBe(originalKey);

      // Old file cleaned up
      expect(await driver.exists(originalKey)).toBe(false);
      // New file exists
      expect(await driver.exists(replaced.key)).toBe(true);
    });
  });

  describe('hardDelete → removes from S3 + DB', () => {
    it('removes the file from S3 and the DB', async () => {
      const media = await engine.repositories.media.upload({
        buffer: Buffer.from('delete me'),
        filename: 'delete-test.txt',
        mimeType: 'text/plain',
        folder: prefix,
      });
      const key = media.key;
      expect(await driver.exists(key)).toBe(true);

      const result = await engine.repositories.media.hardDelete(String(media._id));
      expect(result).toBe(true);
      expect(await driver.exists(key)).toBe(false);

      const found = await engine.models.Media.findById(media._id);
      expect(found).toBeNull();
    });
  });

  describe('move → rewrites S3 keys', () => {
    it('copies file to new folder prefix and deletes old', async () => {
      const media = await engine.repositories.media.upload({
        buffer: Buffer.from('move me'),
        filename: 'move-test.txt',
        mimeType: 'text/plain',
        folder: `${prefix}/source`,
      });
      const originalKey = media.key;
      const targetFolder = `${prefix}/dest`;

      const result = await engine.repositories.media.move([String(media._id)], targetFolder);
      expect(result.modifiedCount).toBe(1);

      const updated = await engine.models.Media.findById(media._id);
      expect(updated!.folder).toBe(targetFolder);
      expect(updated!.key).toContain(targetFolder);

      expect(await driver.exists(originalKey)).toBe(false);
      expect(await driver.exists(updated!.key)).toBe(true);
    });
  });

  describe('concurrent uploads', () => {
    it('handles multiple concurrent uploads without collision', async () => {
      const batch = await engine.repositories.media.uploadMany(
        Array.from({ length: 5 }, (_, i) => ({
          buffer: Buffer.from(`batch-${i}`),
          filename: `batch-${i}.txt`,
          mimeType: 'text/plain',
          folder: `${prefix}/batch`,
        })),
      );

      expect(batch).toHaveLength(5);
      for (const m of batch) {
        expect(m.status).toBe('ready');
        expect(await driver.exists(m.key)).toBe(true);
      }

      // All keys unique
      const keys = batch.map((m) => m.key);
      expect(new Set(keys).size).toBe(5);
    });
  });
});
