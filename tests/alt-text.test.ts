/**
 * Alt Text Generation Tests
 */

import { describe, it, expect } from 'vitest';
import { generateAltText, generateAltTextWithOptions } from '../src/utils/alt-text';

describe('generateAltText', () => {
  it('should convert filename to readable alt text', () => {
    expect(generateAltText('product-red-shoes.jpg')).toBe('Product red shoes');
    expect(generateAltText('user-avatar-john-doe.png')).toBe('User avatar john doe');
    expect(generateAltText('summer_beach_vacation.webp')).toBe('Summer beach vacation');
  });

  it('should remove file extensions', () => {
    expect(generateAltText('image.jpg')).toBe('Image');
    expect(generateAltText('photo.png')).toBe('Photo');
    expect(generateAltText('document.pdf')).toBe('Document');
  });

  it('should handle multiple separators', () => {
    expect(generateAltText('my-awesome_photo.2024.jpg')).toBe('My awesome photo 2024');
    expect(generateAltText('test_file-name.image.png')).toBe('Test file name image');
  });

  it('should remove common camera prefixes', () => {
    expect(generateAltText('IMG_20240315.jpg')).toBe('Image');
    expect(generateAltText('DSC_1234.jpg')).toBe('Image');
    expect(generateAltText('DCIM_5678.png')).toBe('Image');
    expect(generateAltText('PIC_test.jpg')).toBe('Test');
  });

  it('should remove timestamps', () => {
    expect(generateAltText('photo_20240315142032.jpg')).toBe('Photo');
    expect(generateAltText('image-2024-03-15.png')).toBe('Image');
  });

  it('should remove hash-like patterns', () => {
    expect(generateAltText('file_a1b2c3d4e5f6.jpg')).toBe('File');
    expect(generateAltText('photo-abc123def456.png')).toBe('Photo');
  });

  it('should use fallback for empty results', () => {
    expect(generateAltText('123456.jpg')).toBe('Image');
    expect(generateAltText('a.jpg')).toBe('Image');
    expect(generateAltText('')).toBe('Image');
  });

  it('should use custom fallback', () => {
    expect(generateAltText('123.jpg', 'Photo')).toBe('Photo');
    expect(generateAltText('', 'Picture')).toBe('Picture');
  });

  it('should capitalize first letter', () => {
    expect(generateAltText('lowercase-filename.jpg')).toBe('Lowercase filename');
    expect(generateAltText('test.png')).toBe('Test');
  });
});

describe('generateAltTextWithOptions', () => {
  it('should use custom fallback option', () => {
    expect(generateAltTextWithOptions('123.jpg', { fallback: 'Photo' })).toBe('Photo');
  });

  it('should truncate long alt text', () => {
    const longFilename = 'this-is-a-very-long-filename-that-should-be-truncated-because-it-exceeds-the-maximum-allowed-length-for-alt-text-which-is-recommended-to-be-125-characters.jpg';
    const result = generateAltTextWithOptions(longFilename, { maxLength: 50 });

    expect(result.length).toBeLessThanOrEqual(50);
    expect(result).toContain('...');
  });

  it('should use custom generator', () => {
    const custom = () => 'Custom alt text';
    const result = generateAltTextWithOptions('any-file.jpg', {
      customGenerator: custom
    });

    expect(result).toBe('Custom alt text');
  });

  it('should fallback if custom generator fails', () => {
    const failing = () => { throw new Error('fail'); };
    const result = generateAltTextWithOptions('test.jpg', {
      customGenerator: failing,
      fallback: 'Fallback'
    });

    expect(result).toBe('Test');
  });

  it('should fallback if custom generator returns empty', () => {
    const empty = () => '';
    const result = generateAltTextWithOptions('test.jpg', {
      customGenerator: empty,
      fallback: 'Fallback'
    });

    expect(result).toBe('Fallback');
  });
});
