import { afterAll, describe, expect, it } from 'vitest';
import { createTestEngine, type TestEngineHandle } from '../helpers/create-test-engine.js';

/**
 * The index set is a write-cost decision (every insert maintains every index), so it is pinned.
 * Measured on tenant-scoped lists of 3 x 40k rows: the planner never chose a tenant-blind `mimeType`,
 * `visibility`, `tags`, `provider` or `uploadedBy` index (it used `{tenant, createdAt, _id}`), the text index
 * served no query (list search is a regex), and dropping both roughly halved insert time.
 */
const TENANT = { enabled: true, fieldType: 'string', tenantField: 'organizationId', required: true } as const;
const DROPPED_WHEN_SCOPED = ['mimeType_1', 'visibility_1', 'tags_1', 'provider_1', 'uploadedBy_1'];

const names = (h: TestEngineHandle) =>
  h.engine.models.Media.schema.indexes().map(([f, o]) =>
    String(
      o?.name ??
        Object.entries(f)
          .map(([k, v]) => `${k}_${v}`)
          .join('_'),
    ),
  );

describe('media index set', () => {
  const made: TestEngineHandle[] = [];
  afterAll(async () => {
    for (const h of made) await h.cleanup();
  });
  const engine = async (opts: Parameters<typeof createTestEngine>[0]) => {
    const h = await createTestEngine(opts);
    made.push(h);
    return h;
  };

  it('tenant-scoped: no tenant-blind filter indexes, no text index, and a tenant-led filename index', async () => {
    const n = names(await engine({ tenant: TENANT }));
    for (const dropped of DROPPED_WHEN_SCOPED) expect(n, dropped).not.toContain(dropped);
    expect(n).not.toContain('filename_1');
    expect(n).not.toContain('media_text_search');
    expect(n).toContain('organizationId_1_filename_1');
    // still there: dedupe, attachments, expiry, the tenant compounds and the key claim
    for (const kept of ['hash_1', 'sourceId_1', 'sourceModel_1', 'expiresAt_1', 'media_key_tenant_unique'])
      expect(n, kept).toContain(kept);
  });

  it('tenancy off: the single-field indexes are unchanged (there is no tenant to lead them)', async () => {
    const n = names(await engine({ tenant: false }));
    for (const kept of ['filename_1', ...DROPPED_WHEN_SCOPED]) expect(n, kept).toContain(kept);
    expect(n).not.toContain('media_text_search');
  });

  it('schemaOptions.textIndex: true builds the text index, for a host that calls $text', async () => {
    const scoped = names(await engine({ tenant: TENANT, schemaOptions: { textIndex: true } }));
    const unscoped = names(await engine({ tenant: false, schemaOptions: { textIndex: true } }));
    expect(scoped).toContain('media_text_search');
    expect(unscoped).toContain('media_text_search');
  });

  it('an exact filename lookup inside a tenant uses the tenant-led index, not a tenant-wide scan', async () => {
    const h = await engine({ tenant: TENANT });
    const Media = h.engine.models.Media;
    await Media.createIndexes();
    const base = {
      originalFilename: 'x',
      mimeType: 'image/png',
      size: 1,
      url: 'u',
      status: 'ready',
      folder: 'f',
      visibility: 'private',
    };
    await Media.collection.insertMany(
      Array.from({ length: 300 }, (_, i) => ({
        ...base,
        organizationId: i % 2 ? 'org_a' : 'org_b',
        filename: `f${i}.png`,
        key: `f/__t-o/${i}.png`,
        hash: `h${i}`,
      })) as never,
    );
    const ex = (await Media.collection
      .find({ organizationId: 'org_a', filename: 'f1.png' })
      .explain('executionStats')) as {
      executionStats: { totalKeysExamined: number; totalDocsExamined: number };
      queryPlanner: { winningPlan: object };
    };
    expect(JSON.stringify(ex.queryPlanner.winningPlan)).toContain('organizationId_1_filename_1');
    expect(ex.executionStats.totalDocsExamined).toBe(1);
  });
});
