/**
 * Zod v4 schema for upload input validation.
 *
 * Used by Arc routes for request body validation + OpenAPI docs.
 */

import { z } from 'zod';

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

export const confirmUploadSchema = z.object({
  key: z.string().min(1),
  filename: z.string().min(1),
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

export const initiateMultipartSchema = z.object({
  filename: z.string().min(1),
  contentType: z.string().min(1),
  folder: z.string().optional(),
  partCount: z.number().int().min(1).optional(),
  expiresIn: z.number().int().min(1).optional(),
});

export const completeMultipartSchema = z.object({
  key: z.string().min(1),
  uploadId: z.string().min(1),
  parts: z.array(
    z.object({
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
