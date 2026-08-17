/**
 * A configured SCAN BRIDGE must run on the presigned path.
 *
 * It was honoured on buffered uploads and skipped here — so a deployment that
 * deliberately wired a scanner had it silently not run on the flow that carries
 * almost every upload. The operator sees "scanning enabled" and gets it for the
 * path nobody uses. That is a declared capability enforced in one place out of
 * two.
 *
 * This adds no policy: with NO bridge configured, nothing is read and nothing
 * changes — which the last case pins, because a scanner that runs when none was
 * asked for would be its own (expensive) defect.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { createTestEngine, teardownTestMongo } from '../helpers/create-test-engine.js';

const REAL_JPEG = readFileSync(fileURLToPath(new URL('../test-img.jpg', import.meta.url)));

async function presign(handle: Awaited<ReturnType<typeof createTestEngine>>) {
  const repo = handle.engine.repositories.media;
  const p = await repo.getSignedUploadUrl('scan-me.jpg', 'image/jpeg');
  handle.driver.simulateExternalUpload(p.key, REAL_JPEG, 'image/jpeg');
  return p.key;
}

const confirm = (handle: Awaited<ReturnType<typeof createTestEngine>>, key: string) =>
  handle.engine.repositories.media.confirmUpload({
    key,
    filename: 'scan-me.jpg',
    mimeType: 'image/jpeg',
    size: REAL_JPEG.length,
  });

describe('presigned confirm — scan bridge', () => {
  afterAll(async () => {
    await teardownTestMongo();
  });

  it('RUNS the bridge over the uploaded bytes', async () => {
    const scan = vi.fn(async () => ({ verdict: 'clean' as const }));
    const handle = await createTestEngine({ bridges: { scan: { scan } } } as never);
    try {
      const media = await confirm(handle, await presign(handle));
      expect(scan).toHaveBeenCalledTimes(1);
      // It received the ACTUAL bytes, not the client's word for them.
      expect((scan.mock.calls[0] as unknown[])[0]).toBeInstanceOf(Buffer);
      expect(((scan.mock.calls[0] as unknown[])[0] as Buffer).length).toBe(REAL_JPEG.length);
      expect(media.status).toBe('ready');
    } finally {
      await handle.cleanup();
    }
  });

  it('REFUSES a rejected verdict', async () => {
    const scan = vi.fn(async () => ({ verdict: 'reject' as const, reason: 'eicar' }));
    const handle = await createTestEngine({ bridges: { scan: { scan } } } as never);
    try {
      await expect(confirm(handle, await presign(handle))).rejects.toThrow(/rejected by scan/);
    } finally {
      await handle.cleanup();
    }
  });

  /** A quarantined asset must not read as `ready` — the buffered path agrees. */
  it('marks a quarantined asset as NOT ready', async () => {
    const scan = vi.fn(async () => ({ verdict: 'quarantine' as const, reason: 'suspicious' }));
    const handle = await createTestEngine({ bridges: { scan: { scan } } } as never);
    try {
      const media = await confirm(handle, await presign(handle));
      expect(media.status).not.toBe('ready');
    } finally {
      await handle.cleanup();
    }
  });

  /**
   * A scanner that ERRORS is not a clean bill of health. Admitting unscanned
   * bytes to a library whose operator believes scanning is on is the failure.
   */
  it('REFUSES when the scanner itself fails', async () => {
    const scan = vi.fn(async () => {
      throw new Error('scanner offline');
    });
    const handle = await createTestEngine({ bridges: { scan: { scan } } } as never);
    try {
      await expect(confirm(handle, await presign(handle))).rejects.toThrow(/scan failed/);
    } finally {
      await handle.cleanup();
    }
  });

  it('does NOTHING when no bridge is configured — no policy of its own', async () => {
    const handle = await createTestEngine();
    try {
      const media = await confirm(handle, await presign(handle));
      expect(media.status).toBe('ready');
    } finally {
      await handle.cleanup();
    }
  });
});
