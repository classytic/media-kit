/** Provider-neutral storage and multipart upload contracts. */

// ============================================
// STORAGE DRIVER TYPES (Directus-inspired)
// ============================================

/**
 * Result from storage write operation
 */
export interface WriteResult {
  /** Storage key/path */
  key: string;
  /** Public URL to access the file */
  url: string;
  /** Final file size in bytes */
  size: number;
  /** Provider-specific metadata (e.g. fileId, etag, dimensions). Stored on the media doc as providerMetadata. */
  metadata?: Record<string, unknown>;
}

/**
 * File stat from storage driver
 */
export interface FileStat {
  /** File size in bytes */
  size: number;
  /** MIME type */
  contentType: string;
  /** Last modified timestamp */
  lastModified?: Date;
  /** Entity tag (for cache validation) */
  etag?: string;
  /** Custom metadata key-value pairs */
  metadata?: Record<string, string>;
}

/**
 * Result from a presigned upload URL generation
 */
/** Response overrides for `getSignedReadUrl`. */
export interface SignedReadOptions {
  /** `Content-Type` storage answers with (e.g. the stored `mimeType`). */
  responseType?: string;
  /** `Content-Disposition` storage answers with, e.g. `inline` or `attachment; filename="a.pdf"`. */
  responseDisposition?: string;
}

export interface PresignedUploadResult {
  /** The presigned URL to send the file to */
  uploadUrl: string;
  /** Storage key assigned to the file */
  key: string;
  /** Public URL where the file will be accessible after upload */
  publicUrl: string;
  /** Time in seconds until the presigned URL expires */
  expiresIn: number;
  /** Optional headers the client must include with the request */
  headers?: Record<string, string>;
  /**
   * HTTP verb the client must use. Absent ⇒ `PUT`, which is what S3 and GCS
   * presign.
   *
   * Declared because not every provider presigns a raw-body PUT: Cloudinary
   * signs a multipart POST, so a result that could only express PUT left the
   * driver unable to implement `getSignedUploadUrl` at all — and the whole
   * upload path 500'd with "does not support presigned uploads" rather than
   * degrading.
   */
  method?: 'PUT' | 'POST';
  /**
   * Form fields the client must send ALONGSIDE the file in a multipart POST
   * (Cloudinary's `api_key` / `timestamp` / `signature` / `public_id`).
   *
   * Only meaningful with `method: 'POST'`. A PUT driver leaves this absent, so
   * an existing consumer that ignores it stays correct.
   */
  fields?: Record<string, string>;
  /** Multipart field name the file itself goes under. Absent ⇒ `file`. */
  fileField?: string;
}

/**
 * Per-write options passed to StorageDriver.write().
 *
 * Currently carries the per-object ACL for drivers that support one (S3).
 * Drivers that don't (Local, GCS with uniform bucket-level access,
 * Cloudinary/ImageKit/imgbb) simply ignore it — GCS in particular relies on
 * bucket-level IAM for privacy, not per-object ACLs.
 */
export interface StorageWriteOptions {
  /** Per-object ACL override (S3 only). Falls back to the provider-level `acl` config. */
  acl?: 'private' | 'public-read' | 'authenticated-read' | undefined;
}

/**
 * Storage driver interface (Directus-inspired)
 *
 * Implement this for custom storage backends. Core methods are required;
 * optional methods enable advanced features (presigned uploads, streaming, etc.)
 */
export interface StorageDriver {
  /** Driver name (e.g., 's3', 'gcs', 'local') */
  readonly name: string;

  // --- Core (required) ---

  /** Write data to storage. Accepts Buffer or ReadableStream. `options` is a per-write hint bag (ACL, ...) — drivers MAY ignore it. */
  write(
    key: string,
    data: Buffer | NodeJS.ReadableStream,
    contentType: string,
    options?: StorageWriteOptions,
  ): Promise<WriteResult>;

  /** Read a file as a stream. Supports optional byte-range for partial reads. */
  read(key: string, range?: { start: number; end: number }): Promise<NodeJS.ReadableStream>;

  /** Delete a file by key */
  delete(key: string): Promise<boolean>;

  /** Check if a file exists */
  exists(key: string): Promise<boolean>;

  /** Get file metadata without downloading */
  stat(key: string): Promise<FileStat>;

  // --- Navigation (optional) ---

  /** List files under a prefix (async generator for memory efficiency) */
  list?(prefix: string): AsyncIterable<string>;

  /** Copy a file to a new location within the same bucket */
  copy?(source: string, destination: string): Promise<WriteResult>;

  /** Move a file to a new location (copy + delete) */
  move?(source: string, destination: string): Promise<WriteResult>;

  // --- URLs ---

  /** Build the public URL for a given storage key */
  getPublicUrl(key: string): string;

  /** Get a temporary signed URL for reading a private file */
  getSignedUrl?(key: string, expiresIn?: number): Promise<string>;

  /**
   * A signed read URL that also pins the RESPONSE headers storage sends (GCS V4
   * `response-content-type` / `response-content-disposition`, S3 `ResponseContentType` /
   * `ResponseContentDisposition`), so a viewer gets the declared type (never a sniffed or
   * mislabelled one) and inline-vs-download is decided by the server, not by object metadata.
   */
  getSignedReadUrl?(key: string, expiresIn: number, options: SignedReadOptions): Promise<string>;

  /** Get a presigned URL for direct client-side uploads */
  getSignedUploadUrl?(key: string, contentType: string, expiresIn?: number): Promise<PresignedUploadResult>;

  // --- Multipart Upload (S3-style) ---

  /** Initiate a multipart upload session */
  createMultipartUpload?(key: string, contentType: string): Promise<{ uploadId: string }>;

