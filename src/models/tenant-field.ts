/**
 * Dynamic tenant field schema definition.
 *
 * Generates the correct Mongoose SchemaDefinition for organizationId
 * based on engine config. Keeps schema and multiTenantPlugin in sync.
 */

import { Schema } from 'mongoose';

export interface TenantFieldConfig {
  tenantFieldType: 'objectId' | 'string';
  required: boolean;
}

export const DEFAULT_TENANT_CONFIG: TenantFieldConfig = {
  tenantFieldType: 'string',
  required: false,
};

export function tenantFieldDef(config: TenantFieldConfig = DEFAULT_TENANT_CONFIG) {
  const base =
    config.tenantFieldType === 'objectId'
      ? { type: Schema.Types.ObjectId, ref: 'Organization', index: true }
      : { type: String, index: true };

  return { ...base, required: config.required };
}
