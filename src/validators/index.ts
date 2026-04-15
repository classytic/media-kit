/**
 * Zod v4 schemas for @classytic/media-kit.
 *
 * Importable via: import { ... } from '@classytic/media-kit/schemas'
 * Arc auto-converts these to OpenAPI via z.toJSONSchema().
 */

export {
  mediaConfigSchema,
  multiTenancySchema,
  softDeleteSchema,
  fileTypesSchema,
  folderSchema,
  deduplicationSchema,
  concurrencySchema,
  schemaOptionsSchema,
  type MediaConfigValidated,
} from './media-config.schema.js';

export {
  uploadInputSchema,
  confirmUploadSchema,
  initiateMultipartSchema,
  completeMultipartSchema,
  batchPresignSchema,
  importFromUrlSchema,
  focalPointSchema,
} from './upload-input.schema.js';
