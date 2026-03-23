/**
 * Storage Drivers
 *
 * Export driver implementations for different storage backends.
 * Users import only what they need to keep bundle size small.
 */

export type { StorageDriver, WriteResult, FileStat } from '../types';

// Re-export for convenience (tree-shakeable)
export { S3Provider, type S3ProviderConfig } from './s3.provider';
export { GCSProvider, type GCSProviderConfig } from './gcs.provider';
export { LocalProvider, type LocalProviderConfig } from './local.provider';
export { StorageRouter, type StorageRouterConfig, type RouteRule } from './router';
