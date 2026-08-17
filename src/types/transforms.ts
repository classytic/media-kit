/** Framework-neutral asset transformation contracts. */

// ============================================
// ASSET TRANSFORM TYPES (Framework-agnostic)
// ============================================

/**
 * Transform query parameters
 */
export interface TransformParams {
  /** Target width */
  w?: number;
  /** Target height */
  h?: number;
  /** Fit mode */
  fit?: 'cover' | 'contain' | 'fill' | 'inside' | 'outside';
  /** Output format ('auto' resolves from Accept header) */
  format?: 'webp' | 'avif' | 'jpeg' | 'png' | 'auto';
  /** Quality (1-100) */
  q?: number;
  /** Force download (Content-Disposition: attachment) */
  download?: boolean;
}

/**
 * Transform request input (framework-agnostic)
 */
export interface TransformRequest {
  /** File ID or storage key */
  fileId: string;
  /** Variant name from the request path (serves that variant's bytes; signed URLs bind it). */
  variant?: string | undefined;
  /** Transform parameters */
  params: TransformParams;
  /** Accept header for content negotiation */
  accept?: string;
  /** Range header for partial content */
  range?: string;
  /**
   * Decoded query params of the incoming request. Carries the signed-URL
   * fields (`e`, `kid`, `v`, `sig`, `c.*`) when present — required for
   * signature verification of private media.
   */
  query?: Record<string, string> | undefined;
  /**
   * Opaque host session/user object (e.g. `req.user`, arc's `req.scope`).
   * Media-kit never inspects it — it is handed verbatim to the host's
   * `authorize` callback for private, unsigned requests.
   */
  principal?: unknown | undefined;
}

/**
 * Transform response output (framework-agnostic)
 */
export interface TransformResponse {
  /** Response stream */
  stream: NodeJS.ReadableStream;
  /** Content type */
  contentType: string;
  /** Content length (if known) */
  contentLength?: number;
  /** HTTP status code (200 or 206 for range) */
  status: number;
  /** Response headers */
  headers: Record<string, string>;
}

/**
 * Transform cache interface (pluggable)
 */
export interface TransformCache {
  /** Get cached transform */
  get(cacheKey: string): Promise<{ stream: NodeJS.ReadableStream; contentType: string } | null>;
  /** Store transform in cache */
  set(cacheKey: string, data: Buffer, contentType: string): Promise<void>;
  /** Invalidate all transforms for a file */
  invalidate(fileId: string): Promise<void>;
}
