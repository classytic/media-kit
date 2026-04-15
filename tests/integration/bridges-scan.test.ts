/**
 * Integration tests — ScanBridge
 *
 * Covers upload-time scanning verdicts:
 *   - clean   → normal upload
 *   - reject  → upload throws
 *   - quarantine → stored with status: 'error', errorMessage
 */

import { describe, it, expect, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { createTestEngine, teardownTestMongo, type TestEngineHandle } from '../helpers/create-test-engine.js';
import type { ScanBridge, ScanResult } from '../../src/bridges/scan.bridge.js';

const BUF = (s: string) => Buffer.from(s, 'utf-8');

function makeScanBridge(result: ScanResult): ScanBridge {
  return { scan: vi.fn().mockResolvedValue(result) };
}

describe('ScanBridge integration', () => {
  afterAll(async () => {
    await teardownTestMongo();
  });

  describe('verdict: clean', () => {
    let handle: TestEngineHandle;

    beforeEach(async () => {
      handle = await createTestEngine({ bridges: { scan: makeScanBridge({ verdict: 'clean' }) } });
    });

    afterEach(async () => await handle.cleanup());

    it('allows upload when verdict is clean', async () => {
      const media = await handle.engine.repositories.media.upload({
        buffer: BUF('safe content'),
        filename: 'safe.txt',
        mimeType: 'text/plain',
      });
      expect(media.status).toBe('ready');
    });

    it('passes buffer/mimeType/filename to scanner', async () => {
      const scan = vi.fn().mockResolvedValue({ verdict: 'clean' } as ScanResult);
      const handle2 = await createTestEngine({ bridges: { scan: { scan } } });

      await handle2.engine.repositories.media.upload({
        buffer: BUF('hello'),
        filename: 'hello.txt',
        mimeType: 'text/plain',
      });

      expect(scan).toHaveBeenCalledWith(
        expect.any(Buffer),
        'text/plain',
        'hello.txt',
        expect.any(Object),
      );
      const bufferArg = scan.mock.calls[0]?.[0] as Buffer;
      expect(bufferArg.toString('utf-8')).toBe('hello');

      await handle2.cleanup();
    });
  });

  describe('verdict: reject', () => {
    let handle: TestEngineHandle;

    beforeEach(async () => {
      handle = await createTestEngine({
        bridges: {
          scan: makeScanBridge({ verdict: 'reject', reason: 'Virus detected' }),
        },
      });
    });

    afterEach(async () => await handle.cleanup());

    it('throws when scanner returns reject verdict', async () => {
      await expect(
        handle.engine.repositories.media.upload({
          buffer: BUF('malicious'),
          filename: 'virus.exe',
          mimeType: 'application/octet-stream',
        }),
      ).rejects.toThrow(/rejected by scan/i);
    });

    it('does not persist any document when rejected', async () => {
      await expect(
        handle.engine.repositories.media.upload({
          buffer: BUF('bad'),
          filename: 'bad.txt',
          mimeType: 'text/plain',
        }),
      ).rejects.toThrow();

      const count = await handle.engine.models.Media.countDocuments({});
      expect(count).toBe(0);
    });
  });

  describe('verdict: quarantine', () => {
    let handle: TestEngineHandle;

    beforeEach(async () => {
      handle = await createTestEngine({
        bridges: {
          scan: makeScanBridge({
            verdict: 'quarantine',
            reason: 'NSFW content requires review',
            metadata: { nsfwScore: 0.72, scanner: 'test' },
          }),
        },
      });
    });

    afterEach(async () => await handle.cleanup());

    it('persists media with status: "error" and quarantine reason', async () => {
      const media = await handle.engine.repositories.media.upload({
        buffer: BUF('suspicious'),
        filename: 'suspect.jpg',
        mimeType: 'image/jpeg',
      });

      expect(media.status).toBe('error');
      expect(media.errorMessage).toMatch(/NSFW content requires review/i);
    });

    it('stores scanner metadata on the document', async () => {
      const media = await handle.engine.repositories.media.upload({
        buffer: BUF('x'),
        filename: 'x.jpg',
        mimeType: 'image/jpeg',
      });

      expect(media.metadata).toMatchObject({
        scanMetadata: { nsfwScore: 0.72, scanner: 'test' },
      });
    });

    it('still writes file to storage (for manual review)', async () => {
      const media = await handle.engine.repositories.media.upload({
        buffer: BUF('x'),
        filename: 'x.jpg',
        mimeType: 'image/jpeg',
      });
      expect(await handle.driver.exists(media.key)).toBe(true);
    });
  });

  describe('scan throws', () => {
    let handle: TestEngineHandle;

    beforeEach(async () => {
      handle = await createTestEngine({
        bridges: {
          scan: {
            scan: vi.fn().mockRejectedValue(new Error('scanner service down')),
          },
        },
      });
    });

    afterEach(async () => await handle.cleanup());

    it('treats thrown errors as fail-closed (reject)', async () => {
      await expect(
        handle.engine.repositories.media.upload({
          buffer: BUF('x'),
          filename: 'x.txt',
          mimeType: 'text/plain',
        }),
      ).rejects.toThrow(/scan failed/i);
    });
  });

  describe('no scan bridge', () => {
    let handle: TestEngineHandle;

    beforeEach(async () => {
      handle = await createTestEngine();
    });

    afterEach(async () => await handle.cleanup());

    it('upload proceeds normally when no scan bridge', async () => {
      const media = await handle.engine.repositories.media.upload({
        buffer: BUF('x'),
        filename: 'x.txt',
        mimeType: 'text/plain',
      });
      expect(media.status).toBe('ready');
    });
  });
});
