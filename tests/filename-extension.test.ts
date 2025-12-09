/**
 * Filename Extension Update Tests
 *
 * Tests the utility function that updates filename extensions
 * when image format changes during processing.
 */

import { describe, it, expect } from 'vitest';
import { updateFilenameExtension } from '../src/utils/mime';

describe('updateFilenameExtension', () => {
  it('should update extension when format changes', () => {
    expect(updateFilenameExtension('photo.jpg', 'image/webp')).toBe('photo.webp');
    expect(updateFilenameExtension('image.png', 'image/webp')).toBe('image.webp');
    expect(updateFilenameExtension('doc.jpeg', 'image/avif')).toBe('doc.avif');
  });

  it('should normalize extension based on mime-types library', () => {
    // mime-types returns 'jpeg' for 'image/jpeg', not 'jpg'
    expect(updateFilenameExtension('photo.jpg', 'image/jpeg')).toBe('photo.jpeg');
    expect(updateFilenameExtension('image.png', 'image/png')).toBe('image.png');
    expect(updateFilenameExtension('file.webp', 'image/webp')).toBe('file.webp');
  });

  it('should handle files with multiple dots in name', () => {
    expect(updateFilenameExtension('my.photo.jpg', 'image/webp')).toBe('my.photo.webp');
    expect(updateFilenameExtension('file.backup.png', 'image/jpeg')).toBe('file.backup.jpeg');
  });

  it('should keep original filename if extension cannot be determined', () => {
    expect(updateFilenameExtension('file.jpg', 'application/octet-stream')).toBe('file.jpg');
    expect(updateFilenameExtension('file.jpg', 'unknown/type')).toBe('file.jpg');
  });

  it('should handle filenames without extension', () => {
    expect(updateFilenameExtension('photo', 'image/webp')).toBe('photo.webp');
    expect(updateFilenameExtension('image', 'image/jpeg')).toBe('image.jpeg');
  });
});
