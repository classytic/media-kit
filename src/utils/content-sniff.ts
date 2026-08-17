/**
 * Conservative magic-byte content sniffing for strict-profile validation.
 *
 * The one security-relevant question this answers: "the caller DECLARED an
 * inert binary type (image/video/audio/pdf), but do the actual bytes look like
 * ACTIVE content (HTML / SVG / script) that a browser could execute if it
 * MIME-sniffed the response?" That mismatch is the stored-XSS vector. It is
 * deliberately narrow — it confirms known-safe binary signatures and flags
 * only high-confidence active-content shapes, so it never rejects a valid file
 * it merely doesn't recognize.
 */

/** Coarse content kind inferred from leading bytes. `unknown` = unrecognized (never rejected). */
export type SniffedKind =
  | 'png'
  | 'jpeg'
  | 'gif'
  | 'webp'
  | 'bmp'
  | 'pdf'
  | 'zip' // also docx/xlsx/etc. (OOXML) + many container formats
  | 'gzip'
  | 'mp4'
  | 'webm'
  | 'ogg'
  | 'mp3'
  | 'wav'
  | 'svg'
  | 'html'
  | 'unknown';

const ASCII_WS = new Set([0x09, 0x0a, 0x0c, 0x0d, 0x20, 0xef, 0xbb, 0xbf]); // ws + UTF-8 BOM

function startsWith(buf: Buffer, sig: number[], offset = 0): boolean {
  if (buf.length < offset + sig.length) return false;
  for (let i = 0; i < sig.length; i++) if (buf[offset + i] !== sig[i]) return false;
  return true;
}

/** Leading text (skipping whitespace/BOM), lowercased, for HTML/SVG sniffing. */
function leadingText(buf: Buffer, max = 512): string {
  let i = 0;
  while (i < buf.length && ASCII_WS.has(buf[i] as number)) i++;
  return buf
    .subarray(i, i + max)
    .toString('latin1')
    .toLowerCase();
}

/** Detect the coarse content kind from magic bytes. Pure, allocation-light. */
export function sniffContentKind(buf: Buffer): SniffedKind {
  if (buf.length === 0) return 'unknown';

  // Binary image/media signatures.
  if (startsWith(buf, [0x89, 0x50, 0x4e, 0x47])) return 'png';
  if (startsWith(buf, [0xff, 0xd8, 0xff])) return 'jpeg';
  if (startsWith(buf, [0x47, 0x49, 0x46, 0x38])) return 'gif';
  if (startsWith(buf, [0x42, 0x4d])) return 'bmp';
  if (startsWith(buf, [0x25, 0x50, 0x44, 0x46])) return 'pdf'; // %PDF
  if (startsWith(buf, [0x1f, 0x8b])) return 'gzip';
  if (startsWith(buf, [0x50, 0x4b, 0x03, 0x04]) || startsWith(buf, [0x50, 0x4b, 0x05, 0x06])) return 'zip';
  if (startsWith(buf, [0x52, 0x49, 0x46, 0x46])) {
    // RIFF container: WEBP / WAV distinguished by the sub-chunk at offset 8.
    if (startsWith(buf, [0x57, 0x45, 0x42, 0x50], 8)) return 'webp';
    if (startsWith(buf, [0x57, 0x41, 0x56, 0x45], 8)) return 'wav';
  }
  if (startsWith(buf, [0x66, 0x74, 0x79, 0x70], 4)) return 'mp4'; // ....ftyp
  if (startsWith(buf, [0x1a, 0x45, 0xdf, 0xa3])) return 'webm'; // EBML (webm/mkv)
  if (startsWith(buf, [0x4f, 0x67, 0x67, 0x53])) return 'ogg';
  if (startsWith(buf, [0x49, 0x44, 0x33]) || startsWith(buf, [0xff, 0xfb])) return 'mp3';

  // Active-content text shapes (the security-relevant ones).
  const text = leadingText(buf);
  if (text.startsWith('<?xml') && text.includes('<svg')) return 'svg';
  if (text.startsWith('<svg')) return 'svg';
  if (
    text.startsWith('<!doctype html') ||
    text.startsWith('<html') ||
    text.startsWith('<head') ||
    text.startsWith('<body') ||
    text.startsWith('<script') ||
    text.startsWith('<!--')
  ) {
    return 'html';
  }

  return 'unknown';
}

/** MIME major type (`image`, `video`, `audio`, `application`, ...) of a declared type. */
function majorType(mime: string): string {
  return (mime.split('/')[0] ?? '').toLowerCase();
}

/**
 * Reject a DANGEROUS declared/detected mismatch: content declared as an inert
 * binary type (image/video/audio, or a non-SVG image) whose bytes sniff as
 * active HTML or SVG. Returns `null` when safe (match, unknown, or a benign
 * mismatch). The message is caller-facing.
 */
export function detectDangerousMismatch(buf: Buffer, declaredMime: string): string | null {
  const declared = declaredMime.toLowerCase().split(';')[0]?.trim() ?? '';
  const kind = sniffContentKind(buf);
  if (kind === 'unknown') return null; // never reject what we don't recognize

  const major = majorType(declared);
  const inertBinary = major === 'image' || major === 'video' || major === 'audio';

  // Active content masquerading as inert binary.
  if ((kind === 'html' || kind === 'svg') && inertBinary && declared !== 'image/svg+xml') {
    return `declared '${declared}' but content is ${kind.toUpperCase()} (possible stored-XSS payload)`;
  }
  // HTML masquerading as SVG (svg is allowed to be XML/SVG, not raw HTML).
  if (kind === 'html' && declared === 'image/svg+xml') {
    return `declared 'image/svg+xml' but content is HTML, not SVG`;
  }
  return null;
}
