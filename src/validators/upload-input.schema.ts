/**
 * Zod v4 schema for upload input validation.
 *
 * Used by Arc routes for request body validation + OpenAPI docs.
 */

import { z } from 'zod';

/**
 * STRICT by construction. Zod's default STRIPS unknown keys, and for an upload
 * command stripping does not fail — it proceeds with a different instruction
 * than the caller wrote. A misspelled `hashStrategy` becomes the default one; a
 * misspelled `variants` key silently uploads a record with no derivatives; a
 * mistyped `process` quietly declines the server processing the client asked
 * for. None of those error, and every one returns a plausible 201.
 *
 * These schemas were also, until now, DECLARED AND UNUSED — the spine's raw
 * handlers hand-checked two or three fields and cast the rest. A validator
 * nothing calls is decoration.
 */

export const focalPointSchema = z.object({
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
});

/**
 * Client-computed display hints (width/height/thumbhash/dominantColor) from
 * client-side processing (e.g. @classytic/media-transform). All optional —
 * see `ConfirmUploadInput` in types.ts for the trust contract.
 * ThumbHash is ~25 bytes → ~36 base64 chars; 128 is a generous ceiling.
 */
const clientMetadataFields = {
  width: z.number().int().positive().max(65535).optional(),
  height: z.number().int().positive().max(65535).optional(),
  thumbhash: z.string().max(128).optional(),
  dominantColor: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .optional(),
} as const;

export const uploadInputSchema = z.object({
  filename: z.string().min(1),
  mimeType: z.string().min(1),
  folder: z.string().optional(),
  alt: z.string().optional(),
  title: z.string().optional(),
  description: z.string().optional(),
  tags: z.array(z.string()).optional(),
  focalPoint: focalPointSchema.optional(),
  contentType: z.string().optional(),
  skipProcessing: z.boolean().optional(),
  provider: z.string().optional(),
  expiresAt: z.coerce.date().optional(),
  visibility: z.enum(['public', 'private']).optional(),
  ...clientMetadataFields,
});

/** A client-declared derivative. Nested objects are strict too — a misspelled
 * key inside one would otherwise be stripped and the variant silently altered. */
export const clientVariantSchema = z.strictObject({
  name: z
    .string()
    .min(1)
    .regex(/^[a-z0-9_-]+$/i, 'variant names become storage keys — [a-z0-9_-] only'),
  key: z.string().min(1),
  mimeType: z.string().min(1),
  size: z.number().int().min(0),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
});

export const confirmUploadSchema = z.strictObject({
  key: z.string().min(1),
  filename: z.string().min(1),
  originalFilename: z.string().min(1).optional(),
  /**
   * Content hash — bounded and free of whitespace, but NOT pinned to a format.
   *
   * A first draft required 64 hex characters. That is sha256's shape, and this
   * value is whatever the deployment's `hashStrategy` produces: an md5 under a
   * different `deduplication.algorithm`, or a storage ETag under
   * `hashStrategy: 'etag'` — and an S3 multipart ETag is not hex at all, it
   * carries a `-N` part suffix. The schema would have been a specific rule
   * overriding a setting the kernel deliberately leaves open, and it rejected a
   * legitimate lookup the moment a test used one.
   *
   * So the check is what actually matters here: present, sanely bounded, and
   * not carrying whitespace or control characters into an index lookup.
   */
  sha256: z.string().min(8).max(256).regex(/^\S+$/, 'content hash must not contain whitespace').optional(),
  variants: z.array(clientVariantSchema).optional(),
  mimeType: z.string().min(1),
  size: z.number().int().min(1),
  folder: z.string().optional(),
  alt: z.string().optional(),
  title: z.string().optional(),
  url: z.url().optional(),
  hashStrategy: z.enum(['etag', 'sha256', 'skip']).optional(),
  etag: z.string().optional(),
  process: z.boolean().optional(),
  visibility: z.enum(['public', 'private']).optional(),
  ...clientMetadataFields,
});

export const initiateMultipartSchema = z.strictObject({
  filename: z.string().min(1),
  contentType: z.string().min(1),
  folder: z.string().optional(),
  partCount: z.number().int().min(1).optional(),
  expiresIn: z.number().int().min(1).optional(),
});

export const completeMultipartSchema = z.strictObject({
  key: z.string().min(1),
  uploadId: z.string().min(1),
  parts: z.array(
    z.strictObject({
      partNumber: z.number().int().min(1),
      etag: z.string().min(1),
    }),
  ),
  filename: z.string().min(1),
  mimeType: z.string().min(1),
  size: z.number().int().min(1),
  folder: z.string().optional(),
  alt: z.string().optional(),
  title: z.string().optional(),
  process: z.boolean().optional(),
  ...clientMetadataFields,
});

export const batchPresignSchema = z.object({
  files: z
    .array(
      z.object({
        filename: z.string().min(1),
        contentType: z.string().min(1),
        size: z.number().int().min(1).optional(),
      }),
    )
    .min(1),
  folder: z.string().optional(),
  expiresIn: z.number().int().min(1).optional(),
});

/**
 * Input schema for `registerExternal()` — registering an externally-hosted
 * asset as a reference-only media record. `url` must be an absolute http(s)
 * URL (the repository re-asserts protocol + optional origin allowlist with
 * typed HttpErrors); the URL is never fetched.
 */
export const registerExternalSchema = z.object({
  url: z.url({ protocol: /^https?$/ }).max(2048),
  filename: z.string().min(1).max(512).optional(),
  mimeType: z.string().min(1).max(255).optional(),
  size: z.number().int().min(0).optional(),
  folder: z.string().optional(),
  visibility: z.enum(['public', 'private']).optional(),
  tags: z.array(z.string()).optional(),
  alt: z.string().optional(),
  title: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  sourceProvider: z.string().min(1).max(128).optional(),
  ...clientMetadataFields,
});

export const importFromUrlSchema = z.object({
  url: z.string().url(),
  folder: z.string().optional(),
  filename: z.string().optional(),
  alt: z.string().optional(),
  title: z.string().optional(),
  tags: z.array(z.string()).optional(),
  maxSize: z.number().int().min(1).optional(),
  timeout: z.number().int().min(1).optional(),
});

/**
 * The `start-write` command. Strict for the same reason as confirm: a
 * misspelled `derivatives` key would presign nothing and the client would
 * upload a primary believing it had done the whole job.
 */
export const startWriteSchema = z.strictObject({
  filename: z.string().min(1),
  contentType: z.string().min(1),
  size: z.number().int().min(0).optional(),
  folder: z.string().optional(),
  sha256: z.string().min(8).max(256).regex(/^\S+$/, 'content hash must not contain whitespace').optional(),
  multipart: z.boolean().optional(),
  partCount: z.number().int().min(1).optional(),
  expiresIn: z.number().int().min(1).optional(),
  derivatives: z
    .array(
      z.strictObject({
        name: z
          .string()
          .min(1)
          .regex(/^[a-z0-9_-]+$/i, 'variant names become storage keys — [a-z0-9_-] only'),
        contentType: z.string().min(1),
        size: z.number().int().min(0).optional(),
      }),
    )
    .optional(),
});
