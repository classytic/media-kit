/**
 * MIME Type Utilities
 * 
 * Validation and helpers for file type handling.
 */

import mimeTypes from 'mime-types';

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
    // Documents
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'text/plain',
    'text/csv',
    // Videos
    'video/mp4',
    'video/webm',
    // Audio
    'audio/mpeg',
    'audio/wav',
  ],
} as const;

/**
 * Get MIME type from filename
 */
export function getMimeType(filename: string): string {
  return mimeTypes.lookup(filename) || 'application/octet-stream';
}

/**
 * Get file extension from MIME type
 */
export function getExtension(mimeType: string): string {
  return mimeTypes.extension(mimeType) || 'bin';
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

  return `${size.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
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
