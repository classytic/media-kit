import { afterAll, describe, expect, it } from 'vitest';
import { createTestEngine, type TestEngineHandle } from '../helpers/create-test-engine.js';

/**
 * The purge sweeps must drain a backlog in ONE call. They used to read a single `getAll()` page (10
 * rows), so a daily cron removed ten rows a day and storage objects behind the rest leaked.
 */
describe('purge sweeps drain a backlog larger than one page', () => {
  let h: TestEngineHandle | undefined;
  afterAll(async () => {
    await h?.cleanup();
  });

  const row = (i: number, extra: Record<string, unknown>) => ({
    filename: `f${i}.jpg`,
    originalFilename: `f${i}.jpg`,
    mimeType: 'image/jpeg',
    size: 1,
    url: `u${i}`,
    key: `general/${extra.status}-${i}.jpg`,
    hash: `h${extra.status}${i}`,
    folder: 'general',
    ...extra,
  });

  it('purgeDeleted removes every soft-deleted row past the cutoff, not one page', async () => {
    h = await createTestEngine({ softDelete: { enabled: true, ttlDays: 1 } } as never);
    const Media = h.engine.models.Media;
    const old = new Date(Date.now() - 5 * 86_400_000);
    await Media.collection.insertMany(
      Array.from({ length: 250 }, (_, i) =>
        row(i, { status: 'ready', deletedAt: old, createdAt: old, updatedAt: old }),
      ) as never,
    );
    const purged = await h.engine.repositories.media.purgeDeleted();
    expect(purged).toBe(250);
    expect(await Media.collection.countDocuments({ deletedAt: { $ne: null } })).toBe(0);
  }, 120_000);

  it('purgeDeleted leaves rows still inside the retention window', async () => {
    const Media = h!.engine.models.Media;
    const recent = new Date();
    await Media.collection.insertMany(
      Array.from({ length: 15 }, (_, i) =>
        row(1000 + i, { status: 'ready', deletedAt: recent, createdAt: recent, updatedAt: recent }),
      ) as never,
    );
    expect(await h!.engine.repositories.media.purgeDeleted()).toBe(0);
    expect(await Media.collection.countDocuments({ deletedAt: { $ne: null } })).toBe(15);
  });

  it('purgeStalePending removes every stale pending row, not one page', async () => {
    const Media = h!.engine.models.Media;
    await Media.collection.deleteMany({});
    const old = new Date(Date.now() - 3 * 86_400_000);
    await Media.collection.insertMany(
      Array.from({ length: 130 }, (_, i) =>
        row(2000 + i, { status: 'pending', deletedAt: null, createdAt: old, updatedAt: old }),
      ) as never,
    );
    expect(await h!.engine.repositories.media.purgeStalePending()).toBe(130);
    expect(await Media.collection.countDocuments({ status: 'pending' })).toBe(0);
  }, 120_000);
});
