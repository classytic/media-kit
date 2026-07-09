/**
 * Unit tests — per-file provider routing in the ops layer.
 *
 * Covers the multi-provider data-integrity fix:
 *   - withDriver(): rebinds OperationDeps.driver while preserving the lazy
 *     `processor` getter (the repository nulls it out after processorReady).
 *   - executeKeyRewrite(): resolves the driver PER FILE from `file.provider`
 *     (files in one folder can span providers), including copy, delete,
 *     orphan rollback, and wholesale DB-failure rollback — each through the
 *     owning file's driver.
 */

import { describe, it, expect } from 'vitest';
import { executeKeyRewrite, withDriver, type RewritableFile } from '../../src/operations/helpers';
import type { OperationDeps, InternalEventEmitter } from '../../src/operations/types';
import type { MediaRepository } from '../../src/repositories/media.repository';
import type { ResolvedMediaConfig } from '../../src/engine/engine-types';
import { DriverRegistry } from '../../src/providers/driver-registry';
import { Semaphore } from '../../src/utils/semaphore';
import { MemoryStorageDriver } from '../helpers/memory-driver';

const noopEvents: InternalEventEmitter = {
  emit: async () => {},
  on: () => () => {},
  removeAllListeners: () => {},
  listenerCount: () => 0,
};

type BulkUpdate = Array<{ id: string; data: Record<string, unknown> }>;
type BulkResult = { modifiedCount: number; succeededIds: Set<string>; failed: Array<{ id: string; reason: string }> };

/** Fake repository — only the method executeKeyRewrite touches. */
function fakeRepository(bulkUpdateMedia: (updates: BulkUpdate) => Promise<BulkResult>): MediaRepository {
  return { bulkUpdateMedia } as unknown as MediaRepository;
}

function makeDeps(
  registry: DriverRegistry,
  repository: MediaRepository,
  overrides: Partial<OperationDeps> = {},
): OperationDeps {
  return {
    config: {} as ResolvedMediaConfig,
    driver: registry.defaultDriver,
    registry,
    repository,
    processor: null,
    processorReady: null,
    events: noopEvents,
    uploadSemaphore: new Semaphore(4),
    logger: undefined,
    ...overrides,
  };
}

function file(id: string, key: string, folder: string, provider?: string): RewritableFile {
  return { _id: { toString: () => id }, key, folder, provider };
}

const allSucceed = async (updates: BulkUpdate): Promise<BulkResult> => ({
  modifiedCount: updates.length,
  succeededIds: new Set(updates.map((u) => u.id)),
  failed: [],
});

async function keysOf(driver: MemoryStorageDriver): Promise<string[]> {
  const out: string[] = [];
  for await (const k of driver.list('')) out.push(k);
  return out.sort();
}

describe('withDriver()', () => {
  it('returns the same deps object when the driver is already bound', () => {
    const registry = DriverRegistry.fromSingle(new MemoryStorageDriver());
    const deps = makeDeps(registry, fakeRepository(allSucceed));
    expect(withDriver(deps, registry.defaultDriver)).toBe(deps);
  });

  it('rebinds only the driver; everything else is shared', () => {
    const primary = new MemoryStorageDriver();
    const secondary = new MemoryStorageDriver();
    const registry = new DriverRegistry({ primary, secondary }, 'primary');
    const deps = makeDeps(registry, fakeRepository(allSucceed));

    const bound = withDriver(deps, secondary);
    expect(bound).not.toBe(deps);
    expect(bound.driver).toBe(secondary);
    expect(deps.driver).toBe(primary); // original untouched
    expect(bound.registry).toBe(deps.registry);
    expect(bound.repository).toBe(deps.repository);
    expect(bound.uploadSemaphore).toBe(deps.uploadSemaphore);
    expect(bound.events).toBe(deps.events);
  });

  it('preserves the LAZY processor getter (late null-out is visible)', () => {
    const primary = new MemoryStorageDriver();
    const secondary = new MemoryStorageDriver();
    const registry = new DriverRegistry({ primary, secondary }, 'primary');

    // Mimic MediaRepository._opDepsWith: processor read lazily from a
    // mutable slot (processorReady may null it after construction).
    const slot: { processor: OperationDeps['processor'] } = {
      processor: { process: async () => ({ buffer: Buffer.alloc(0), mimeType: 'x', width: 1, height: 1 }), isProcessable: () => true },
    };
    const deps: OperationDeps = {
      ...makeDeps(registry, fakeRepository(allSucceed)),
      get processor() {
        return slot.processor;
      },
    };

    const bound = withDriver(deps, secondary);
    expect(bound.processor).toBe(slot.processor);
    slot.processor = null; // sharp turned out to be unavailable
    expect(bound.processor).toBeNull();
  });
});

