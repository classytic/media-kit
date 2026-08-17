/**
 * Regression — URL imports go through the CANONICAL upload pipeline.
 *
 * Before the fix, `importFromUrl()` ran its own legacy upload path that never
 * consulted the malware/moderation scan bridge, so externally-fetched bytes
 * could bypass scanning entirely. It now feeds the download into
 * `repo.upload()`, inheriting the exact same scan/quarantine behavior as a
 * direct upload. These tests prove the scan bridge is consulted on import and
 * that a `reject` verdict blocks it.
 *
 * http is mocked to serve bytes for a PUBLIC IP literal (passes the SSRF guard,
 * and IP literals resolve without a DNS query).
 */

import { describe, it, expect, afterAll, vi } from 'vitest';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { createTestEngine, teardownTestMongo } from '../helpers/create-test-engine.js';
import type { ScanBridge, ScanResult } from '../../src/bridges/scan.bridge.js';

vi.mock('node:http', () => {
  const get = (
    _url: string,
    _opts: unknown,
    cb: (res: NodeJS.ReadableStream & { statusCode: number; headers: Record<string, string> }) => void,
  ) => {
    const res = Readable.from([Buffer.from('remote-bytes')]) as unknown as NodeJS.ReadableStream & {
      statusCode: number;
      headers: Record<string, string>;
    };
    res.statusCode = 200;
    res.headers = { 'content-type': 'image/png', 'content-length': '12' };
    queueMicrotask(() => cb(res));
    const req = new EventEmitter() as EventEmitter & { destroy: () => void };
    req.destroy = () => {};
    return req;
  };
  return { default: { get } };
});

const URL_OK = 'http://93.184.216.34/pic.png';

function scanBridge(result: ScanResult): { scan: ReturnType<typeof vi.fn> } & ScanBridge {
  return { scan: vi.fn().mockResolvedValue(result) };
}

describe('URL import — canonical scan pipeline', () => {
  afterAll(async () => {
    await teardownTestMongo();
  });

  it('consults the scan bridge on import and rejects a malware verdict', async () => {
    const bridge = scanBridge({ verdict: 'reject', reason: 'malware detected' });
    const handle = await createTestEngine({ bridges: { scan: bridge } });

    await expect(handle.engine.repositories.media.importFromUrl(URL_OK)).rejects.toThrow(/malware|scan/i);
    expect(bridge.scan).toHaveBeenCalledTimes(1);
    // the scanner saw the DOWNLOADED bytes, not an empty/placeholder buffer
    const buf = bridge.scan.mock.calls[0]![0] as Buffer;
    expect(buf.toString()).toBe('remote-bytes');

    await handle.cleanup();
  });

  it('imports normally on a clean verdict (proving the scan path is on, not bypassed)', async () => {
    const bridge = scanBridge({ verdict: 'clean' });
    const handle = await createTestEngine({ bridges: { scan: bridge } });

    const media = await handle.engine.repositories.media.importFromUrl(URL_OK);
    expect(media.status).toBe('ready');
    expect(bridge.scan).toHaveBeenCalledTimes(1);

    await handle.cleanup();
  });

  it('quarantines an imported asset on a quarantine verdict', async () => {
    const bridge = scanBridge({ verdict: 'quarantine', reason: 'needs review' });
    const handle = await createTestEngine({ bridges: { scan: bridge } });

    const media = await handle.engine.repositories.media.importFromUrl(URL_OK);
    expect(media.status).toBe('error');
    expect(media.errorMessage).toContain('needs review');

    await handle.cleanup();
  });
});
