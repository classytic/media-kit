/**
 * StorageDriver Interface Contract Tests
 *
 * Verifies that MemoryStorageDriver (full implementation) and
 * MinimalStorageDriver (required methods only) correctly satisfy
 * the StorageDriver interface contract defined in src/types.ts.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { Readable } from 'stream';
import { MemoryStorageDriver, MinimalStorageDriver } from './helpers/memory-driver';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Consume a ReadableStream into a Buffer */
async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream as AsyncIterable<Buffer>) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

// ---------------------------------------------------------------------------
// Full driver contract (MemoryStorageDriver)
// ---------------------------------------------------------------------------

describe('StorageDriver contract — MemoryStorageDriver', () => {
  let driver: MemoryStorageDriver;

  const testKey = 'uploads/test-file.txt';
  const testContent = 'hello, storage driver!';
  const testBuffer = Buffer.from(testContent);
  const testContentType = 'text/plain';

  beforeEach(() => {
    driver = new MemoryStorageDriver();
  });

  // -----------------------------------------------------------------------
  // write()
  // -----------------------------------------------------------------------

  describe('write()', () => {
    it('should write a Buffer and return key, url, and size', async () => {
      const result = await driver.write(testKey, testBuffer, testContentType);

      expect(result.key).toBe(testKey);
      expect(result.url).toContain(testKey);
      expect(result.size).toBe(testBuffer.length);
    });

    it('should write a ReadableStream and return correct size', async () => {
      const stream = Readable.from(testBuffer);
      const result = await driver.write(testKey, stream, testContentType);

      expect(result.key).toBe(testKey);
      expect(result.url).toContain(testKey);
      expect(result.size).toBe(testBuffer.length);
    });

    it('should preserve content type in stat after write', async () => {
      const contentType = 'application/json';
      await driver.write(testKey, Buffer.from('{}'), contentType);

      const stat = await driver.stat(testKey);
      expect(stat.contentType).toBe(contentType);
    });

    it('should overwrite an existing key', async () => {
      await driver.write(testKey, Buffer.from('original'), testContentType);
      const updated = Buffer.from('overwritten content');
      const result = await driver.write(testKey, updated, testContentType);

      expect(result.size).toBe(updated.length);

      const readBack = await streamToBuffer(await driver.read(testKey));
      expect(readBack.toString()).toBe('overwritten content');
    });
  });

  // -----------------------------------------------------------------------
  // read()
  // -----------------------------------------------------------------------

  describe('read()', () => {
    it('should return correct content when consumed to buffer', async () => {
      await driver.write(testKey, testBuffer, testContentType);

      const stream = await driver.read(testKey);
      const content = await streamToBuffer(stream);

      expect(content.toString()).toBe(testContent);
    });

    it('should return partial content when byte-range is specified', async () => {
      const data = Buffer.from('0123456789');
      await driver.write(testKey, data, testContentType);

      // range is inclusive on both ends in the driver implementation
      const stream = await driver.read(testKey, { start: 2, end: 5 });
      const partial = await streamToBuffer(stream);

      expect(partial.toString()).toBe('2345');
    });

    it('should throw for a nonexistent key', async () => {
      await expect(driver.read('no-such-key')).rejects.toThrow();
    });
  });

  // -----------------------------------------------------------------------
  // delete()
  // -----------------------------------------------------------------------

  describe('delete()', () => {
    it('should return true when deleting an existing key', async () => {
      await driver.write(testKey, testBuffer, testContentType);
      const result = await driver.delete(testKey);

      expect(result).toBe(true);
    });

    it('should return false when deleting a nonexistent key', async () => {
      const result = await driver.delete('nonexistent');

      expect(result).toBe(false);
    });

    it('should make the file no longer exist after deletion', async () => {
      await driver.write(testKey, testBuffer, testContentType);
      await driver.delete(testKey);

      const stillExists = await driver.exists(testKey);
      expect(stillExists).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // exists()
  // -----------------------------------------------------------------------

  describe('exists()', () => {
    it('should return true for an existing key', async () => {
      await driver.write(testKey, testBuffer, testContentType);

      expect(await driver.exists(testKey)).toBe(true);
    });

    it('should return false for a nonexistent key', async () => {
      expect(await driver.exists('does-not-exist')).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // stat()
  // -----------------------------------------------------------------------

  describe('stat()', () => {
    it('should return correct size and contentType', async () => {
      await driver.write(testKey, testBuffer, testContentType);

      const stat = await driver.stat(testKey);
      expect(stat.size).toBe(testBuffer.length);
      expect(stat.contentType).toBe(testContentType);
    });

    it('should include lastModified as a Date', async () => {
      await driver.write(testKey, testBuffer, testContentType);

      const stat = await driver.stat(testKey);
      expect(stat.lastModified).toBeInstanceOf(Date);
    });

    it('should include an etag string', async () => {
      await driver.write(testKey, testBuffer, testContentType);

      const stat = await driver.stat(testKey);
      expect(stat.etag).toBeDefined();
      expect(typeof stat.etag).toBe('string');
      expect(stat.etag!.length).toBeGreaterThan(0);
    });

    it('should throw for a nonexistent key', async () => {
      await expect(driver.stat('missing-key')).rejects.toThrow();
    });
  });

  // -----------------------------------------------------------------------
  // getPublicUrl()
  // -----------------------------------------------------------------------

  describe('getPublicUrl()', () => {
    it('should return a deterministic URL containing the key', () => {
      const url1 = driver.getPublicUrl('my/file.png');
      const url2 = driver.getPublicUrl('my/file.png');

      expect(url1).toBe(url2);
      expect(url1).toContain('my/file.png');
    });

    it('should return different URLs for different keys', () => {
      const url1 = driver.getPublicUrl('a.png');
      const url2 = driver.getPublicUrl('b.png');

      expect(url1).not.toBe(url2);
    });
  });

  // -----------------------------------------------------------------------
  // list() (optional)
  // -----------------------------------------------------------------------

  describe('list()', () => {
    it('should list files matching the given prefix', async () => {
      await driver.write('images/a.png', Buffer.from('a'), 'image/png');
      await driver.write('images/b.png', Buffer.from('b'), 'image/png');
      await driver.write('docs/readme.md', Buffer.from('c'), 'text/markdown');

      const keys: string[] = [];
      for await (const key of driver.list('images/')) {
        keys.push(key);
      }

      expect(keys).toHaveLength(2);
      expect(keys).toContain('images/a.png');
      expect(keys).toContain('images/b.png');
    });

    it('should return empty result for nonexistent prefix', async () => {
      await driver.write('images/a.png', Buffer.from('a'), 'image/png');

      const keys: string[] = [];
      for await (const key of driver.list('videos/')) {
        keys.push(key);
      }

      expect(keys).toHaveLength(0);
    });

    it('should work as an async iterable with for-await', async () => {
      await driver.write('pfx/1.txt', Buffer.from('1'), 'text/plain');
      await driver.write('pfx/2.txt', Buffer.from('2'), 'text/plain');
      await driver.write('pfx/3.txt', Buffer.from('3'), 'text/plain');

      const collected: string[] = [];
      const iterable = driver.list('pfx/');
      for await (const key of iterable) {
        collected.push(key);
      }

      expect(collected).toHaveLength(3);
    });
  });

  // -----------------------------------------------------------------------
  // copy() (optional)
  // -----------------------------------------------------------------------

  describe('copy()', () => {
    it('should create a copy at the destination key', async () => {
      await driver.write(testKey, testBuffer, testContentType);

      const result = await driver.copy!(testKey, 'copies/test-file.txt');

      expect(result.key).toBe('copies/test-file.txt');
      expect(result.size).toBe(testBuffer.length);
      expect(await driver.exists('copies/test-file.txt')).toBe(true);
    });

    it('should keep the source file after copy', async () => {
      await driver.write(testKey, testBuffer, testContentType);
      await driver.copy!(testKey, 'copies/test-file.txt');

      expect(await driver.exists(testKey)).toBe(true);
    });

    it('should produce identical content at the destination', async () => {
      await driver.write(testKey, testBuffer, testContentType);
      await driver.copy!(testKey, 'copies/test-file.txt');

      const sourceData = await streamToBuffer(await driver.read(testKey));
      const destData = await streamToBuffer(await driver.read('copies/test-file.txt'));

      expect(destData).toEqual(sourceData);
    });
  });

  // -----------------------------------------------------------------------
  // move() (optional)
  // -----------------------------------------------------------------------

  describe('move()', () => {
    it('should place the file at the destination', async () => {
      await driver.write(testKey, testBuffer, testContentType);

      const result = await driver.move!(testKey, 'moved/file.txt');

      expect(result.key).toBe('moved/file.txt');
      expect(await driver.exists('moved/file.txt')).toBe(true);
    });

    it('should remove the source file after move', async () => {
      await driver.write(testKey, testBuffer, testContentType);
      await driver.move!(testKey, 'moved/file.txt');

      expect(await driver.exists(testKey)).toBe(false);
    });

    it('should preserve content after move', async () => {
      await driver.write(testKey, testBuffer, testContentType);
      await driver.move!(testKey, 'moved/file.txt');

      const data = await streamToBuffer(await driver.read('moved/file.txt'));
      expect(data.toString()).toBe(testContent);
    });
  });

  // -----------------------------------------------------------------------
  // getSignedUrl() (optional)
  // -----------------------------------------------------------------------

  describe('getSignedUrl()', () => {
    it('should return a URL string containing the key', async () => {
      const url = await driver.getSignedUrl!(testKey);

      expect(typeof url).toBe('string');
      expect(url).toContain(testKey);
    });

    it('should accept a custom expiresIn parameter', async () => {
      const url = await driver.getSignedUrl!(testKey, 7200);

      expect(url).toContain('7200');
    });
  });

  // -----------------------------------------------------------------------
  // getSignedUploadUrl() (optional)
  // -----------------------------------------------------------------------

  describe('getSignedUploadUrl()', () => {
    it('should return a PresignedUploadResult with required fields', async () => {
      const result = await driver.getSignedUploadUrl!(testKey, 'image/jpeg', 1800);

      expect(result.uploadUrl).toBeDefined();
      expect(result.key).toBe(testKey);
      expect(result.publicUrl).toContain(testKey);
      expect(result.expiresIn).toBe(1800);
    });

    it('should include headers with content type', async () => {
      const result = await driver.getSignedUploadUrl!(testKey, 'image/png');

      expect(result.headers).toBeDefined();
      expect(result.headers!['Content-Type']).toBe('image/png');
    });
  });
});

// ---------------------------------------------------------------------------
// MinimalStorageDriver — required methods only, no optional methods
// ---------------------------------------------------------------------------

describe('StorageDriver contract — MinimalStorageDriver', () => {
  let driver: MinimalStorageDriver;

  const testKey = 'uploads/minimal-test.txt';
  const testContent = 'minimal driver test';
  const testBuffer = Buffer.from(testContent);
  const testContentType = 'text/plain';

  beforeEach(() => {
    driver = new MinimalStorageDriver();
  });

  // -----------------------------------------------------------------------
  // Required methods all work
  // -----------------------------------------------------------------------

  describe('required methods', () => {
    it('should write and read back data correctly', async () => {
      const writeResult = await driver.write(testKey, testBuffer, testContentType);
      expect(writeResult.key).toBe(testKey);
      expect(writeResult.size).toBe(testBuffer.length);

      const stream = await driver.read(testKey);
      const readBack = await streamToBuffer(stream);
      expect(readBack.toString()).toBe(testContent);
    });

    it('should write from a ReadableStream', async () => {
      const stream = Readable.from(testBuffer);
      const result = await driver.write(testKey, stream, testContentType);

      expect(result.size).toBe(testBuffer.length);
    });

    it('should report exists correctly', async () => {
      expect(await driver.exists(testKey)).toBe(false);

      await driver.write(testKey, testBuffer, testContentType);
      expect(await driver.exists(testKey)).toBe(true);
    });

    it('should delete and return correct boolean', async () => {
      await driver.write(testKey, testBuffer, testContentType);

      expect(await driver.delete(testKey)).toBe(true);
      expect(await driver.delete(testKey)).toBe(false);
      expect(await driver.exists(testKey)).toBe(false);
    });

    it('should return stat with size and contentType', async () => {
      await driver.write(testKey, testBuffer, testContentType);

      const stat = await driver.stat(testKey);
      expect(stat.size).toBe(testBuffer.length);
      expect(stat.contentType).toBe(testContentType);
    });

    it('should throw on stat for nonexistent key', async () => {
      await expect(driver.stat('nope')).rejects.toThrow();
    });

    it('should throw on read for nonexistent key', async () => {
      await expect(driver.read('nope')).rejects.toThrow();
    });

    it('should return a public URL containing the key', () => {
      const url = driver.getPublicUrl(testKey);

      expect(typeof url).toBe('string');
      expect(url).toContain(testKey);
    });
  });

  // -----------------------------------------------------------------------
  // Optional methods are undefined
  // -----------------------------------------------------------------------

  describe('optional methods are undefined', () => {
    it('should not have list()', () => {
      expect((driver as any).list).toBeUndefined();
    });

    it('should not have copy()', () => {
      expect((driver as any).copy).toBeUndefined();
    });

    it('should not have move()', () => {
      expect((driver as any).move).toBeUndefined();
    });

    it('should not have getSignedUrl()', () => {
      expect((driver as any).getSignedUrl).toBeUndefined();
    });

    it('should not have getSignedUploadUrl()', () => {
      expect((driver as any).getSignedUploadUrl).toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // Runtime feature detection
  // -----------------------------------------------------------------------

  describe('runtime feature detection', () => {
    it('should detect listing capability via typeof check', () => {
      const hasListing = typeof (driver as any).list === 'function';
      expect(hasListing).toBe(false);
    });

    it('should detect copy capability via typeof check', () => {
      const hasCopy = typeof (driver as any).copy === 'function';
      expect(hasCopy).toBe(false);
    });

    it('should detect move capability via typeof check', () => {
      const hasMove = typeof (driver as any).move === 'function';
      expect(hasMove).toBe(false);
    });

    it('should detect signed URL capability via typeof check', () => {
      const hasSigned = typeof (driver as any).getSignedUrl === 'function';
      expect(hasSigned).toBe(false);
    });

    it('should detect presigned upload capability via typeof check', () => {
      const hasPresigned = typeof (driver as any).getSignedUploadUrl === 'function';
      expect(hasPresigned).toBe(false);
    });

    it('should confirm MemoryStorageDriver passes all feature detections', () => {
      const full = new MemoryStorageDriver();

      expect(typeof full.list).toBe('function');
      expect(typeof full.copy).toBe('function');
      expect(typeof full.move).toBe('function');
      expect(typeof full.getSignedUrl).toBe('function');
      expect(typeof full.getSignedUploadUrl).toBe('function');
    });
  });
});
