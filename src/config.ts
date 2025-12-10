/**
 * Media Kit Default Configuration
 */
import type { MediaKitConfig } from './types';
import { FILE_TYPE_PRESETS } from './utils/mime';
import { DEFAULT_BASE_FOLDERS } from './schema/media.schema';

/**
 * Default configuration values
 */
export const DEFAULT_CONFIG: Partial<MediaKitConfig> = {
  fileTypes: {
    allowed: [...FILE_TYPE_PRESETS.all],
    maxSize: 100 * 1024 * 1024, // 100MB (increased from 50MB for better UX)
  },
  folders: {
    baseFolders: DEFAULT_BASE_FOLDERS,
    defaultFolder: 'general',
    contentTypeMap: {},
  },
  processing: {
    enabled: true,
    maxWidth: 2048,
    quality: 80,
    format: 'webp',
    aspectRatios: {
      default: { preserveRatio: true },
    },
    // Sharp memory optimization - disable cache to prevent memory leaks under load
    sharpOptions: {
      concurrency: 2, // Process max 2 images at once
      cache: false,   // Disable Sharp cache to reduce memory usage
    },
  },
  multiTenancy: {
    enabled: false,
    field: 'organizationId',
    required: false,
  },
  // Concurrency control - limit parallel uploads to prevent crashes
  concurrency: {
    maxConcurrent: 5, // Max 5 uploads at once (can be overridden per instance)
  },
};

/**
 * Merge user config with defaults
 */
export function mergeConfig(config: MediaKitConfig): MediaKitConfig {
  return {
    ...DEFAULT_CONFIG,
    ...config,
    fileTypes: { ...DEFAULT_CONFIG.fileTypes, ...config.fileTypes },
    folders: { ...DEFAULT_CONFIG.folders, ...config.folders },
    processing: {
      ...DEFAULT_CONFIG.processing,
      ...config.processing,
      sharpOptions: {
        ...DEFAULT_CONFIG.processing?.sharpOptions,
        ...config.processing?.sharpOptions,
      },
    },
    multiTenancy: { ...DEFAULT_CONFIG.multiTenancy, ...config.multiTenancy },
    concurrency: { ...DEFAULT_CONFIG.concurrency, ...config.concurrency },
  } as MediaKitConfig;
}