  /** Generate a presigned URL for uploading a single part */
  signUploadPart?(key: string, uploadId: string, partNumber: number, expiresIn?: number): Promise<SignedPartResult>;

  /** Complete a multipart upload by assembling parts */
  completeMultipartUpload?(
    key: string,
    uploadId: string,
    parts: CompletedPart[],
  ): Promise<{ etag: string; size: number }>;

  /** Abort a multipart upload and clean up uploaded parts */
  abortMultipartUpload?(key: string, uploadId: string): Promise<void>;

  // --- Resumable Upload (GCS-style) ---

  /** Create a resumable upload session (single URI, client pushes chunks via Content-Range) */
  createResumableUpload?(
    key: string,
    contentType: string,
    options?: { size?: number },
  ): Promise<ResumableUploadSession>;

  /** Abort a resumable upload by deleting the session */
  abortResumableUpload?(sessionUri: string): Promise<void>;

  /** Query resumable upload progress (bytes received so far) */
  getResumableUploadStatus?(sessionUri: string): Promise<{ uploadedBytes: number }>;
}

// ============================================
// MULTIPART / RESUMABLE UPLOAD TYPES
// ============================================

/** Hash strategy for confirmUpload() */
export type HashStrategy = 'etag' | 'sha256' | 'skip';

/** Result from signing a single upload part */
export interface SignedPartResult {
  /** Presigned URL for this part */
  uploadUrl: string;
  /** Part number (1-based) */
  partNumber: number;
  /** Required headers for the PUT request */
  headers?: Record<string, string>;
  /** Seconds until URL expires */
  expiresIn: number;
}

/** A completed part (client sends back after uploading) */
export interface CompletedPart {
  /** Part number (1-based) */
  partNumber: number;
  /** ETag returned by storage after part upload */
  etag: string;
}

/** GCS resumable upload session result */
export interface ResumableUploadSession {
  /** Session URI — client sends chunks to this URL with Content-Range headers */
  uploadUrl: string;
  /** Storage key */
  key: string;
  /** Public URL where file will be accessible after completion */
  publicUrl: string;
  /** Recommended minimum chunk size in bytes (256KB for GCS) */
  minChunkSize: number;
  /** Session expiry (GCS sessions last 7 days) */
  expiresAt: Date;
}

/**
 * Multipart upload session info returned to the client.
 * Discriminated union: 'multipart' (S3-style per-part signing) vs 'resumable' (GCS-style single URI).
 */
export interface MultipartUploadSession {
  /** Session type: 'multipart' (S3) or 'resumable' (GCS) */
  type: 'multipart' | 'resumable';
  /** Storage key for the file */
  key: string;
  /** Public URL where the file will be accessible */
  publicUrl: string;

  // --- S3-specific (type='multipart') ---
  /** S3 upload ID */
  uploadId?: string;
  /** Pre-signed part URLs (only if partCount was provided) */
  parts?: SignedPartResult[];

  // --- GCS-specific (type='resumable') ---
  /** Resumable session URI — client sends chunks with Content-Range */
  uploadUrl?: string;
  /** Minimum chunk size in bytes (256KB for GCS, 5MB for S3) */
  minChunkSize?: number;
  /** Session expiry (GCS: 7 days from creation) */
  expiresAt?: Date;
}

/** Input for initiating a multipart upload */
export interface InitiateMultipartInput {
  filename: string;
  contentType: string;
  folder?: string;
  /** Total number of parts (optional — sign all upfront if provided) */
  partCount?: number;
  /** URL expiry for part URLs in seconds (default: 3600) */
  expiresIn?: number;
}

/** Input for completing a multipart upload */
export interface CompleteMultipartInput {
  /**
   * What the user picked, when the stored `filename` differs after a client
   * re-encode. Falls back to `filename`. Same contract as `ConfirmUploadInput`.
   */
  originalFilename?: string | undefined;
  /** Storage key */
  key: string;
  /** S3 upload ID */
  uploadId: string;
  /** Completed parts with ETags */
  parts: CompletedPart[];
  /** Original filename */
  filename: string;
  /** MIME type */
  mimeType: string;
  /** File size in bytes */
  size: number;
  /** Target folder */
  folder?: string;
  /** Alt text */
  alt?: string;
  /** Title */
  title?: string;
  /** Run post-upload processing (ThumbHash, variants, etc.) */
  process?: boolean;

  // --- Client-computed display hints (see ConfirmUploadInput for the full contract) ---

  /**
   * Client-computed image width in pixels — a DISPLAY HINT from client-side
   * processing (e.g. `@classytic/media-transform`). Accepted because the
   * server skips processing in the client-processed flow; when
   * `process: true` runs, server-computed values OVERWRITE these. Worst case
   * a lying client wrongs its own tenant's placeholder rendering.
   */
  width?: number | undefined;
  /** Client-computed image height in pixels. Same contract as `width`. */
  height?: number | undefined;
  /** Client-computed ThumbHash placeholder (base64). Same contract as `width`. */
  thumbhash?: string | undefined;
  /** Client-computed dominant color hex (e.g. '#aabbcc'). Same contract as `width`. */
  dominantColor?: string | undefined;
}

/** Input for batch presigned URL generation */
export interface BatchPresignInput {
  /** Files to generate URLs for */
  files: Array<{
    filename: string;
    contentType: string;
    /** Declared size in bytes — checked against fileTypes.maxSize before signing */
    size?: number;
  }>;
  /** Shared folder for all files */
  folder?: string;
  /** URL expiry in seconds (default: 3600) */
  expiresIn?: number;
}

/** Result from batch presigned URL generation */
export interface BatchPresignResult {
  /** Presigned upload results, one per file (same order as input) */
  uploads: PresignedUploadResult[];
}
