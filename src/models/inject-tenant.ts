/**
 * Mongoose-specific adapter around `resolveTenantConfig()` from
 * `@classytic/primitives/tenant`. The pure resolution lives in primitives
 * (zero runtime deps) — this file only handles the Mongoose schema
 * mutations (add field, prepend tenant to indexes) that primitives can't
 * own without a mongoose dependency.
 *
 * media-kit's historical defaults differ from primitives': `fieldType:
 * 'string'` and `required: false` (hosts may issue UUID/slug orgIds and the
 * field is optional by default). Those defaults are applied in
 * `resolveMediaTenant()` before the input reaches primitives.
 */
import mongoose, { type Schema } from 'mongoose';
import {
  resolveTenantConfig,
  type ResolvedTenantConfig,
  type TenantConfig,
} from '@classytic/primitives/tenant';

/**
 * Accept the same config surface other packages use (TenantConfig | boolean),
 * and additionally support the legacy `{ tenantFieldType, multiTenant }` shape
 * so the engine factory can forward its own config shorthand.
 */
export type MediaTenantInput =
  | TenantConfig
  | boolean
  | {
      tenantFieldType?: 'objectId' | 'string';
      multiTenant?: boolean;
    };

/**
 * Resolve a possibly-partial tenant input.
 *
 * media-kit defaults to `fieldType: 'string'` and `required: false` — hosts
 * issuing UUID / slug organization ids can upload without touching tenant
 * config. Flip to `fieldType: 'objectId'` when your auth system issues
 * ObjectIds and you want `$lookup` / `.populate()` on the `organizationId`
 * field.
 */
export function resolveMediaTenant(input: MediaTenantInput = {}): ResolvedTenantConfig {
  if (typeof input === 'boolean') {
    // `false` → scoping disabled entirely (primitives handles).
    // `true`  → enable with media-kit defaults (string, not required).
    if (input === false) return resolveTenantConfig(false);
    return resolveTenantConfig({ enabled: true, fieldType: 'string', required: false });
  }

  // Legacy shorthand — translate to TenantConfig.
  if ('tenantFieldType' in input || 'multiTenant' in input) {
    const legacy = input as { tenantFieldType?: 'objectId' | 'string'; multiTenant?: boolean };
    return resolveTenantConfig({
      enabled: legacy.multiTenant !== false,
      fieldType: legacy.tenantFieldType ?? 'string',
      required: false,
    });
  }

  // Canonical TenantConfig — apply media-kit defaults (string / not required)
  // only when caller omitted the field (primitives would otherwise pick
  // objectId / required: true).
  const config = input as TenantConfig;
  return resolveTenantConfig({
    ...config,
    fieldType: config.fieldType ?? 'string',
    required: config.required ?? false,
  });
}

/**
 * Inject the tenant field into a Mongoose schema, and (when `enabled` +
 * strategy === 'field') prepend it to every existing compound index so
 * queries are index-efficient under multi-tenant scoping. Matches the
 * order / people package pattern (PACKAGE_RULES §9.2, P11).
 */
export function injectTenantField(schema: Schema, tenant: ResolvedTenantConfig): void {
  const isFieldStrategy = tenant.strategy === 'field';
  const isObjectId = tenant.fieldType === 'objectId';

  schema.add({
    [tenant.tenantField]: {
      type: isObjectId ? mongoose.Schema.Types.ObjectId : String,
      ...(tenant.enabled && tenant.required ? { required: true } : {}),
      index: true,
      ...(isObjectId && tenant.ref ? { ref: tenant.ref } : {}),
    },
  });

  if (!tenant.enabled || !isFieldStrategy) return;

  const existingIndexes = (
    schema as unknown as {
      _indexes: Array<[Record<string, unknown>, Record<string, unknown>]>;
    }
  )._indexes;
  if (existingIndexes && existingIndexes.length > 0) {
    for (const indexEntry of existingIndexes) {
      const fields = indexEntry[0];
      if (fields[tenant.tenantField] !== undefined) continue;
      const newFields: Record<string, unknown> = { [tenant.tenantField]: 1 };
      for (const [key, val] of Object.entries(fields)) {
        newFields[key] = val;
      }
      indexEntry[0] = newFields;
    }
  }
}
