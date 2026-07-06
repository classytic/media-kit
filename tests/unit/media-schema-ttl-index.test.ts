/**
 * Unit tests — soft-delete TTL index is OPT-IN (ttlIndex: true)
 *
 * Mongo's TTL sweeper deletes DOCUMENTS with no hooks, so the storage blob
 * would be orphaned. The default contract (since 3.4.0) is therefore NO TTL
 * index unless the host explicitly opts in with `softDelete.ttlIndex: true`;
 * the supported cleanup path is a purgeDeleted() cron (storage + DB).
 */

import { describe, it, expect } from 'vitest';
import { buildMediaSchema } from '../../src/models/media.schema.js';

/** Return the [keys, options] entries of TTL indexes declared on `deletedAt`. */
function ttlIndexesOnDeletedAt(schema: ReturnType<typeof buildMediaSchema>) {
  return schema
    .indexes()
    .filter(
      ([keys, options]) =>
        Object.keys(keys).length === 1 &&
        (keys as Record<string, unknown>).deletedAt !== undefined &&
        (options as Record<string, unknown> | undefined)?.expireAfterSeconds !== undefined,
    );
}

describe('buildMediaSchema — soft-delete TTL index (opt-in)', () => {
  it('default config → no TTL index on deletedAt', () => {
    const schema = buildMediaSchema();
    expect(ttlIndexesOnDeletedAt(schema)).toHaveLength(0);
  });

  it('softDelete enabled with ttlDays but WITHOUT ttlIndex → no TTL index (new default contract)', () => {
    const schema = buildMediaSchema({ softDelete: { enabled: true, ttlDays: 30 } });
    expect(ttlIndexesOnDeletedAt(schema)).toHaveLength(0);
  });

  it('softDelete.ttlIndex: true → TTL index with expireAfterSeconds = ttlDays * 86400', () => {
    const schema = buildMediaSchema({ softDelete: { enabled: true, ttlDays: 30, ttlIndex: true } });
    const ttl = ttlIndexesOnDeletedAt(schema);
    expect(ttl).toHaveLength(1);
    const [, options] = ttl[0]!;
    expect((options as Record<string, unknown>).expireAfterSeconds).toBe(30 * 86400);
    // Partial filter keeps the sweeper off non-deleted docs
    expect((options as Record<string, unknown>).partialFilterExpression).toEqual({
      deletedAt: { $type: 'date' },
    });
  });

  it('ttlIndex: true still requires ttlDays > 0', () => {
    const schema = buildMediaSchema({ softDelete: { enabled: true, ttlDays: 0, ttlIndex: true } });
    expect(ttlIndexesOnDeletedAt(schema)).toHaveLength(0);
  });

  it('ttlIndex: true without softDelete.enabled → no TTL index', () => {
    const schema = buildMediaSchema({ softDelete: { enabled: false, ttlDays: 30, ttlIndex: true } });
    expect(ttlIndexesOnDeletedAt(schema)).toHaveLength(0);
  });

  it('ttlIndex: true with tenant scoping → TTL index stays single-field (never tenant-prefixed)', async () => {
    // Mongo rejects compound TTL indexes — injectTenantField must NOT prepend
    // the tenant key to the deletedAt TTL index.
    const { resolveMediaTenant } = await import('../../src/models/inject-tenant.js');
    const schema = buildMediaSchema({
      tenant: resolveMediaTenant({ enabled: true }),
      softDelete: { enabled: true, ttlDays: 30, ttlIndex: true },
    });
    const ttl = schema
      .indexes()
      .filter(([, options]) => (options as Record<string, unknown> | undefined)?.expireAfterSeconds !== undefined);
    expect(ttl).toHaveLength(1);
    expect(Object.keys(ttl[0]![0])).toEqual(['deletedAt']);
  });
});
