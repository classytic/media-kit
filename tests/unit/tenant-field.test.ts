/**
 * Unit tests — tenantFieldDef helper
 */

import { describe, it, expect } from 'vitest';
import { Schema } from 'mongoose';
import { tenantFieldDef, DEFAULT_TENANT_CONFIG } from '../../src/models/tenant-field.js';

describe('tenantFieldDef', () => {
  it('defaults to string, not required', () => {
    const def = tenantFieldDef();
    expect(def.type).toBe(String);
    expect(def.required).toBe(false);
    expect(def.index).toBe(true);
  });

  it('returns ObjectId definition when fieldType is objectId', () => {
    const def = tenantFieldDef({ tenantFieldType: 'objectId', required: true });
    expect(def.type).toBe(Schema.Types.ObjectId);
    expect(def).toHaveProperty('ref', 'Organization');
    expect(def.required).toBe(true);
    expect(def.index).toBe(true);
  });

  it('returns String definition when fieldType is string', () => {
    const def = tenantFieldDef({ tenantFieldType: 'string', required: true });
    expect(def.type).toBe(String);
    expect(def).not.toHaveProperty('ref');
    expect(def.required).toBe(true);
  });

  it('honors required: false', () => {
    const def = tenantFieldDef({ tenantFieldType: 'objectId', required: false });
    expect(def.required).toBe(false);
  });

  it('has sensible DEFAULT_TENANT_CONFIG', () => {
    expect(DEFAULT_TENANT_CONFIG.tenantFieldType).toBe('string');
    expect(DEFAULT_TENANT_CONFIG.required).toBe(false);
  });
});
