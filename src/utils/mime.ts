/**
 * MIME Type Utilities
 * 
 * Validation and helpers for file type handling.
 */

/**
 * Built-in MIME mappings for common media types.
 * Used as fallback when `mime-types` peer dependency is not installed.
 */
const BUILTIN_EXT_TO_MIME: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp',
  gif: 'image/gif', svg: 'image/svg+xml', avif: 'image/avif', ico: 'image/x-icon',
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', avi: 'video/x-msvideo',
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', aac: 'audio/aac',
  pdf: 'application/pdf', json: 'application/json', txt: 'text/plain', csv: 'text/csv',
  doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

const BUILTIN_MIME_TO_EXT: Record<string, string> = Object.fromEntries(
  Object.entries(BUILTIN_EXT_TO_MIME).map(([ext, mime]) => [mime, ext]),
);

let mimeTypes: typeof import('mime-types') | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  mimeTypes = require('mime-types') as typeof import('mime-types');
} catch {
  // mime-types not installed — built-in fallback will be used
}

/**
 * Common file type presets
 */
export const FILE_TYPE_PRESETS = {
  /** Images only */
  images: [
    'image/jpeg',
    'image/jpg',
    'image/png',
    'image/webp',
    'image/gif',
    'image/svg+xml',
    'image/avif',
  ],
  
  /** Documents */
  documents: [
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-powerpoint',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'text/plain',
    'text/csv',
  ],
  
  /** Videos */
  videos: [
    'video/mp4',
    'video/webm',
    'video/quicktime',
    'video/x-msvideo',
    'video/x-flv',
  ],
  
  /** Audio */
  audio: [
    'audio/mpeg',
    'audio/wav',
    'audio/ogg',
    'audio/webm',
    'audio/aac',
  ],
  
  /** All media (images + videos + audio) */
  media: [
    'image/jpeg',
    'image/jpg',
    'image/png',
    'image/webp',
    'image/gif',
    'image/svg+xml',
    'video/mp4',
    'video/webm',
    'audio/mpeg',
    'audio/wav',
  ],
  
  /** Everything common */
  all: [
    // Images
    'image/jpeg',
    'image/jpg',
    'image/png',
    'image/webp',
    'image/gif',
    'image/svg+xml',
    'image/avif',
    'image/bmp',
    'image/tiff',
    'image/x-icon',
    'image/heic',
    'image/heif',
    // Documents
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-powerpoint',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'text/plain',
    'text/csv',
    'text/html',
    'text/xml',
    'application/json',
    'application/xml',
    'application/rtf',
    // Archives
    'application/zip',
    'application/gzip',
    'application/x-tar',
    'application/x-7z-compressed',
    'application/x-rar-compressed',
    // Videos
    'video/mp4',
    'video/webm',
    'video/quicktime',
    'video/x-msvideo',
    'video/x-flv',
    'video/x-matroska',
    'video/3gpp',
    // Audio
    'audio/mpeg',
    'audio/wav',
    'audio/ogg',
    'audio/webm',
    'audio/aac',
    'audio/flac',
    'audio/x-m4a',
    // Binary / generic
    'application/octet-stream',
  ],
} as const;

/**
 * Get MIME type from filename.
 * Uses `mime-types` if installed, otherwise falls back to built-in map.
 */
export function getMimeType(filename: string): string {
  if (mimeTypes) {
    return mimeTypes.lookup(filename) || 'application/octet-stream';
  }
  const ext = filename.split('.').pop()?.toLowerCase();
  return (ext && BUILTIN_EXT_TO_MIME[ext]) || 'application/octet-stream';
}

/**
 * Get file extension from MIME type.
 * Uses `mime-types` if installed, otherwise falls back to built-in map.
 */
export function getExtension(mimeType: string): string {
  if (mimeTypes) {
    return mimeTypes.extension(mimeType) || 'bin';
  }
  return BUILTIN_MIME_TO_EXT[mimeType] || 'bin';
}

/**
 * Check if MIME type is allowed
 */
export function isAllowedMimeType(mimeType: string, allowedTypes: string[]): boolean {
  // Normalize
  const normalizedMime = mimeType.toLowerCase();
  const normalizedAllowed = allowedTypes.map(t => t.toLowerCase());
  
  // Check exact match
  if (normalizedAllowed.includes(normalizedMime)) {
    return true;
  }
  
  // Check wildcard patterns (e.g., 'image/*')
  for (const allowed of normalizedAllowed) {
    if (allowed.endsWith('/*')) {
      const prefix = allowed.slice(0, -1);
      if (normalizedMime.startsWith(prefix)) {
        return true;
      }
    }
  }
  
  return false;
}

/**
 * Camera RAW MIME types (not natively supported by Sharp).
 * Require a RawAdapter for processing.
 */
export const RAW_MIME_TYPES = [
  'image/x-canon-cr2',
  'image/x-canon-cr3',
  'image/x-nikon-nef',
  'image/x-sony-arw',
  'image/x-adobe-dng',
  'image/x-panasonic-rw2',
  'image/x-fuji-raf',
  'image/x-olympus-orf',
  'image/x-pentax-pef',
  'image/x-samsung-srw',
] as const;

/**
 * Check if MIME type is a camera RAW format.
 * These require a RawAdapter for conversion before Sharp can process them.
 */
export function isRawImage(mimeType: string): boolean {
  return (RAW_MIME_TYPES as readonly string[]).includes(mimeType.toLowerCase());
}

/**
 * Check if file is an image
 */
export function isImage(mimeType: string): boolean {
  return mimeType.startsWith('image/');
}

/**
 * Check if file is a video
 */
export function isVideo(mimeType: string): boolean {
  return mimeType.startsWith('video/');
}

/**
 * Check if file is audio
 */
export function isAudio(mimeType: string): boolean {
  return mimeType.startsWith('audio/');
}

/**
 * Check if file is a document
 */
export function isDocument(mimeType: string): boolean {
  return FILE_TYPE_PRESETS.documents.includes(mimeType as any);
}

/**
 * Get category for a MIME type
 */
export function getCategory(mimeType: string): 'image' | 'video' | 'audio' | 'document' | 'other' {
  if (isImage(mimeType)) return 'image';
  if (isVideo(mimeType)) return 'video';
  if (isAudio(mimeType)) return 'audio';
  if (isDocument(mimeType)) return 'document';
  return 'other';
}

/**
 * Format file size for display
 */
export function formatFileSize(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = bytes;
  let unitIndex = 0;

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex++;
  }

  return `${size.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]!}`;
}

/**
 * Update filename extension to match MIME type
 *
 * @param filename - Original filename
 * @param newMimeType - New MIME type after processing
 * @returns Updated filename with correct extension
 *
 * @example
 * updateFilenameExtension('photo.jpg', 'image/webp') // → 'photo.webp'
 * updateFilenameExtension('doc.pdf', 'application/pdf') // → 'doc.pdf' (no change)
 */
export function updateFilenameExtension(filename: string, newMimeType: string): string {
  const newExt = getExtension(newMimeType);
  if (!newExt || newExt === 'bin') {
    return filename; // Can't determine extension, keep original
  }

  // Check if filename has an extension
  const hasExtension = /\.[^.]+$/.test(filename);

  if (hasExtension) {
    // Replace extension: 'photo.jpg' → 'photo.webp'
    return filename.replace(/\.[^.]+$/, `.${newExt}`);
  } else {
    // Add extension: 'photo' → 'photo.webp'
    return `${filename}.${newExt}`;
  }
}
