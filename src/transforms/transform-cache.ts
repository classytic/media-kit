/**
 * Storage-backed Transform Cache
 *
 * Default TransformCache implementation that stores transformed images
 * in the same storage driver under a `__transforms/` prefix.
 *
 * @example
 * ```ts
 * import { StorageTransformCache } from '@classytic/media-kit/transforms';
 *
 * const cache = new StorageTransformCache(driver, { prefix: '__transforms' });
 * const transform = createAssetTransform({ media, cache });
 * ```
 */

import type { StorageDriver, TransformCache } from '../types';

export interface StorageTransformCacheConfig {
  /** Key prefix for cached transforms (default: '__transforms') */
  prefix?: string;
}

/**
 * Transform cache that stores results in the storage driver
 */
export class StorageTransformCache implements TransformCache {
  private driver: StorageDriver;
  private prefix: string;

  constructor(driver: StorageDriver, config: StorageTransformCacheConfig = {}) {
    this.driver = driver;
    this.prefix = config.prefix || '__transforms';
  }

  async get(cacheKey: string): Promise<{ stream: NodeJS.ReadableStream; contentType: string } | null> {
    const key = `${this.prefix}/${cacheKey}`;

    try {
      const exists = await this.driver.exists(key);
      if (!exists) return null;

      const stat = await this.driver.stat(key);
      const stream = await this.driver.read(key);

      return {
        stream,
        contentType: stat.contentType,
      };
    } catch {
      return null;
    }
  }

  async set(cacheKey: string, data: Buffer, contentType: string): Promise<void> {
    const key = `${this.prefix}/${cacheKey}`;

    try {
      await this.driver.write(key, data, contentType);
    } catch {
      // Silently fail — cache is best-effort
    }
  }

  async invalidate(fileId: string): Promise<void> {
    if (!this.driver.list) return;

    const prefix = `${this.prefix}/${fileId}`;

    try {
      for await (const key of this.driver.list(prefix)) {
        await this.driver.delete(key).catch(() => {});
      }
    } catch {
      // Best-effort cleanup
    }
  }
}
