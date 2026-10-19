/**
 * media-kit's wire error vocabulary: every `code` a caller can see on a typed
 * refusal, in one place.
 *
 * Errors are repo-core `HttpError`s (`createError(status, message)` + a stable
 * `code`), the shape arc's error handler and `toErrorContract` serialize
 * as-is, so a client-caused failure reaches the wire with its own status
 * (415, 409, 413, ...) instead of `arc.internal_error` 500. Hosts and SDKs
 * switch on these constants instead of matching message text.
 *
 * Values are wire-stable: never rename one, only add.
 */

import { createError, type HttpError } from '@classytic/repo-core/errors';

export const MEDIA_ERROR_CODES = {
  ASSET_IN_USE: 'media.in_use',
  // File policy (upload, presign, confirm, multipart completion)
  /** HTTP 415: the MIME type is outside `fileTypes.allowed`. */
  FILE_TYPE_NOT_ALLOWED: 'media.file.type_not_allowed',
  /** HTTP 413: declared or stored size exceeds `fileTypes.maxSize`. */
  FILE_TOO_LARGE: 'media.file.too_large',
  /** HTTP 400: an upload with no bytes. */
  FILE_EMPTY: 'media.file.empty',
  /** HTTP 415: content sniffs as active HTML/SVG while declaring an inert type (`verifyContent`). */
  FILE_CONTENT_MISMATCH: 'media.file.content_mismatch',

  // Two-phase upload
  /** HTTP 409: confirm/complete of a key with no stored object (the PUT never landed). */
  UPLOAD_NOT_FOUND: 'media.upload.not_found',
  /** HTTP 403: a dev presigned PUT whose signature is missing, forged or expired. */
  UPLOAD_SIGNATURE_INVALID: 'media.upload.signature_invalid',
  /** HTTP 415: the PUT's `Content-Type` differs from the signed one. */
  UPLOAD_CONTENT_TYPE_MISMATCH: 'media.upload.content_type_mismatch',
  /** HTTP 404: the LocalProvider receiver was mounted but presign is not enabled. */
  UPLOAD_RECEIVER_DISABLED: 'media.upload.receiver_disabled',
  /** HTTP 400: a storage key that resolves outside the storage root. */
  KEY_INVALID: 'media.key.invalid',
  CONFIRM_INVALID_KEY: 'media.confirm.invalid_key',
  CONFIRM_INVALID_URL: 'media.confirm.invalid_url',
  CONFIRM_TENANT_MISMATCH: 'media.confirm.tenant_mismatch',
  CONFIRM_KEY_IN_USE: 'media.confirm.key_in_use',

  // Records
  /** HTTP 404: no media record with that id (in the caller's scope). */
  ASSET_NOT_FOUND: 'media.asset.not_found',
  /** HTTP 404: the media record has no variant with that name. */
  VARIANT_NOT_FOUND: 'media.variant.not_found',
  /** HTTP 400: focal point outside the unit square. */
  FOCAL_POINT_INVALID: 'media.focal_point.invalid',
  /** HTTP 400: a transform op the TransformBridge does not register. */
  TRANSFORM_UNKNOWN_OP: 'media.transform.unknown_op',
  EXTERNAL_NO_BYTES: 'media.external.no_bytes',
  EXTERNAL_INVALID_URL: 'media.external.invalid_url',
  EXTERNAL_ORIGIN_NOT_ALLOWED: 'media.external.origin_not_allowed',
  TX_EXTERNAL_SESSION_UNSUPPORTED: 'media.tx.external_session_unsupported',

  // Scan bridge
  /** HTTP 422: the scan bridge rejected the bytes. */
  SCAN_REJECTED: 'media.scan.rejected',
  /** HTTP 502: the scan bridge itself failed (unscanned bytes are refused). */
  SCAN_FAILED: 'media.scan.failed',

  // URL import
  /** HTTP 400: not an http(s) URL. */
  IMPORT_INVALID_URL: 'media.import.invalid_url',
  /** HTTP 400: the URL targets an internal host or private address (SSRF guard). */
  IMPORT_URL_BLOCKED: 'media.import.url_blocked',
  /** HTTP 422: the remote host could not be resolved, redirected too often, or answered >= 400. */
  IMPORT_FETCH_FAILED: 'media.import.fetch_failed',

  // Signing and LLM context
  SIGNING_NOT_CONFIGURED: 'media.signing.not_configured',
  CONTEXT_TOO_LARGE: 'media.context.too_large',
  CONTEXT_EXTERNAL: 'media.context.external',

  // Serve route (AssetTransform)
  SERVE_FORBIDDEN: 'media.serve.forbidden',
  SERVE_LINK_EXPIRED: 'media.serve.link_expired',
  SERVE_NOT_FOUND: 'media.serve.not_found',
  SERVE_VARIANT_NOT_FOUND: 'media.serve.variant_not_found',
  SERVE_EXTERNAL_NO_BYTES: 'media.serve.external_no_bytes',
} as const;

export type MediaErrorCode = (typeof MEDIA_ERROR_CODES)[keyof typeof MEDIA_ERROR_CODES];

/** A repo-core `HttpError` carrying a catalogued media code (and optional log-safe `meta`). */
export function mediaError(
  status: number,
  code: MediaErrorCode,
  message: string,
  meta?: Record<string, unknown>,
): HttpError {
  const err = createError(status, message);
  err.code = code;
  if (meta) err.meta = meta;
  return err;
}
