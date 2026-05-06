/**
 * Integration tests — storage/DB consistency on key-rewrite flows.
 *
 * Regression tests for the corruption shape where a failed DB update
 * during executeKeyRewrite() left the document pointing at a deleted
 * old object (because phase 3 deleted old keys regardless of which
 * updates landed). The new design tracks per-file lifecycle and only
 * deletes old keys for files whose DB update succeeded; failed updates
 * roll back the orphaned new copy instead.
 *
 * Invariant under test: at every step, every document's `key` field
 * points to an object that exists in storage. Storage and DB never
 * diverge — even when individual updates fail.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestEngine,
  teardownTestMongo,
  type TestEngineHandle,
} from '../helpers/create-test-engine.js';

const BUF = (s: string) => Buffer.from(s, 'utf-8');

describe('Storage/DB consistency — executeKeyRewrite + bulkUpdateMedia', () => {
  afterAll(async () => {
    await teardownTestMongo();
  });

  let handle: TestEngineHandle;

  beforeEach(async () => {
    handle = await createTestEngine();
  });

  afterEach(async () => {
    await handle.cleanup();
  });

  async function uploadOne(name: string, folder: string) {
    return handle.engine.repositories.media.upload({
      buffer: BUF(name),
      filename: name,
      mimeType: 'text/plain',
      folder,
    });
  }

  it('bulkUpdateMedia returns succeededIds Set + per-id failures', async () => {
    const a = await uploadOne('a.txt', 'products');
    const b = await uploadOne('b.txt', 'products');

    const result = await handle.engine.repositories.media.bulkUpdateMedia([
      { id: String(a._id), data: { folder: 'updated' } },
      { id: String(b._id), data: { folder: 'updated' } },
      { id: '6543210fedcba9876543210f', data: { folder: 'will-not-find' } },
    ]);

    expect(result.modifiedCount).toBe(2);
    expect(result.succeededIds.has(String(a._id))).toBe(true);
    expect(result.succeededIds.has(String(b._id))).toBe(true);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].id).toBe('6543210fedcba9876543210f');
  });

  it('move() with all-successful updates: old keys deleted, new keys exist', async () => {
    const a = await uploadOne('a.txt', 'products');
    const b = await uploadOne('b.txt', 'products');
    const oldKeyA = a.key;
    const oldKeyB = b.key;

    const result = await handle.engine.repositories.media.move(
      [String(a._id), String(b._id)],
      'archive',
    );

    expect(result.modifiedCount).toBe(2);
    expect(result.failed).toHaveLength(0);

    // Old keys gone, new keys exist
    expect(handle.driver.getBuffer(oldKeyA)).toBeUndefined();
    expect(handle.driver.getBuffer(oldKeyB)).toBeUndefined();

    const after = await handle.engine.repositories.media.getById(String(a._id));
    expect(after).not.toBeNull();
    expect(after!.folder).toBe('archive');
    // The DB key now points to a real object
    expect(handle.driver.getBuffer(after!.key)).toBeDefined();
  });

  it('move() rolls back orphaned new copies when DB update fails for a file', async () => {
    const a = await uploadOne('a.txt', 'products');
    const b = await uploadOne('b.txt', 'products');
    const oldKeyA = a.key;
    const oldKeyB = b.key;

    // Sabotage the update path so file A's update fails. We patch the
    // repo's update() to throw for file A, leave B alone.
    const repo = handle.engine.repositories.media;
    const realUpdate = repo.update.bind(repo);
    let calls = 0;
    (repo as unknown as { update: typeof realUpdate }).update = async (
      id: string,
      data: Record<string, unknown>,
      opts: unknown,
    ) => {
      calls++;
      if (id === String(a._id)) {
        throw new Error('Simulated DB failure for file A');
      }
      return realUpdate(id, data as never, opts as never);
    };

    try {
      const result = await handle.engine.repositories.media.move(
        [String(a._id), String(b._id)],
        'archive',
      );

      // B succeeded, A failed
      expect(result.modifiedCount).toBe(1);
      expect(result.failed).toHaveLength(1);
      expect(result.failed[0].id).toBe(String(a._id));

      // Document A still points at its ORIGINAL key (DB unchanged)
      const docA = await handle.engine.repositories.media.getById(String(a._id));
      expect(docA).not.toBeNull();
      expect(docA!.key).toBe(oldKeyA);
      // ...and that ORIGINAL key still exists in storage (NOT deleted by phase 3a)
      expect(handle.driver.getBuffer(oldKeyA)).toBeDefined();

      // Document B moved successfully — old key gone, new key exists
      const docB = await handle.engine.repositories.media.getById(String(b._id));
      expect(docB).not.toBeNull();
      expect(docB!.folder).toBe('archive');
      expect(handle.driver.getBuffer(oldKeyB)).toBeUndefined();
      expect(handle.driver.getBuffer(docB!.key)).toBeDefined();

      // CRUCIAL: no orphan new-copy for A in storage. Phase 3b cleaned it up.
      // We can't predict A's "would-be new key" exactly, but storage should
      // contain only: (oldKeyA, docB.newKey) — count is 2.
      expect(handle.driver.size).toBe(2);
      expect(calls).toBeGreaterThanOrEqual(2);
    } finally {
      (repo as unknown as { update: typeof realUpdate }).update = realUpdate;
    }
  });

  it('move() with all DB updates failing: no old keys deleted, no orphans linger', async () => {
    const a = await uploadOne('a.txt', 'products');
    const b = await uploadOne('b.txt', 'products');
    const oldKeyA = a.key;
    const oldKeyB = b.key;

    const repo = handle.engine.repositories.media;
    const realUpdate = repo.update.bind(repo);
    (repo as unknown as { update: typeof realUpdate }).update = async () => {
      throw new Error('Simulated total DB failure');
    };

    try {
      const result = await handle.engine.repositories.media.move(
        [String(a._id), String(b._id)],
        'archive',
      );
      expect(result.modifiedCount).toBe(0);
      expect(result.failed).toHaveLength(2);

      // Both docs still reference their original keys
      const docA = await handle.engine.repositories.media.getById(String(a._id));
      const docB = await handle.engine.repositories.media.getById(String(b._id));
      expect(docA!.key).toBe(oldKeyA);
      expect(docB!.key).toBe(oldKeyB);
      // Both original objects still exist
      expect(handle.driver.getBuffer(oldKeyA)).toBeDefined();
      expect(handle.driver.getBuffer(oldKeyB)).toBeDefined();
      // No orphan new copies
      expect(handle.driver.size).toBe(2);
    } finally {
      (repo as unknown as { update: typeof realUpdate }).update = realUpdate;
    }
  });
});
