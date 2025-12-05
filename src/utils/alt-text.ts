/**
 * Alt Text Generation Utility
 *
 * Simple, clean utility to generate accessible alt text from filenames.
 * Perfect for improving accessibility with zero configuration.
 *
 * @example
 * ```ts
 * generateAltText('product-red-shoes.jpg')
 * // Returns: "Product red shoes"
 *
 * generateAltText('IMG_20240315_142032.jpg')
 * // Returns: "Image"
 *
 * generateAltText('user-avatar-john-doe.png')
 * // Returns: "User avatar john doe"
 * ```
 */

/**
 * Generate readable alt text from filename
 *
 * Strategy:
 * 1. Remove file extension
 * 2. Replace separators (-, _, .) with spaces
 * 3. Remove common prefixes (IMG_, DSC_, etc.)
 * 4. Clean up numbers and timestamps
 * 5. Capitalize first letter
 * 6. Fallback to "Image" if result is empty/meaningless
 */
export function generateAltText(filename: string, fallback = 'Image'): string {
  if (!filename) return fallback;

  // Remove file extension
  let text = filename.replace(/\.[^.]+$/, '');

  // Replace common separators with spaces
  text = text.replace(/[-_\.]/g, ' ');

  // Remove timestamps and hash-like patterns FIRST
  text = text.replace(/\b\d{8,}\b/g, ''); // 8+ digit numbers (timestamps)
  text = text.replace(/\b[a-f0-9]{8,}\b/gi, ''); // Hex hashes
  text = text.replace(/\b\d{4}[\s-]\d{2}[\s-]\d{2}\b/g, ''); // ISO dates (YYYY-MM-DD or YYYY MM DD)

  // Clean up multiple spaces
  text = text.replace(/\s+/g, ' ').trim();

  // Remove common camera/phone prefixes when they appear at the start
  // Only remove camera codes (IMG, DSC, DCIM, PIC) - not real words like "photo", "image"
  // This happens AFTER timestamp removal, so "photo_20240315" becomes "photo" (kept)
  // but "IMG_20240315" becomes "IMG" which gets removed
  // "PIC_test" becomes "PIC test" → remove "PIC " → "test"
  text = text.replace(/^(IMG|DSC|DCIM|PIC)\s+/i, '');

  // Also remove if it's JUST the prefix with nothing else
  if (/^(IMG|DSC|DCIM|PIC)$/i.test(text)) {
    text = '';
  }

  // Capitalize first letter
  if (text) {
    text = text.charAt(0).toUpperCase() + text.slice(1);
  }

  // Fallback if empty, too short, or only digits/single char
  if (!text || text.length < 2 || /^\d+$/.test(text) || /^[a-z]$/i.test(text)) {
    return fallback;
  }

  return text;
}

/**
 * Generate alt text with custom options
 */
export function generateAltTextWithOptions(
  filename: string,
  options: {
    fallback?: string;
    maxLength?: number;
    customGenerator?: (filename: string) => string;
  } = {}
): string {
  const { fallback = 'Image', maxLength = 125, customGenerator } = options;

  // Use custom generator if provided
  if (customGenerator) {
    try {
      const result = customGenerator(filename);
      return result || fallback;
    } catch {
      // Fall through to default
    }
  }

  // Generate using default strategy
  let alt = generateAltText(filename, fallback);

  // Truncate if too long (recommended max for alt text is 125 chars)
  if (alt.length > maxLength) {
    alt = alt.substring(0, maxLength - 3) + '...';
  }

  return alt;
}

export default generateAltText;
