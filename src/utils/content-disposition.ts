/**
 * Content-Disposition Header Encoding
 *
 * RFC 6266 / RFC 5987 compliant encoding for the `filename` parameter.
 * Raw filenames must never be interpolated into the header — quotes and
 * CR/LF enable header injection, and non-ASCII characters are undefined
 * behavior in the plain `filename=` form.
 */

// biome-ignore-start lint/suspicious/noControlCharactersInRegex: intentionally stripping header-injection chars
/** Control characters (C0 + DEL) — never legitimate in a filename header. */
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;
// biome-ignore-end lint/suspicious/noControlCharactersInRegex: intentionally stripping header-injection chars

/** Anything outside printable ASCII (space..tilde). */
const NON_ASCII = /[^ -~]/;

/**
 * Percent-encode a value per RFC 5987 `ext-value` (attr-char set).
 * `encodeURIComponent` covers most of it; the extras `'`, `(`, `)`, `*`
 * are not attr-chars and must be escaped manually.
 */
function encodeRfc5987(value: string): string {
  return encodeURIComponent(value).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/**
 * Build an ASCII-safe fallback filename: strips control chars (incl. CR/LF),
 * replaces double quotes and backslashes (quoted-string breakers), and maps
 * any remaining non-ASCII character to `_`.
 */
function asciiFallback(filename: string): string {
  const cleaned = filename
    .replace(CONTROL_CHARS, '')
    .replace(/["\\]/g, '_')
    .replace(new RegExp(NON_ASCII.source, 'g'), '_');
  return cleaned || 'download';
}

/**
 * Format a `Content-Disposition: attachment` header value for a filename.
 *
 * Always emits a quoted ASCII `filename=` fallback; when the (control-char
 * stripped) name contains non-ASCII characters, additionally emits the
 * RFC 5987 `filename*=UTF-8''...` form so conforming clients restore the
 * exact name.
 *
 * @example
 * contentDispositionAttachment('report.pdf')
 * // => attachment; filename="report.pdf"
 * contentDispositionAttachment('räksmörgås.jpg')
 * // => attachment; filename="r_ksm_rg_s.jpg"; filename*=UTF-8''r%C3%A4ksm%C3%B6rg%C3%A5s.jpg
 */
export function contentDispositionAttachment(filename: string): string {
  const fallback = asciiFallback(filename);

  // Strip control chars first — they're never legitimate and must not force
  // (or leak into) the extended form.
  const sanitized = filename.replace(CONTROL_CHARS, '');

  if (!NON_ASCII.test(sanitized)) {
    return `attachment; filename="${fallback}"`;
  }

  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeRfc5987(sanitized)}`;
}
