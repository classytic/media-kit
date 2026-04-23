/**
 * Unit tests — resolveMediaTenant + injectTenantField (P11)
 */

import { describe, it, expect } from 'vitest';
import mongoose, { Schema } from 'mongoose';
import {
  resolveMediaTenant,
  injectTenantField,
} from '../../src/models/inject-tenant.js';

describe('resolveMediaTenant', () => {
  it('applies media-kit defaults (string, not required) on empty input', () => {
    const resolved = resolveMediaTenant();
    expect(resolved.enabled).toBe(true);
    expect(resolved.strategy).toBe('field');
    expect(resolved.fieldType).toBe('string');
    expect(resolved.required).toBe(false);
    expect(resolved.tenantField).toBe('organizationId');
  });

  it('honours explicit objectId + required', () => {
    const resolved = resolveMediaTenant({ fieldType: 'objectId', required: true });
    expect(resolved.fieldType).toBe('objectId');
    expect(resolved.required).toBe(true);
    expect(resolved.ref).toBe('organization');
  });

  it('disables scoping on `false`', () => {
    const resolved = resolveMediaTenant(false);
    expect(resolved.enabled).toBe(false);
    expect(resolved.strategy).toBe('none');
  });

  it('accepts legacy shorthand { tenantFieldType, multiTenant }', () => {
    const resolved = resolveMediaTenant({ tenantFieldType: 'objectId', multiTenant: true });
    expect(resolved.enabled).toBe(true);
    expect(resolved.fieldType).toBe('objectId');
  });

  it('translates multiTenant: false in legacy shorthand to disabled', () => {
    const resolved = resolveMediaTenant({ tenantFieldType: 'string', multiTenant: false });
    expect(resolved.enabled).toBe(false);
  });
});

describe('injectTenantField', () => {
  it('adds a String field when fieldType is string', () => {
    const schema = new Schema({ filename: String });
    injectTenantField(
      schema,
      resolveMediaTenant({ fieldType: 'string', required: false }),
    );
    const path = schema.path('organizationId') as any;
    expect(path).toBeDefined();
    expect(path.instance).toBe('String');
    expect(path.options.required).toBeUndefined();
  });

  it('adds an ObjectId field with ref when fieldType is objectId', () => {
    const schema = new Schema({ filename: String });
    injectTenantField(
      schema,
      resolveMediaTenant({ fieldType: 'objectId', required: true, ref: 'Organization' }),
    );
    const path = schema.path('organizationId') as any;
    expect(path).toBeDefined();
    expect(path.instance).toBe('ObjectId');
    expect(path.options.ref).toBe('Organization');
    expect(path.options.required).toBe(true);
  });

  it('prepends tenant key to existing compound indexes', () => {
    const schema = new Schema({ status: String, folder: String });
    schema.index({ folder: 1, status: 1 });
    injectTenantField(schema, resolveMediaTenant());

    const indexes = (schema as any)._indexes as Array<[Record<string, unknown>, unknown]>;
    const compound = indexes.find(([keys]) => 'folder' in keys && 'status' in keys);
    expect(compound).toBeDefined();
    const fields = Object.keys(compound![0]);
    expect(fields[0]).toBe('organizationId');
  });

  it('skips index prepending when scoping disabled', () => {
    const schema = new Schema({ status: String });
    schema.index({ status: 1 });
    injectTenantField(schema, resolveMediaTenant(false));

    const indexes = (schema as any)._indexes as Array<[Record<string, unknown>, unknown]>;
    const original = indexes.find(([keys]) => 'status' in keys);
    expect(original).toBeDefined();
    expect(Object.keys(original![0])[0]).toBe('status');
  });
});
