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
    maxSize: 50 * 1024 * 1024, // 50MB
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
  },
  multiTenancy: {
    enabled: false,
    field: 'organizationId',
    required: false,
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
    processing: { ...DEFAULT_CONFIG.processing, ...config.processing },
    multiTenancy: { ...DEFAULT_CONFIG.multiTenancy, ...config.multiTenancy },
  } as MediaKitConfig;
}
