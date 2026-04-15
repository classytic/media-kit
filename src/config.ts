/**
 * Media Kit Default Configuration
 */
import type { MediaKitConfig } from './types';
import { FILE_TYPE_PRESETS } from './utils/mime';
import { resolveProcessingPreset } from './processing/presets';

/**
 * Default configuration values
 */
const DEFAULT_CONFIG: Omit<MediaKitConfig, 'driver'> = {
  fileTypes: {
    allowed: [...FILE_TYPE_PRESETS.all],
    maxSize: 100 * 1024 * 1024, // 100MB
  },
  folders: {
    defaultFolder: 'general',
    contentTypeMap: {},
    enableSubfolders: true,
  },
  processing: {
    enabled: true,
    keepOriginal: true,
    maxWidth: 4096,
    maxHeight: 4096,
    quality: {
      jpeg: 82,
      webp: 82,
      avif: 50,
      png: 100,
    },
    format: 'original',
    stripMetadata: true,
    autoOrient: true,
    thumbhash: true,
    dominantColor: true,
    smartSkip: true,
    aspectRatios: {
      default: { preserveRatio: true },
    },
    sharpOptions: {
      concurrency: 2,
      cache: false,
    },
  },
  multiTenancy: {
    enabled: false,
    field: 'organizationId',
    required: false,
  },
  deduplication: {
    enabled: false,
    returnExisting: true,
    algorithm: 'sha256',
  },
  softDelete: {
    enabled: false,
    ttlDays: 30,
  },
  concurrency: {
    maxConcurrent: 5,
  },
};

/**
 * Merge quality setting — user value wins entirely if provided.
 * If user provides a number, it replaces the map. If user provides a partial map, merge with defaults.
 */
function mergeQuality(
  defaultQuality: MediaKitConfig['processing'] extends { quality?: infer Q } ? Q : unknown,
  userQuality: MediaKitConfig['processing'] extends { quality?: infer Q } ? Q : unknown,
): typeof defaultQuality {
  if (userQuality === undefined) return defaultQuality;
  if (typeof userQuality === 'number') return userQuality;
  if (typeof userQuality === 'object' && typeof defaultQuality === 'object') {
    return { ...defaultQuality, ...userQuality };
  }
  return userQuality;
}

/**
 * Merge user config with defaults.
 * If a processing preset is specified, it's applied between defaults and user overrides:
 *   defaults → preset → user overrides (user wins)
 */
export function mergeConfig(config: MediaKitConfig): MediaKitConfig {
  // Resolve processing preset if specified
  const presetConfig = resolveProcessingPreset(config.processing?.preset);

  // Build processing config: defaults → preset → user overrides
  const processingBase = presetConfig
    ? { ...DEFAULT_CONFIG.processing, ...presetConfig }
    : { ...DEFAULT_CONFIG.processing };

  // Determine effective quality: user > preset > default
  const effectiveQuality = mergeQuality(
    mergeQuality(DEFAULT_CONFIG.processing?.quality, presetConfig?.quality),
    config.processing?.quality,
  );

  return {
    ...DEFAULT_CONFIG,
    ...config,
    fileTypes: { ...DEFAULT_CONFIG.fileTypes, ...config.fileTypes },
    folders: { ...DEFAULT_CONFIG.folders, ...config.folders },
    processing: {
      ...processingBase,
      ...config.processing,
      quality: effectiveQuality,
      aspectRatios: {
        ...DEFAULT_CONFIG.processing?.aspectRatios,
        ...presetConfig?.aspectRatios,
        ...config.processing?.aspectRatios,
      },
      sharpOptions: {
        ...DEFAULT_CONFIG.processing?.sharpOptions,
        ...presetConfig?.sharpOptions,
        ...config.processing?.sharpOptions,
      },
    },
    multiTenancy: { ...DEFAULT_CONFIG.multiTenancy, ...config.multiTenancy },
    deduplication: { ...DEFAULT_CONFIG.deduplication, ...config.deduplication },
    softDelete: { ...DEFAULT_CONFIG.softDelete, ...config.softDelete },
    concurrency: { ...DEFAULT_CONFIG.concurrency, ...config.concurrency },
  } as MediaKitConfig;
}
