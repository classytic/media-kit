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
});

export const confirmUploadSchema = z.object({
  key: z.string().min(1),
  filename: z.string().min(1),
  mimeType: z.string().min(1),
  size: z.number().int().min(1),
  folder: z.string().optional(),
  alt: z.string().optional(),
  title: z.string().optional(),
  url: z.string().optional(),
  hashStrategy: z.enum(['etag', 'sha256', 'skip']).optional(),
  etag: z.string().optional(),
  process: z.boolean().optional(),
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
});

export const batchPresignSchema = z.object({
  files: z.array(
    z.object({
      filename: z.string().min(1),
      contentType: z.string().min(1),
    }),
  ).min(1),
  folder: z.string().optional(),
  expiresIn: z.number().int().min(1).optional(),
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
