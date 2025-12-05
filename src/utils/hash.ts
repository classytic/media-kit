/**
 * File Hash Utility
 *
 * Simple utilities for computing file hashes for deduplication.
 *
 * @example
 * ```ts
 * const hash = computeFileHash(buffer);
 * const existing = await Media.findOne({ hash });
 * if (existing) {
 *   console.log('File already exists!');
 * }
 * ```
 */

import crypto from 'crypto';

/**
 * Compute SHA-256 hash of file buffer
 *
 * @param buffer - File buffer
 * @param algorithm - Hash algorithm (default: sha256)
 * @returns Hex-encoded hash string
 */
export function computeFileHash(
  buffer: Buffer,
  algorithm: 'md5' | 'sha1' | 'sha256' = 'sha256'
): string {
  return crypto.createHash(algorithm).update(buffer).digest('hex');
}

/**
 * Compute hash for deduplication (faster, MD5)
 *
 * MD5 is fine for deduplication (not cryptographic security).
 * It's faster than SHA-256 and collision probability is negligible.
 *
 * @param buffer - File buffer
 * @returns MD5 hash string
 */
export function computeDeduplicationHash(buffer: Buffer): string {
  return computeFileHash(buffer, 'md5');
}

/**
 * Check if two buffers are identical using hash comparison
 *
 * @param buffer1 - First buffer
 * @param buffer2 - Second buffer
 * @returns True if buffers are identical
 */
export function buffersEqual(buffer1: Buffer, buffer2: Buffer): boolean {
  if (buffer1.length !== buffer2.length) return false;
  return computeFileHash(buffer1) === computeFileHash(buffer2);
}

export default computeFileHash;
