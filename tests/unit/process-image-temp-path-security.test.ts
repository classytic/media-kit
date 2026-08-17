/**
 * Security regression — video temp-file path traversal.
 *
 * The video-adapter branch of `processImage` writes the upload buffer to a
 * LOCAL temp file so an ffmpeg-style adapter can probe it. Historically the
 * temp path was `path.join(os.tmpdir(), 'mk-'+Date.now()+'-'+filename)` with
 * `filename` being the RAW client-supplied upload name — a name like
 * `../../../home/user/.bashrc` normalizes back OUT of os.tmpdir() and writes
 * the attacker-controlled buffer to an arbitrary path (potential RCE).
 *
 * The fix derives a collision-resistant random temp name with a safe
 * extension from the validated MIME — no client input touches the path.
 * These tests assert the path the adapter is handed ALWAYS resolves inside
 * os.tmpdir() and never leaks the client filename.
 */

import { describe, it, expect } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { processImage } from '../../src/operations/process-image';
import type { OperationDeps } from '../../src/operations/types';
import type { MediaRepository } from '../../src/repositories/media.repository';
import type { ResolvedMediaConfig } from '../../src/engine/engine-types';
import type { ImageAdapter, ProcessedImage, ProcessingOptions, SizeVariant, VideoAdapter } from '../../src/types';
import { DriverRegistry } from '../../src/providers/driver-registry';
import { Semaphore } from '../../src/utils/semaphore';
import { MemoryStorageDriver } from '../helpers/memory-driver';

/** Deterministic image adapter (never used on the video path, required by deps shape). */
class StubImageAdapter implements ImageAdapter {
  async process(buffer: Buffer): Promise<ProcessedImage> {
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
    return variants.map((v) => ({ buffer, mimeType: 'image/png', width: v.width ?? 10, height: 10, variantName: v.name }));
  }
}

function makeDeps(driver: MemoryStorageDriver, videoAdapter: VideoAdapter): OperationDeps {
  return {
    config: {
      processing: { enabled: true, videoAdapter, thumbhash: false, dominantColor: false },
    } as ResolvedMediaConfig,
    driver,
    registry: DriverRegistry.fromSingle(driver),
    repository: {} as unknown as MediaRepository,
    processor: new StubImageAdapter(),
    processorReady: null,
    events: { emit: async () => {}, on: () => () => {}, removeAllListeners: () => {}, listenerCount: () => 0 },
    uploadSemaphore: new Semaphore(4),
  };
}

const TMP = fs.realpathSync(os.tmpdir());

/** Capture the exact path handed to the video adapter + prove the file lives there. */
function capturingAdapter(): { adapter: VideoAdapter; seen: string[]; existedInsideTmp: boolean[] } {
  const seen: string[] = [];
  const existedInsideTmp: boolean[] = [];
  const record = (filePath: string) => {
    seen.push(filePath);
    // At call time the temp file must exist AND sit under os.tmpdir().
    const real = fs.existsSync(filePath) ? fs.realpathSync(filePath) : filePath;
    existedInsideTmp.push(fs.existsSync(filePath) && (real === TMP || real.startsWith(TMP + path.sep)));
  };
  return {
    seen,
    existedInsideTmp,
    adapter: {
      extractThumbnail: async (filePath) => {
        record(filePath);
        return { buffer: Buffer.from('jpeg'), mimeType: 'image/jpeg', width: 32, height: 18 };
      },
      extractMetadata: async (filePath) => {
        record(filePath);
        return { duration: 2, width: 320, height: 180, codec: 'h264' };
      },
    },
  };
}

describe('processImage — video temp path is traversal-safe', () => {
  const evilNames = [
    '../../../home/user/.bashrc',
    '..\\..\\..\\Windows\\System32\\evil.mp4',
    '../../evil',
    'foo/../../../../etc/passwd',
    '%2e%2e%2f%2e%2e%2fevil.mp4',
  ];

  for (const filename of evilNames) {
    it(`keeps the temp file inside os.tmpdir() for filename ${JSON.stringify(filename)}`, async () => {
      const driver = new MemoryStorageDriver();
      const { adapter, seen, existedInsideTmp } = capturingAdapter();
      const deps = makeDeps(driver, adapter);

      await processImage(deps, {
        buffer: Buffer.from('not-really-a-video'),
        filename,
        mimeType: 'video/mp4',
        targetFolder: 'uploads',
      });

      // The adapter WAS invoked (both thumbnail + metadata) ...
      expect(seen.length).toBeGreaterThan(0);
      for (const p of seen) {
        const resolved = path.resolve(p);
        // ... and every path resolves strictly inside os.tmpdir()
        expect(resolved === TMP || resolved.startsWith(TMP + path.sep)).toBe(true);
        // ... never escapes, never echoes the raw client filename
        expect(p).not.toContain('..');
        expect(path.basename(p)).not.toContain('passwd');
        expect(path.basename(p)).not.toContain('.bashrc');
        // ... safe extension derived from the validated MIME, not the name
        expect(path.extname(p)).toBe('.mp4');
      }
      // The file physically existed under tmpdir at adapter-call time.
      expect(existedInsideTmp.every(Boolean)).toBe(true);
    });
  }

  it('does not create any file outside os.tmpdir() for a traversal filename', async () => {
    const driver = new MemoryStorageDriver();
    const { adapter } = capturingAdapter();
    const deps = makeDeps(driver, adapter);

    // A path an old-style join would have produced outside tmpdir.
    const escaped = path.resolve(TMP, '..', 'mk-traversal-canary.mp4');
    expect(fs.existsSync(escaped)).toBe(false);

    await processImage(deps, {
      buffer: Buffer.from('not-really-a-video'),
      filename: '../mk-traversal-canary.mp4',
      mimeType: 'video/mp4',
      targetFolder: 'uploads',
    });

    // Nothing was written to the parent of tmpdir.
    expect(fs.existsSync(escaped)).toBe(false);
  });
});
