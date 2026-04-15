/**
 * Zod v4 schema for MediaConfig validation.
 *
 * Validates the config object passed to createMedia().
 * Arc auto-converts Zod schemas to OpenAPI via z.toJSONSchema().
 */

import { z } from 'zod';

export const multiTenancySchema = z.object({
  enabled: z.boolean(),
  field: z.string().optional().default('organizationId'),
  required: z.boolean().optional().default(false),
});

export const softDeleteSchema = z.object({
  enabled: z.boolean(),
  ttlDays: z.number().int().min(0).optional().default(30),
});

export const fileTypesSchema = z.object({
  allowed: z.array(z.string()).min(1),
  maxSize: z.number().int().min(1).optional(),
});

export const folderSchema = z.object({
  defaultFolder: z.string().optional().default('general'),
  contentTypeMap: z.record(z.string(), z.array(z.string())).optional().default({}),
  enableSubfolders: z.boolean().optional().default(true),
  rewriteKeys: z.boolean().optional().default(true),
});

export const deduplicationSchema = z.object({
  enabled: z.boolean(),
  returnExisting: z.boolean().optional().default(true),
  algorithm: z.enum(['md5', 'sha256']).optional().default('sha256'),
});

export const concurrencySchema = z.object({
  maxConcurrent: z.number().int().min(1).optional().default(5),
});

export const schemaOptionsSchema = z.object({
  extraFields: z.record(z.string(), z.unknown()).optional(),
  extraIndexes: z.array(z.record(z.string(), z.union([z.literal(1), z.literal(-1), z.literal('text')]))).optional(),
  collection: z.string().optional().default('media'),
  optimizedIndexes: z.boolean().optional().default(false),
}).optional();

/**
 * Top-level config schema.
 *
 * Only validates serializable fields — connection, driver, eventTransport,
 * plugins, cache, processing, and logger are validated by type system only.
 */
export const mediaConfigSchema = z.object({
  tenantFieldType: z.enum(['objectId', 'string']).optional().default('string'),
  multiTenancy: multiTenancySchema.optional(),
  softDelete: softDeleteSchema.optional(),
  fileTypes: fileTypesSchema.optional(),
  folders: folderSchema.optional(),
  deduplication: deduplicationSchema.optional(),
  concurrency: concurrencySchema.optional(),
  schemaOptions: schemaOptionsSchema,
  suppressWarnings: z.boolean().optional().default(false),
});

export type MediaConfigValidated = z.infer<typeof mediaConfigSchema>;
