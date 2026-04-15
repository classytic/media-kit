/**
 * ScanBridge — upload-time content scanning.
 *
 * Production media systems must scan uploaded files for:
 *   - Viruses / malware (ClamAV, VirusTotal, cloud scanners)
 *   - NSFW / explicit content (AWS Rekognition, Google Vision, Hive)
 *   - CSAM (PhotoDNA, Thorn)
 *   - Content moderation (custom ML policies)
 *
 * media-kit doesn't bundle any scanner — the host provides one via
 * this bridge. The bridge receives the buffer BEFORE upload to storage
 * and returns a verdict. media-kit uses the verdict to either:
 *   - allow the upload (verdict: 'clean')
 *   - reject with an error (verdict: 'reject')
 *   - quarantine (verdict: 'quarantine' — stores with status: 'error')
 *
 * @example
 * ```typescript
 * import { detectNsfw } from '@myorg/nsfw-detector';
 *
 * const scanBridge: ScanBridge = {
 *   async scan(buffer, mimeType, filename) {
 *     if (mimeType.startsWith('image/')) {
 *       const score = await detectNsfw(buffer);
 *       if (score > 0.9) return { verdict: 'reject', reason: 'NSFW content detected' };
 *       if (score > 0.5) return { verdict: 'quarantine', reason: 'Manual review required' };
 *     }
 *     return { verdict: 'clean' };
 *   },
 * };
 * ```
 */

export type ScanVerdict = 'clean' | 'reject' | 'quarantine';

export interface ScanResult {
  verdict: ScanVerdict;
  /** Human-readable reason shown in error messages or audit logs. */
  reason?: string;
  /** Optional metadata — scan scores, labels, scanner name, etc. */
  metadata?: Record<string, unknown>;
}

export interface ScanBridge {
  /**
   * Scan an uploaded buffer before persisting it.
   *
   * Thrown errors are treated as 'reject' verdicts. If you want fail-open
   * behavior, catch your errors and return `{ verdict: 'clean' }` explicitly.
   */
  scan(
    buffer: Buffer,
    mimeType: string,
    filename: string,
    ctx?: { organizationId?: string; userId?: string },
  ): Promise<ScanResult>;
}