describe('executeKeyRewrite() — per-file provider routing', () => {
  it('copies + deletes each file (and variants) within ITS OWN driver', async () => {
    const primary = new MemoryStorageDriver();
    const secondary = new MemoryStorageDriver();
    const registry = new DriverRegistry({ primary, secondary }, 'primary');

    await primary.write('old/a.png', Buffer.from('a-main'), 'image/png');
    await primary.write('old/a-thumb.png', Buffer.from('a-thumb'), 'image/png');
    await secondary.write('old/b.png', Buffer.from('b-main'), 'image/png');
    await secondary.write('old/b-thumb.png', Buffer.from('b-thumb'), 'image/png');

    const files: RewritableFile[] = [
      {
        ...file('a', 'old/a.png', 'old', 'primary'),
        variants: [{ name: 'thumb', key: 'old/a-thumb.png', url: 'u', filename: 'a-thumb.png', mimeType: 'image/png', size: 7 }],
      },
      {
        ...file('b', 'old/b.png', 'old', 'secondary'),
        variants: [{ name: 'thumb', key: 'old/b-thumb.png', url: 'u', filename: 'b-thumb.png', mimeType: 'image/png', size: 7 }],
      },
    ];

    const deps = makeDeps(registry, fakeRepository(allSucceed));
    const result = await executeKeyRewrite(
      deps,
      files,
      (f) => ({ newKey: `new/${f.key.split('/').pop()}`, newFolder: 'new' }),
      (variantKey) => `new/${variantKey.split('/').pop()}`,
      'progress:move',
    );

    expect(result.failed).toEqual([]);
    expect(result.modifiedCount).toBe(2);
    // a's objects moved WITHIN primary; b's WITHIN secondary — no leakage
    expect(await keysOf(primary)).toEqual(['new/a-thumb.png', 'new/a.png']);
    expect(await keysOf(secondary)).toEqual(['new/b-thumb.png', 'new/b.png']);
    expect(primary.getBuffer('new/a.png')?.toString()).toBe('a-main');
    expect(secondary.getBuffer('new/b.png')?.toString()).toBe('b-main');
  });

  it('falls back to the DEFAULT driver for pre-multi-provider docs (no provider field)', async () => {
    const primary = new MemoryStorageDriver();
    const secondary = new MemoryStorageDriver();
    const registry = new DriverRegistry({ primary, secondary }, 'primary');
    await primary.write('old/legacy.png', Buffer.from('legacy'), 'image/png');

    const deps = makeDeps(registry, fakeRepository(allSucceed));
    const result = await executeKeyRewrite(
      deps,
      [file('l', 'old/legacy.png', 'old')],
      (f) => ({ newKey: `new/${f.key.split('/').pop()}`, newFolder: 'new' }),
      (k) => k,
      'progress:move',
    );

    expect(result.failed).toEqual([]);
    expect(await keysOf(primary)).toEqual(['new/legacy.png']);
    expect(secondary.size).toBe(0);
  });

  it('per-file DB failure rolls back the new copies through the owning driver', async () => {
    const primary = new MemoryStorageDriver();
    const secondary = new MemoryStorageDriver();
    const registry = new DriverRegistry({ primary, secondary }, 'primary');

    await primary.write('old/a.png', Buffer.from('a'), 'image/png');
    await secondary.write('old/b.png', Buffer.from('b'), 'image/png');

    // b's DB update fails; a's succeeds
    const repo = fakeRepository(async (updates) => ({
      modifiedCount: updates.length - 1,
      succeededIds: new Set(updates.map((u) => u.id).filter((id) => id !== 'b')),
      failed: [{ id: 'b', reason: 'write conflict' }],
    }));

    const deps = makeDeps(registry, repo);
    const result = await executeKeyRewrite(
      deps,
      [file('a', 'old/a.png', 'old', 'primary'), file('b', 'old/b.png', 'old', 'secondary')],
      (f) => ({ newKey: `new/${f.key.split('/').pop()}`, newFolder: 'new' }),
      (k) => k,
      'progress:move',
    );

    expect(result.modifiedCount).toBe(1);
    expect(result.failed).toEqual([{ id: 'b', reason: 'write conflict' }]);
    // a landed: old deleted, new present — all in primary
    expect(await keysOf(primary)).toEqual(['new/a.png']);
    // b rolled back IN SECONDARY: new copy removed, old key still live
    expect(await keysOf(secondary)).toEqual(['old/b.png']);
  });

  it('wholesale DB throw rolls back EVERY copied key through each file\'s own driver', async () => {
    const primary = new MemoryStorageDriver();
    const secondary = new MemoryStorageDriver();
    const registry = new DriverRegistry({ primary, secondary }, 'primary');

    await primary.write('old/a.png', Buffer.from('a'), 'image/png');
    await secondary.write('old/b.png', Buffer.from('b'), 'image/png');

    const repo = fakeRepository(async () => {
      throw new Error('db down');
    });

    const deps = makeDeps(registry, repo);
    await expect(
      executeKeyRewrite(
        deps,
        [file('a', 'old/a.png', 'old', 'primary'), file('b', 'old/b.png', 'old', 'secondary')],
        (f) => ({ newKey: `new/${f.key.split('/').pop()}`, newFolder: 'new' }),
        (k) => k,
        'progress:move',
      ),
    ).rejects.toThrow('db down');

    // Storage exactly as before — old keys alive, no new copies anywhere
    expect(await keysOf(primary)).toEqual(['old/a.png']);
    expect(await keysOf(secondary)).toEqual(['old/b.png']);
  });

  it('unknown provider on one file fails ONLY that file; others proceed', async () => {
    const primary = new MemoryStorageDriver();
    const registry = new DriverRegistry({ primary }, 'primary');
    await primary.write('old/a.png', Buffer.from('a'), 'image/png');

    const deps = makeDeps(registry, fakeRepository(allSucceed));
    const result = await executeKeyRewrite(
      deps,
      [file('a', 'old/a.png', 'old', 'primary'), file('ghost', 'old/ghost.png', 'old', 'gone-bucket')],
      (f) => ({ newKey: `new/${f.key.split('/').pop()}`, newFolder: 'new' }),
      (k) => k,
      'progress:move',
    );

    expect(result.modifiedCount).toBe(1);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]!.id).toBe('ghost');
    expect(result.failed[0]!.reason).toMatch(/Unknown provider "gone-bucket"/);
    expect(await keysOf(primary)).toEqual(['new/a.png']);
  });

  it('external (reference-only) records take the DB-only branch — no driver resolution', async () => {
    const primary = new MemoryStorageDriver();
    const registry = new DriverRegistry({ primary }, 'primary');
    // 'external' is NOT a registered driver — resolving it would throw.
    const updates: BulkUpdate[] = [];
    const repo = fakeRepository(async (u) => {
      updates.push(u);
      return allSucceed(u);
    });

    const deps = makeDeps(registry, repo);
    const result = await executeKeyRewrite(
      deps,
      [file('x', '__external__/abcdef0123456789', 'old', 'external')],
      () => ({ newKey: 'new/never-used.png', newFolder: 'new' }),
      (k) => k,
      'progress:move',
    );

    expect(result.failed).toEqual([]);
    expect(result.modifiedCount).toBe(1);
    // Folder-only update; the sentinel key was never rewritten or copied
    expect(updates[0]).toEqual([{ id: 'x', data: { folder: 'new' } }]);
    expect(primary.size).toBe(0);
  });
});
