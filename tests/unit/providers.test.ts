/**
 * StorageDriver Interface Tests
 *
 * Tests the StorageDriver interface with in-memory implementations.
 * Uses MemoryStorageDriver (full) and MinimalStorageDriver (required-only).
 */

import { Readable } from 'node:stream';
import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryStorageDriver, MinimalStorageDriver } from '../helpers/memory-driver';
import type { StorageDriver } from '../../src/types';

/** Consume a readable stream into a string. */
function streamToString(stream: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    stream.on('error', reject);
  });
}

/** Consume a readable stream into a Buffer. */
function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

describe('StorageDriver — full implementation', () => {
  let driver: MemoryStorageDriver;

  beforeEach(() => {
    driver = new MemoryStorageDriver();
  });

  // --- write ---

  describe('write()', () => {
    it('should write a Buffer and return WriteResult', async () => {
      const data = Buffer.from('hello world');
      const result = await driver.write('uploads/test.txt', data, 'text/plain');

      expect(result.key).toBe('uploads/test.txt');
      expect(result.url).toContain('uploads/test.txt');
      expect(result.size).toBe(data.length);
    });

    it('should write a ReadableStream', async () => {
      const data = Buffer.from('stream content');
      const stream = Readable.from(data);
      const result = await driver.write('uploads/stream.txt', stream, 'text/plain');

      expect(result.size).toBe(data.length);

      // Verify content
      const readStream = await driver.read('uploads/stream.txt');
      const content = await streamToString(readStream);
      expect(content).toBe('stream content');
    });

    it('should overwrite existing key', async () => {
      await driver.write('uploads/dup.txt', Buffer.from('first'), 'text/plain');
      await driver.write('uploads/dup.txt', Buffer.from('second'), 'text/plain');

      const stream = await driver.read('uploads/dup.txt');
      const content = await streamToString(stream);
      expect(content).toBe('second');
    });
  });

  // --- read ---

  describe('read()', () => {
    it('should return a readable stream with correct content', async () => {
      const content = 'read test content';
      await driver.write('uploads/read.txt', Buffer.from(content), 'text/plain');

      const stream = await driver.read('uploads/read.txt');
      const body = await streamToString(stream);
      expect(body).toBe(content);
    });

    it('should support byte-range reads', async () => {
      const content = 'Hello, World!';
      await driver.write('uploads/range.txt', Buffer.from(content), 'text/plain');

      const stream = await driver.read('uploads/range.txt', { start: 0, end: 4 });
      const body = await streamToString(stream);
      expect(body).toBe('Hello');
    });

    it('should throw for nonexistent key', async () => {
      await expect(driver.read('nonexistent/key.txt')).rejects.toThrow(/not found/i);
    });

    it('should handle binary content correctly', async () => {
      const binaryContent = Buffer.from([0x00, 0x01, 0xff, 0xfe, 0x80]);
      await driver.write('uploads/binary.bin', binaryContent, 'application/octet-stream');

      const stream = await driver.read('uploads/binary.bin');
      const result = await streamToBuffer(stream);
      expect(result).toEqual(binaryContent);
    });
  });

  // --- delete ---

  describe('delete()', () => {
    it('should return true for existing key', async () => {
      await driver.write('uploads/del.txt', Buffer.from('data'), 'text/plain');
      expect(await driver.delete('uploads/del.txt')).toBe(true);
    });

    it('should return false for nonexistent key', async () => {
      expect(await driver.delete('nonexistent')).toBe(false);
    });

    it('should make file not exist after delete', async () => {
      await driver.write('uploads/gone.txt', Buffer.from('data'), 'text/plain');
      await driver.delete('uploads/gone.txt');
      expect(await driver.exists('uploads/gone.txt')).toBe(false);
    });
  });

  // --- exists ---

  describe('exists()', () => {
    it('should return true for existing key', async () => {
      await driver.write('uploads/exists.txt', Buffer.from('data'), 'text/plain');
      expect(await driver.exists('uploads/exists.txt')).toBe(true);
    });

    it('should return false for nonexistent key', async () => {
      expect(await driver.exists('nonexistent')).toBe(false);
    });
  });

  // --- stat ---

  describe('stat()', () => {
    it('should return correct size and contentType', async () => {
      const content = 'stat test';
      await driver.write('uploads/stat.txt', Buffer.from(content), 'text/plain');

      const stat = await driver.stat('uploads/stat.txt');
      expect(stat.size).toBe(content.length);
      expect(stat.contentType).toBe('text/plain');
    });

    it('should include lastModified and etag', async () => {
      await driver.write('uploads/meta.txt', Buffer.from('meta'), 'text/plain');
      const stat = await driver.stat('uploads/meta.txt');

      expect(stat.lastModified).toBeInstanceOf(Date);
      expect(stat.etag).toBeDefined();
      expect(typeof stat.etag).toBe('string');
    });

    it('should throw for nonexistent key', async () => {
      await expect(driver.stat('missing/file.txt')).rejects.toThrow(/not found/i);
    });
  });

  // --- getPublicUrl ---

  describe('getPublicUrl()', () => {
    it('should return a URL containing the key', () => {
      const url = driver.getPublicUrl('uploads/photo.jpg');
      expect(url).toContain('uploads/photo.jpg');
    });
  });

  // --- list (optional) ---

  describe('list()', () => {
    it('should list files matching prefix', async () => {
      await driver.write('images/a.jpg', Buffer.from('a'), 'image/jpeg');
      await driver.write('images/b.jpg', Buffer.from('b'), 'image/jpeg');
      await driver.write('docs/c.pdf', Buffer.from('c'), 'application/pdf');

      const keys: string[] = [];
      for await (const key of driver.list!('images/')) {
        keys.push(key);
      }

      expect(keys).toHaveLength(2);
      expect(keys).toContain('images/a.jpg');
      expect(keys).toContain('images/b.jpg');
    });

    it('should return empty for nonexistent prefix', async () => {
      const keys: string[] = [];
      for await (const key of driver.list!('nonexistent/')) {
        keys.push(key);
      }
      expect(keys).toHaveLength(0);
    });
  });

  // --- copy (optional) ---

  describe('copy()', () => {
    it('should create a copy at the destination', async () => {
      await driver.write('src/file.txt', Buffer.from('copy me'), 'text/plain');
      const result = await driver.copy!('src/file.txt', 'dst/file.txt');

      expect(result.key).toBe('dst/file.txt');
      expect(result.url).toContain('dst/file.txt');
    });

    it('should keep both source and destination', async () => {
      await driver.write('src/keep.txt', Buffer.from('keep'), 'text/plain');
      await driver.copy!('src/keep.txt', 'dst/keep.txt');

      expect(await driver.exists('src/keep.txt')).toBe(true);
      expect(await driver.exists('dst/keep.txt')).toBe(true);
    });

    it('should copy content accurately', async () => {
      const content = 'verify copy';
      await driver.write('src/acc.txt', Buffer.from(content), 'text/plain');
      await driver.copy!('src/acc.txt', 'dst/acc.txt');

      const stream = await driver.read('dst/acc.txt');
      const body = await streamToString(stream);
      expect(body).toBe(content);
    });

    it('should throw for nonexistent source', async () => {
      await expect(driver.copy!('nope', 'dst')).rejects.toThrow(/not found/i);
    });
  });

  // --- move (optional) ---

  describe('move()', () => {
    it('should move file to new location', async () => {
      await driver.write('old/file.txt', Buffer.from('move me'), 'text/plain');
      const result = await driver.move!('old/file.txt', 'new/file.txt');

      expect(result.key).toBe('new/file.txt');
      expect(await driver.exists('new/file.txt')).toBe(true);
      expect(await driver.exists('old/file.txt')).toBe(false);
    });
  });

  // --- getSignedUploadUrl (optional) ---

  describe('getSignedUploadUrl()', () => {
    it('should return a PresignedUploadResult', async () => {
      const result = await driver.getSignedUploadUrl!(
        'uploads/photo.jpg',
        'image/jpeg',
      );

      expect(result).toMatchObject({
        uploadUrl: expect.any(String),
        key: 'uploads/photo.jpg',
        publicUrl: expect.any(String),
        expiresIn: expect.any(Number),
      });
    });
  });
});

