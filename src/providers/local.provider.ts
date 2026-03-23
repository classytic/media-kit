/**
 * Local Filesystem Storage Driver
 *
 * Implements the StorageDriver interface using Node.js built-in
 * `fs` and `path` modules. Zero external dependencies.
 *
 * Ideal for development, testing, self-hosted deployments, or
 * hybrid setups via StorageRouter (local + cloud).
 *
 * @example
 * ```ts
 * import { LocalProvider } from '@classytic/media-kit/providers/local';
 *
 * const local = new LocalProvider({
 *   basePath: './uploads',
 *   baseUrl: 'http://localhost:3000/uploads',
 * });
 * ```
 */

import { createReadStream, createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { StorageDriver, WriteResult, FileStat, PresignedUploadResult } from '../types';
import { getMimeType } from '../utils/mime';

/**
 * Local Provider Configuration
 */
export interface LocalProviderConfig {
  /** Root directory for file storage (absolute or relative to cwd) */
  basePath: string;
  /** Public URL prefix for serving files (e.g., 'http://localhost:3000/uploads' or '/uploads') */
  baseUrl: string;
}

/**
 * Local Filesystem Storage Driver
 */
export class LocalProvider implements StorageDriver {
  readonly name = 'local';
  private basePath: string;
  private baseUrl: string;

  constructor(config: LocalProviderConfig) {
    this.basePath = path.resolve(config.basePath);
    this.baseUrl = config.baseUrl.replace(/\/+$/, ''); // strip trailing slash
  }

  /**
   * Resolve a storage key to an absolute filesystem path
   */
  private resolvePath(key: string): string {
    const resolved = path.resolve(this.basePath, key);
    // Prevent directory traversal — use basePath + sep to avoid sibling-prefix bypass
    // e.g. basePath="/uploads" must not allow "/uploads2/evil.txt"
    if (resolved !== this.basePath && !resolved.startsWith(this.basePath + path.sep)) {
      throw new Error(`Invalid key: path traversal detected for key '${key}'`);
    }
    return resolved;
  }

  /**
   * Write data to the local filesystem.
   * Creates parent directories automatically.
   */
  async write(key: string, data: Buffer | NodeJS.ReadableStream, contentType: string): Promise<WriteResult> {
    const filePath = this.resolvePath(key);
    const dir = path.dirname(filePath);

    // Ensure parent directory exists
    await fs.mkdir(dir, { recursive: true });

    if (Buffer.isBuffer(data)) {
      await fs.writeFile(filePath, data);
      return {
        key,
        url: this.getPublicUrl(key),
        size: data.length,
      };
    }

    // Stream write
    const writeStream = createWriteStream(filePath);
    await pipeline(data, writeStream);

    const stat = await fs.stat(filePath);
    return {
      key,
      url: this.getPublicUrl(key),
      size: stat.size,
    };
  }

  /**
   * Read a file as a stream. Supports optional byte-range for partial reads.
   */
  async read(key: string, range?: { start: number; end: number }): Promise<NodeJS.ReadableStream> {
    const filePath = this.resolvePath(key);

    // Verify file exists before creating stream
    await fs.access(filePath);

    const options = range ? { start: range.start, end: range.end } : undefined;
    return createReadStream(filePath, options);
  }

  /**
   * Delete a file from the filesystem.
   * Returns true even if the file was already gone.
   */
  async delete(key: string): Promise<boolean> {
    const filePath = this.resolvePath(key);

    try {
      await fs.unlink(filePath);
    } catch (err: unknown) {
      // File already gone — not an error
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return true;
      }
      throw err;
    }

    return true;
  }

  /**
   * Check if a file exists
   */
  async exists(key: string): Promise<boolean> {
    const filePath = this.resolvePath(key);

    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get file metadata without reading the file
   */
  async stat(key: string): Promise<FileStat> {
    const filePath = this.resolvePath(key);
    const stat = await fs.stat(filePath);

    return {
      size: stat.size,
      contentType: getMimeType(key),
      lastModified: stat.mtime,
    };
  }

  /**
   * List files under a prefix (async generator for memory efficiency).
   * Yields storage keys relative to basePath.
   */
  async *list(prefix: string): AsyncIterable<string> {
    const dirPath = this.resolvePath(prefix);

    let entries: string[];
    try {
      entries = await fs.readdir(dirPath, { recursive: true }) as string[];
    } catch (err: unknown) {
      // Directory doesn't exist — no files to list
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return;
      }
      throw err;
    }

    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry);
      const stat = await fs.stat(fullPath).catch(() => null);
      if (stat?.isFile()) {
        // Yield key relative to basePath, using forward slashes
        const key = path.relative(this.basePath, fullPath).replace(/\\/g, '/');
        yield key;
      }
    }
  }

  /**
   * Copy a file to a new location
   */
  async copy(source: string, destination: string): Promise<WriteResult> {
    const srcPath = this.resolvePath(source);
    const dstPath = this.resolvePath(destination);

    // Ensure destination directory exists
    await fs.mkdir(path.dirname(dstPath), { recursive: true });

    await fs.copyFile(srcPath, dstPath);

    const stat = await fs.stat(dstPath);
    return {
      key: destination,
      url: this.getPublicUrl(destination),
      size: stat.size,
    };
  }

  /**
   * Move a file to a new location.
   * Uses rename (fast on same filesystem), with copy+delete fallback for cross-device moves.
   */
  async move(source: string, destination: string): Promise<WriteResult> {
    const srcPath = this.resolvePath(source);
    const dstPath = this.resolvePath(destination);

    // Ensure destination directory exists
    await fs.mkdir(path.dirname(dstPath), { recursive: true });

    try {
      await fs.rename(srcPath, dstPath);
    } catch (err: unknown) {
      // EXDEV = cross-device link — fallback to copy+delete
      if ((err as NodeJS.ErrnoException).code === 'EXDEV') {
        await fs.copyFile(srcPath, dstPath);
        await fs.unlink(srcPath);
      } else {
        throw err;
      }
    }

    const stat = await fs.stat(dstPath);
    return {
      key: destination,
      url: this.getPublicUrl(destination),
      size: stat.size,
    };
  }

  /**
   * Build the public URL for a storage key
   */
  getPublicUrl(key: string): string {
    // Ensure forward slashes in URL
    const normalizedKey = key.replace(/\\/g, '/');
    return `${this.baseUrl}/${normalizedKey}`;
  }

  /**
   * Extract storage key from URL or key.
   * Handles full URLs (matching baseUrl) and plain keys.
   */
  private extractKey(keyOrUrl: string): string {
    if (keyOrUrl.startsWith(this.baseUrl)) {
      return keyOrUrl.slice(this.baseUrl.length + 1); // +1 for the slash
    }
    return keyOrUrl;
  }
}

export default LocalProvider;
