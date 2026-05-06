/**
 * Mongoose-specific adapter around `resolveTenantConfig()` from
 * `@classytic/repo-core/tenant`. The pure resolution lives in repo-core
 * (zero runtime deps) — this file only handles the Mongoose schema
 * mutations (add field, prepend tenant to indexes) that repo-core can't
 * own without a mongoose dependency.
 *
 * media-kit's historical defaults differ from repo-core's: `fieldType:
 * 'string'` and `required: false` (hosts may issue UUID/slug orgIds and the
 * field is optional by default). Those defaults are applied in
 * `resolveMediaTenant()` before the input reaches repo-core.
 */
import mongoose, { type Schema } from 'mongoose';
import {
  resolveTenantConfig,
  type ResolvedTenantConfig,
  type TenantConfig,
} from '@classytic/repo-core/tenant';

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
 * Media-kit's package-level tenant defaults. **Diverges from repo-core's
 * defaults intentionally:** repo-core defaults to `fieldType: 'objectId'`
 * + `required: true` (the multi-tenant SaaS norm), but media-kit serves
 * a wider range of hosts including UUID / slug-based identity systems
 * and apps where uploads are valid without an organization (anonymous
 * uploads, system-generated assets, etc.).
 *
 * Centralized here so:
 *   - Drift between repo-core's defaults and ours is easy to spot
 *     (one source of truth, one diff target on a `repo-core` upgrade)
 *   - Hosts grepping for `'string'` / `required: false` find the seam
 *   - Tests can import + assert the contract
 */
export const MEDIA_KIT_TENANT_DEFAULTS: {
  readonly fieldType: 'string';
  readonly required: false;
} = Object.freeze({
  fieldType: 'string',
  required: false,
});

/**
 * Resolve a possibly-partial tenant input.
 *
 * Defaults flow as: caller-supplied → `MEDIA_KIT_TENANT_DEFAULTS` →
 * repo-core's `resolveTenantConfig`. media-kit's defaults are passed
 * INTO `resolveTenantConfig`, not applied after, so repo-core remains
 * the single canonical resolver — we only steer where repo-core would
 * otherwise pick a stricter default. Flip to `fieldType: 'objectId'`
 * when your auth system issues ObjectIds and you want `$lookup` /
 * `.populate()` on the `organizationId` field.
 */
export function resolveMediaTenant(input: MediaTenantInput = {}): ResolvedTenantConfig {
  if (typeof input === 'boolean') {
    // `false` → scoping disabled entirely (repo-core handles).
    // `true`  → enable with media-kit defaults.
    if (input === false) return resolveTenantConfig(false);
    return resolveTenantConfig({ enabled: true, ...MEDIA_KIT_TENANT_DEFAULTS });
  }

  // Legacy shorthand — translate to TenantConfig.
  if ('tenantFieldType' in input || 'multiTenant' in input) {
    const legacy = input as { tenantFieldType?: 'objectId' | 'string'; multiTenant?: boolean };
    return resolveTenantConfig({
      enabled: legacy.multiTenant !== false,
      fieldType: legacy.tenantFieldType ?? MEDIA_KIT_TENANT_DEFAULTS.fieldType,
      required: MEDIA_KIT_TENANT_DEFAULTS.required,
    });
  }

  // Canonical TenantConfig — fill caller-omitted slots with media-kit
  // defaults so repo-core sees the final values up-front.
  const config = input as TenantConfig;
  return resolveTenantConfig({
    ...config,
    fieldType: config.fieldType ?? MEDIA_KIT_TENANT_DEFAULTS.fieldType,
    required: config.required ?? MEDIA_KIT_TENANT_DEFAULTS.required,
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