// --- MinimalStorageDriver ---

describe('StorageDriver — minimal (required methods only)', () => {
  let driver: MinimalStorageDriver;

  beforeEach(() => {
    driver = new MinimalStorageDriver();
  });

  it('should perform basic write/read/delete flow', async () => {
    const data = Buffer.from('minimal test');
    const result = await driver.write('test.txt', data, 'text/plain');
    expect(result.key).toBe('test.txt');
    expect(result.size).toBe(data.length);

    // Read back
    const stream = await driver.read('test.txt');
    const content = await streamToString(stream);
    expect(content).toBe('minimal test');

    // Delete
    expect(await driver.delete('test.txt')).toBe(true);
    expect(await driver.exists('test.txt')).toBe(false);
  });

  it('should have optional methods as undefined', () => {
    const asDriver: StorageDriver = driver;

    expect(asDriver.list).toBeUndefined();
    expect(asDriver.copy).toBeUndefined();
    expect(asDriver.move).toBeUndefined();
    expect(asDriver.getSignedUrl).toBeUndefined();
    expect(asDriver.getSignedUploadUrl).toBeUndefined();
  });

  it('should allow runtime feature detection', () => {
    const full: StorageDriver = new MemoryStorageDriver();
    const minimal: StorageDriver = driver;

    expect(typeof full.list).toBe('function');
    expect(typeof full.copy).toBe('function');
    expect(typeof full.move).toBe('function');
    expect(typeof full.getSignedUploadUrl).toBe('function');

    expect(typeof minimal.list).toBe('undefined');
    expect(typeof minimal.copy).toBe('undefined');
    expect(typeof minimal.move).toBe('undefined');
    expect(typeof minimal.getSignedUploadUrl).toBe('undefined');
  });
});
