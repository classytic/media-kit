/**
 * Unit tests — processImage storage-orphan cleanup + onWrite collector.
 *
 * processImage writes storage objects INCREMENTALLY (`__original` before
 * processing, size variants inside the loop, video thumbnails) but callers
 * only learn the written keys from the RETURN value. The orphan fix makes
 * processImage own cleanup of its own writes on ANY internal failure —
 * the documented swallow-fallback ("On processing failure, returns the
 * original buffer unchanged") must leave ZERO written keys behind and a
 * variants list that never references a deleted object — and exposes an
 * `onWrite` collector so callers can roll back the post-return window.
 */

import { describe, it, expect } from 'vitest';
import { processImage } from '../../src/operations/process-image';
import type { OperationDeps } from '../../src/operations/types';
import type { MediaRepository } from '../../src/repositories/media.repository';
import type { ResolvedMediaConfig } from '../../src/engine/engine-types';
import type {
  ImageAdapter,
  MediaKitLogger,
  ProcessedImage,
  ProcessingOptions,
  SizeVariant,
  VideoAdapter,
  WriteResult,
} from '../../src/types';
import { DriverRegistry } from '../../src/providers/driver-registry';
import { Semaphore } from '../../src/utils/semaphore';
import { MemoryStorageDriver } from '../helpers/memory-driver';

const PNG = Buffer.from('89504e470d0a1a0a-fake-png-bytes-for-unit-tests');

/** Deterministic adapter — echoes the buffer, fixed dimensions, one buffer per size. */
class StubImageAdapter implements ImageAdapter {
  async process(buffer: Buffer, _options: ProcessingOptions): Promise<ProcessedImage> {
    return { buffer, mimeType: 'image/png', width: 100, height: 50 };
  }
  isProcessable(): boolean {
    return true;
  }
  async getDimensions(): Promise<{ width: number; height: number }> {
    return { width: 100, height: 50 };
  }
  async generateVariants(
    buffer: Buffer,
    variants: SizeVariant[],
  ): Promise<Array<ProcessedImage & { variantName: string }>> {
    return variants.map((v) => ({
      buffer,
      mimeType: 'image/png',
      width: v.width ?? 10,
      height: 10,
      variantName: v.name,
    }));
  }
}

/** Adapter whose main process() call fails AFTER `__original` was written. */
class ThrowingProcessAdapter extends StubImageAdapter {
  async process(): Promise<ProcessedImage> {
    throw new Error('forced process failure');
  }
}

/** Memory driver with per-key write/delete failure injection. */
class SelectiveFailDriver extends MemoryStorageDriver {
  failWrite: ((key: string) => boolean) | null = null;
  failDelete: ((key: string) => boolean) | null = null;

  async write(key: string, data: Buffer | NodeJS.ReadableStream, contentType: string): Promise<WriteResult> {
    if (this.failWrite?.(key)) throw new Error(`forced write failure: ${key}`);
    return super.write(key, data, contentType);
  }

  async delete(key: string): Promise<boolean> {
    if (this.failDelete?.(key)) throw new Error(`forced delete failure: ${key}`);
    return super.delete(key);
  }
}

interface WarnEntry {
  message: string;
  meta: Record<string, unknown> | undefined;
}

function collectingLogger(warns: WarnEntry[]): MediaKitLogger {
  return {
    info: () => {},
    warn: (message: string, meta?: Record<string, unknown>) => {
      warns.push({ message, meta });
    },
    error: () => {},
  };
}

function makeDeps(
  driver: SelectiveFailDriver,
  processing: NonNullable<ResolvedMediaConfig['processing']>,
  processor: ImageAdapter | null,
  logger?: MediaKitLogger,
): OperationDeps {
  return {
    config: { processing } as ResolvedMediaConfig,
    driver,
    registry: DriverRegistry.fromSingle(driver),
    // processImage never touches the repository — safe stand-in.
    repository: {} as unknown as MediaRepository,
    processor,
    processorReady: null,
    events: {
      emit: async () => {},
      on: () => () => {},
      removeAllListeners: () => {},
      listenerCount: () => 0,
    },
    uploadSemaphore: new Semaphore(4),
    logger,
  };
}

const PROCESSING: NonNullable<ResolvedMediaConfig['processing']> = {
  enabled: true,
  sizes: [
    { name: 'thumb', width: 100 },
    { name: 'large', width: 800 },
  ],
  originalHandling: 'keep-variant',
  smartSkip: false,
  thumbhash: false,
  dominantColor: false,
};

