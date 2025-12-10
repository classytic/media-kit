/**
 * Media Kit with Caching
 *
 * Shows how to enable mongokit's caching layer with media-kit.
 * Supports any cache adapter: Redis, Memcached, in-memory, etc.
 */

import mongoose from 'mongoose';
import { createMedia } from '@classytic/media-kit';
import { S3Provider } from '@classytic/media-kit/providers/s3';
import { cachePlugin, createMemoryCache } from '@classytic/mongokit';

// ============================================
// OPTION 1: In-Memory Cache (for development)
// ============================================

const mediaWithMemoryCache = createMedia({
  provider: new S3Provider({
    bucket: process.env.S3_BUCKET!,
    region: process.env.AWS_REGION!,
    // acl: 'public-read', // Only needed if your bucket uses ACLs (not bucket policies)
  }),
  // Add mongokit cache plugin
  plugins: [
    cachePlugin({
      adapter: createMemoryCache(), // Built-in memory cache
      ttl: 60, // 1 minute TTL
      debug: true, // Log cache hits/misses
    }),
  ],
});

// ============================================
// OPTION 2: Redis Cache (for production)
// ============================================

import Redis from 'ioredis';

const redis = new Redis(process.env.REDIS_URL);

const redisAdapter = {
  async get<T>(key: string): Promise<T | null> {
    const data = await redis.get(key);
    return data ? JSON.parse(data) : null;
  },
  async set<T>(key: string, value: T, ttl: number): Promise<void> {
    await redis.setex(key, ttl, JSON.stringify(value));
  },
  async del(key: string): Promise<void> {
    await redis.del(key);
  },
  async clear(pattern?: string): Promise<void> {
    const keys = await redis.keys(pattern || '*');
    if (keys.length) await redis.del(...keys);
  },
};

const mediaWithRedis = createMedia({
  provider: new S3Provider({
    bucket: process.env.S3_BUCKET!,
    region: process.env.AWS_REGION!,
    // acl: 'public-read', // Only needed if your bucket uses ACLs (not bucket policies)
  }),
  processing: {
    enabled: true,
    format: 'webp',
    // Sharp memory optimization (v2.0.3)
    sharpOptions: {
      concurrency: 2,
      cache: false,
    },
  },
  // Concurrency control (v2.0.3)
  concurrency: {
    maxConcurrent: 10, // Higher for production with caching
  },
  plugins: [
    cachePlugin({
      adapter: redisAdapter,
      ttl: 300, // 5 minutes for production
      byIdTtl: 600, // 10 minutes for single document lookups
      queryTtl: 60, // 1 minute for list queries
    }),
  ],
});

// ============================================
// USAGE
// ============================================

await mongoose.connect(process.env.MONGODB_URI!);

const Media = mongoose.model('Media', mediaWithRedis.schema);
mediaWithRedis.init(Media);

// First call - cache MISS, fetches from DB
const files1 = await mediaWithRedis.getAll({ page: 1, limit: 20 });
console.log('First call:', files1.docs.length, 'files');

// Second call - cache HIT, returns from cache instantly
const files2 = await mediaWithRedis.getAll({ page: 1, limit: 20 });
console.log('Second call (cached):', files2.docs.length, 'files');

// Skip cache for fresh data
const fresh = await mediaWithRedis.repository.getAll(
  { page: 1, limit: 20 },
  { skipCache: true } // Forces DB query
);
console.log('Fresh data:', fresh.docs.length, 'files');

// Upload invalidates cache automatically
const uploaded = await mediaWithRedis.upload({
  buffer: Buffer.from('new file'),
  filename: 'new.txt',
  mimeType: 'text/plain',
  folder: 'general',
});
console.log('Uploaded:', uploaded.filename);
// ^ This automatically bumps the cache version, invalidating list caches

// Get by ID - also cached
const doc = await mediaWithRedis.getById(uploaded._id.toString());
console.log('Got by ID (cached on next call):', doc?.filename);

// ============================================
// CACHE STATS & MANUAL INVALIDATION
// ============================================

// Get cache statistics
const stats = mediaWithRedis.repository.getCacheStats?.();
console.log('Cache stats:', stats);
// { hits: 2, misses: 3, sets: 3, invalidations: 1 }

// Manual invalidation (for microservices)
await mediaWithRedis.repository.invalidateCache?.(uploaded._id.toString());
await mediaWithRedis.repository.invalidateListCache?.();
await mediaWithRedis.repository.invalidateAllCache?.();

// ============================================
// SUMMARY
// ============================================
//
// Cache is automatic once configured:
// - getAll(), getById() → check cache first
// - upload(), delete(), update() → auto-invalidate
// - skipCache: true → bypass cache for fresh data
//
// Best practices:
// - Use memory cache for dev, Redis for production
// - Set different TTLs for byId vs list queries
// - Use invalidateCache() for cross-service sync

