/**
 * In-Memory Storage Driver for tests
 *
 * Implements the full StorageDriver interface including
 * all optional methods. Used across all test files.
 */

import crypto from 'crypto';
import { Readable } from 'stream';
import type { StorageDriver, WriteResult, FileStat, PresignedUploadResult } from '../../src/types';

export class MemoryStorageDriver implements StorageDriver {
  readonly name = 'memory';
  private storage = new Map<string, { buffer: Buffer; contentType: string; modified: Date }>();

  async write(key: string, data: Buffer | NodeJS.ReadableStream, contentType: string): Promise<WriteResult> {
    let buffer: Buffer;
    if (Buffer.isBuffer(data)) {
      buffer = data;
    } else {
      const chunks: Buffer[] = [];
      for await (const chunk of data as AsyncIterable<Buffer>) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      buffer = Buffer.concat(chunks);
    }

    this.storage.set(key, { buffer, contentType, modified: new Date() });

    return {
      key,
      url: `https://cdn.example.com/${key}`,
      size: buffer.length,
    };
  }

  async read(key: string, range?: { start: number; end: number }): Promise<NodeJS.ReadableStream> {
    const entry = this.storage.get(key);
    if (!entry) throw new Error(`File not found: ${key}`);

    if (range) {
      return Readable.from(entry.buffer.subarray(range.start, range.end + 1));
    }
    return Readable.from(entry.buffer);
  }

  async delete(key: string): Promise<boolean> {
    return this.storage.delete(key);
  }

  async exists(key: string): Promise<boolean> {
    return this.storage.has(key);
  }

  async stat(key: string): Promise<FileStat> {
    const entry = this.storage.get(key);
    if (!entry) throw new Error(`File not found: ${key}`);
    return {
      size: entry.buffer.length,
      contentType: entry.contentType,
      lastModified: entry.modified,
      etag: `"${crypto.createHash('md5').update(entry.buffer).digest('hex')}"`,
    };
  }

  async *list(prefix: string): AsyncIterable<string> {
    for (const key of this.storage.keys()) {
      if (key.startsWith(prefix)) yield key;
    }
  }

  async copy(source: string, destination: string): Promise<WriteResult> {
    const entry = this.storage.get(source);
    if (!entry) throw new Error(`Source not found: ${source}`);
    this.storage.set(destination, {
      buffer: Buffer.from(entry.buffer),
      contentType: entry.contentType,
      modified: new Date(),
    });
    return {
      key: destination,
      url: `https://cdn.example.com/${destination}`,
      size: entry.buffer.length,
    };
  }

  async move(source: string, destination: string): Promise<WriteResult> {
    const result = await this.copy(source, destination);
    this.storage.delete(source);
    return result;
  }

  getPublicUrl(key: string): string {
    return `https://cdn.example.com/${key}`;
  }

  async getSignedUrl(key: string, expiresIn = 3600): Promise<string> {
    return `https://cdn.example.com/${key}?sig=mock&exp=${expiresIn}`;
  }

  async getSignedUploadUrl(key: string, contentType: string, expiresIn = 3600): Promise<PresignedUploadResult> {
    return {
      uploadUrl: `https://cdn.example.com/_upload/${key}?ct=${encodeURIComponent(contentType)}&exp=${expiresIn}`,
      key,
      publicUrl: `https://cdn.example.com/${key}`,
      expiresIn,
      headers: { 'Content-Type': contentType },
    };
  }

  /** Simulate an external upload (for presigned flow tests) */
  simulateExternalUpload(key: string, buffer: Buffer, contentType: string): void {
    this.storage.set(key, { buffer, contentType, modified: new Date() });
  }

  /** Get raw buffer for assertions */
  getBuffer(key: string): Buffer | undefined {
    return this.storage.get(key)?.buffer;
  }

  /** Clear all stored files */
  clear(): void {
    this.storage.clear();
  }

  /** Get count of stored files */
  get size(): number {
    return this.storage.size;
  }
}

/**
 * Minimal driver with only required methods (no optional methods).
 * Used to test graceful degradation when optional methods are unavailable.
 */
export class MinimalStorageDriver implements StorageDriver {
  readonly name = 'minimal';
  private storage = new Map<string, { buffer: Buffer; contentType: string }>();

  async write(key: string, data: Buffer | NodeJS.ReadableStream, contentType: string): Promise<WriteResult> {
    let buffer: Buffer;
    if (Buffer.isBuffer(data)) {
      buffer = data;
    } else {
      const chunks: Buffer[] = [];
      for await (const chunk of data as AsyncIterable<Buffer>) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      buffer = Buffer.concat(chunks);
    }
    this.storage.set(key, { buffer, contentType });
    return { key, url: `https://cdn.example.com/${key}`, size: buffer.length };
  }

  async read(key: string): Promise<NodeJS.ReadableStream> {
    const entry = this.storage.get(key);
    if (!entry) throw new Error(`File not found: ${key}`);
    return Readable.from(entry.buffer);
  }

  async delete(key: string): Promise<boolean> {
    return this.storage.delete(key);
  }

  async exists(key: string): Promise<boolean> {
    return this.storage.has(key);
  }

  async stat(key: string): Promise<FileStat> {
    const entry = this.storage.get(key);
    if (!entry) throw new Error(`File not found: ${key}`);
    return { size: entry.buffer.length, contentType: entry.contentType };
  }

  getPublicUrl(key: string): string {
    return `https://cdn.example.com/${key}`;
  }
}