describe('processImage — onWrite collector', () => {
  it('reports every written key, in write order, matching the returned variants', async () => {
    const driver = new SelectiveFailDriver();
    const deps = makeDeps(driver, PROCESSING, new StubImageAdapter());

    const seen: string[] = [];
    const result = await processImage(deps, {
      buffer: PNG,
      filename: 'photo.png',
      mimeType: 'image/png',
      targetFolder: 'uploads',
      onWrite: (key) => {
        seen.push(key);
      },
    });

    // __original first (written BEFORE processing), then each size variant in order
    expect(seen).toHaveLength(3);
    expect(result.variants.map((v) => v.key)).toEqual(seen);
    expect(result.variants.map((v) => v.name)).toEqual(['__original', 'thumb', 'large']);
    expect(seen[0]).toContain('__original');
    for (const key of seen) {
      expect(await driver.exists(key)).toBe(true);
    }
    expect(driver.size).toBe(3);
  });

  it('reports a video thumbnail write', async () => {
    const driver = new SelectiveFailDriver();
    const videoAdapter: VideoAdapter = {
      extractThumbnail: async () => ({ buffer: Buffer.from('jpeg'), mimeType: 'image/jpeg', width: 32, height: 18 }),
      extractMetadata: async () => ({ duration: 2, width: 320, height: 180, codec: 'h264' }),
    };
    const deps = makeDeps(driver, { ...PROCESSING, videoAdapter }, new StubImageAdapter());

    const seen: string[] = [];
    const result = await processImage(deps, {
      buffer: Buffer.from('not-really-a-video'),
      filename: 'clip.mp4',
      mimeType: 'video/mp4',
      targetFolder: 'uploads',
      onWrite: (key) => {
        seen.push(key);
      },
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain('__thumbnail');
    expect(result.variants.map((v) => v.name)).toEqual(['__thumbnail']);
    expect(result.variants[0]?.key).toBe(seen[0]);
    expect(await driver.exists(seen[0]!)).toBe(true);
  });
});

describe('processImage — swallow-fallback cleans up its own writes', () => {
  it('process() throws AFTER __original was written → falls back per contract, storage clean', async () => {
    const driver = new SelectiveFailDriver();
    const deps = makeDeps(driver, PROCESSING, new ThrowingProcessAdapter());

    const seen: string[] = [];
    // Contract: swallow-and-fall-back — must NOT throw
    const result = await processImage(deps, {
      buffer: PNG,
      filename: 'photo.png',
      mimeType: 'image/png',
      targetFolder: 'uploads',
      onWrite: (key) => {
        seen.push(key);
      },
    });

    // The `__original` write DID happen (collector saw it at write time) ...
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain('__original');
    // ... but the fallback deleted it: zero orphaned keys, no deleted-key refs
    expect(driver.size).toBe(0);
    expect(result.variants).toEqual([]);
    // Original buffer returned unchanged
    expect(result.finalBuffer.equals(PNG)).toBe(true);
    expect(result.finalMimeType).toBe('image/png');
    expect(result.finalFilename).toBe('photo.png');
    // Dimensions re-derived from the ORIGINAL buffer
    expect(result.width).toBe(100);
    expect(result.height).toBe(50);
  });

  it('a size-variant write fails mid-loop → __original + earlier variants cleaned, fallback contract', async () => {
    const driver = new SelectiveFailDriver();
    // __original and thumb land; the SECOND size variant's write fails
    driver.failWrite = (key) => key.includes('-large');
    const deps = makeDeps(driver, PROCESSING, new StubImageAdapter());

    const seen: string[] = [];
    const result = await processImage(deps, {
      buffer: PNG,
      filename: 'photo.png',
      mimeType: 'image/png',
      targetFolder: 'uploads',
      onWrite: (key) => {
        seen.push(key);
      },
    });

    // Two writes landed before the failure ...
    expect(seen).toHaveLength(2);
    expect(seen[0]).toContain('__original');
    expect(seen[1]).toContain('-thumb');
    // ... and both were cleaned up; the result reverted to the original
    expect(driver.size).toBe(0);
    expect(result.variants).toEqual([]);
    expect(result.finalBuffer.equals(PNG)).toBe(true);
  });

  it('cleanup delete failures are logged as warnings and never rethrow', async () => {
    const warns: WarnEntry[] = [];
    const driver = new SelectiveFailDriver();
    driver.failWrite = (key) => key.includes('-large');
    driver.failDelete = (key) => key.includes('__original');
    const deps = makeDeps(driver, PROCESSING, new StubImageAdapter(), collectingLogger(warns));

    const result = await processImage(deps, {
      buffer: PNG,
      filename: 'photo.png',
      mimeType: 'image/png',
      targetFolder: 'uploads',
    });

    // Fallback still applies; the un-deletable key is reported, not thrown
    expect(result.variants).toEqual([]);
    expect(result.finalBuffer.equals(PNG)).toBe(true);
    // thumb was deleted; __original delete failed and remains (best-effort)
    expect(driver.size).toBe(1);
    const cleanupWarn = warns.find((w) => w.message === 'Failed to delete orphaned variant after processing failure');
    expect(cleanupWarn).toBeDefined();
    expect(String(cleanupWarn?.meta?.key)).toContain('__original');
  });

  it('video thumbnail write failure → zero orphans, video metadata still swallowed gracefully', async () => {
    const driver = new SelectiveFailDriver();
    driver.failWrite = (key) => key.includes('__thumbnail');
    const videoAdapter: VideoAdapter = {
      extractThumbnail: async () => ({ buffer: Buffer.from('jpeg'), mimeType: 'image/jpeg', width: 32, height: 18 }),
      extractMetadata: async () => ({ duration: 2, width: 320, height: 180 }),
    };
    const deps = makeDeps(driver, { ...PROCESSING, videoAdapter }, new StubImageAdapter());

    const result = await processImage(deps, {
      buffer: Buffer.from('not-really-a-video'),
      filename: 'clip.mp4',
      mimeType: 'video/mp4',
      targetFolder: 'uploads',
    });

    expect(result.variants).toEqual([]);
    expect(driver.size).toBe(0);
  });
});
