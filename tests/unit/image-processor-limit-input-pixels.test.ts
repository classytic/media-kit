/**
 * Security regression — decompression-bomb cap (Sharp `limitInputPixels`).
 *
 * `sharpOptions.limitInputPixels` is threaded into the constructor options of
 * every `sharp(inputBuffer)` call, so an image whose pixel count exceeds the
 * cap is rejected BEFORE Sharp decodes it into memory (a ~1 GB decode from a
 * tiny file is the classic decompression bomb). Default cap is Sharp's own
 * ~268 MP; a host can tighten it for untrusted public uploads.
 *
 * We prove the wiring by setting an absurdly small cap and feeding a normal
 * fixture image: it must be rejected. With the cap disabled the SAME image
 * processes fine — showing the limit, not the fixture, is what rejects it.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { ImageProcessor } from '../../src/processing/image';

const FIXTURE = path.resolve(__dirname, '../test-img.jpg');

describe('ImageProcessor — limitInputPixels decompression-bomb guard', () => {
  it('rejects an image whose pixel count exceeds the configured cap', async () => {
    const buffer = fs.readFileSync(FIXTURE);
    // Cap of 10 pixels — any real image exceeds it.
    const processor = new ImageProcessor({ limitInputPixels: 10 });
    if (!(await processor.waitUntilReady())) return; // sharp not installed — skip

    await expect(processor.process(buffer, { format: 'jpeg' })).rejects.toThrow(/pixel/i);
    // getDimensions decodes the header the same way — also guarded.
    await expect(processor.getDimensions(buffer)).rejects.toThrow(/pixel/i);
  });

  it('processes the same image when the cap is disabled (limit, not fixture, rejects)', async () => {
    const buffer = fs.readFileSync(FIXTURE);
    const processor = new ImageProcessor({ limitInputPixels: false });
    if (!(await processor.waitUntilReady())) return; // sharp not installed — skip

    const out = await processor.process(buffer, { format: 'jpeg' });
    expect(out.buffer.length).toBeGreaterThan(0);
    expect(out.width).toBeGreaterThan(0);
    expect(out.height).toBeGreaterThan(0);
  });

  it('defaults to a sane cap when limitInputPixels is not configured', async () => {
    const buffer = fs.readFileSync(FIXTURE);
    const processor = new ImageProcessor();
    if (!(await processor.waitUntilReady())) return; // sharp not installed — skip

    // A normal fixture is well under the ~268 MP default — must still process.
    const out = await processor.process(buffer, { format: 'jpeg' });
    expect(out.buffer.length).toBeGreaterThan(0);
  });
});
