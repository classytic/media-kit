/**
 * MIME Utilities Tests
 */

import { describe, it, expect } from 'vitest';
import {
  getMimeType,
  getExtension,
  isAllowedMimeType,
  isImage,
  isVideo,
  isAudio,
  isDocument,
  getCategory,
  formatFileSize,
  FILE_TYPE_PRESETS,
} from '../src/utils/mime';

describe('MIME Utilities', () => {
  describe('getMimeType', () => {
    it('should detect image MIME types', () => {
      expect(getMimeType('photo.jpg')).toBe('image/jpeg');
      expect(getMimeType('photo.png')).toBe('image/png');
      expect(getMimeType('photo.webp')).toBe('image/webp');
    });

    it('should detect document MIME types', () => {
      expect(getMimeType('doc.pdf')).toBe('application/pdf');
      expect(getMimeType('doc.txt')).toBe('text/plain');
    });

    it('should return octet-stream for unknown', () => {
      expect(getMimeType('file.unknownextension123')).toBe('application/octet-stream');
    });
  });

  describe('getExtension', () => {
    it('should get extension from MIME type', () => {
      expect(getExtension('image/jpeg')).toBe('jpeg');
      expect(getExtension('application/pdf')).toBe('pdf');
    });

    it('should return bin for unknown', () => {
      expect(getExtension('application/x-unknown')).toBe('bin');
    });
  });

  describe('isAllowedMimeType', () => {
    it('should allow exact matches', () => {
      const allowed = ['image/jpeg', 'image/png'];
      expect(isAllowedMimeType('image/jpeg', allowed)).toBe(true);
      expect(isAllowedMimeType('image/gif', allowed)).toBe(false);
    });

    it('should support wildcard patterns', () => {
      const allowed = ['image/*', 'application/pdf'];
      expect(isAllowedMimeType('image/jpeg', allowed)).toBe(true);
      expect(isAllowedMimeType('image/png', allowed)).toBe(true);
      expect(isAllowedMimeType('video/mp4', allowed)).toBe(false);
    });

    it('should be case insensitive', () => {
      const allowed = ['image/JPEG'];
      expect(isAllowedMimeType('image/jpeg', allowed)).toBe(true);
      expect(isAllowedMimeType('IMAGE/JPEG', allowed)).toBe(true);
    });
  });

  describe('Type checkers', () => {
    it('should identify images', () => {
      expect(isImage('image/jpeg')).toBe(true);
      expect(isImage('image/png')).toBe(true);
      expect(isImage('video/mp4')).toBe(false);
    });

    it('should identify videos', () => {
      expect(isVideo('video/mp4')).toBe(true);
      expect(isVideo('image/jpeg')).toBe(false);
    });

    it('should identify audio', () => {
      expect(isAudio('audio/mpeg')).toBe(true);
      expect(isAudio('image/jpeg')).toBe(false);
    });

    it('should identify documents', () => {
      expect(isDocument('application/pdf')).toBe(true);
      expect(isDocument('image/jpeg')).toBe(false);
    });
  });

  describe('getCategory', () => {
    it('should categorize MIME types', () => {
      expect(getCategory('image/jpeg')).toBe('image');
      expect(getCategory('video/mp4')).toBe('video');
      expect(getCategory('audio/mpeg')).toBe('audio');
      expect(getCategory('application/pdf')).toBe('document');
      expect(getCategory('application/octet-stream')).toBe('other');
    });
  });

  describe('formatFileSize', () => {
    it('should format bytes', () => {
      expect(formatFileSize(500)).toBe('500 B');
    });

    it('should format kilobytes', () => {
      expect(formatFileSize(1024)).toBe('1.0 KB');
      expect(formatFileSize(1536)).toBe('1.5 KB');
    });

    it('should format megabytes', () => {
      expect(formatFileSize(1024 * 1024)).toBe('1.0 MB');
      expect(formatFileSize(5.5 * 1024 * 1024)).toBe('5.5 MB');
    });

    it('should format gigabytes', () => {
      expect(formatFileSize(1024 * 1024 * 1024)).toBe('1.0 GB');
    });
  });

  describe('FILE_TYPE_PRESETS', () => {
    it('should have standard presets', () => {
      expect(FILE_TYPE_PRESETS.images).toContain('image/jpeg');
      expect(FILE_TYPE_PRESETS.documents).toContain('application/pdf');
      expect(FILE_TYPE_PRESETS.videos).toContain('video/mp4');
      expect(FILE_TYPE_PRESETS.audio).toContain('audio/mpeg');
    });
  });
});
