/**
 * `process: true` must replace the STORED bytes, not merely describe them.
 *
 * It used to compute dimensions, placeholders and variants from the processed
 * image and then persist the ORIGINAL object untouched — so the downloadable
 * primary kept its EXIF, including GPS, while every layer above reported the
 * asset as processed. Worse, this is the path taken by clients that could NOT
 * process locally (old browsers), i.e. precisely the uploads nobody checks by
 * hand.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, afterEach, describe, expect, it } from 'vitest';
import { createTestEngine, teardownTestMongo, type TestEngineHandle } from '../helpers/create-test-engine.js';

/**
 * A REAL JPEG. A synthetic buffer is not a substitute here: sharp cannot decode
 * one, so processing silently no-ops and the test passes while proving nothing —
 * which is what the first draft of this file did.
 */
const REAL_JPEG = readFileSync(fileURLToPath(new URL('../test-img.jpg', import.meta.url)));

describe('confirmUpload(process) — the stored primary', () => {
  let handle: TestEngineHandle;
  beforeEach(async () => {
    // The shared helper disables processing by default (so unit tests need no
    // sharp). This suite is ABOUT processing, so it must be on — otherwise the
    // whole file would pass by never exercising the path.
    handle = await createTestEngine({
      processing: { enabled: true, maxWidth: 64, format: 'webp', smartSkip: false },
    } as never);
  });
  afterEach(async () => { await handle.cleanup(); });
  afterAll(async () => { await teardownTestMongo(); });

  it('replaces the object with the PROCESSED bytes, and re-derives size', async () => {
    const repo = handle.engine.repositories.media;
    const original = REAL_JPEG;
    const presigned = await repo.getSignedUploadUrl('photo.jpg', 'image/jpeg');
    handle.driver.simulateExternalUpload(presigned.key, original, 'image/jpeg');

    const media = await repo.confirmUpload({
      key: presigned.key,
      filename: 'photo.jpg',
      mimeType: 'image/jpeg',
      size: original.length,
      process: true,
    });

    // If the processor ran, the stored bytes must not still be the original.
    const stored = handle.driver.read
      ? await (async () => {
          const chunks: Buffer[] = [];
          for await (const c of await handle.driver.read(presigned.key)) {
            chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c as Uint8Array));
          }
          return Buffer.concat(chunks);
        })()
      : null;

    // NOT an if/else. `sharp` is a real dependency here, so a run where the
    // bytes were never replaced is a FAILURE, not an environment difference —
    // an if/else would have passed either way and proved nothing.
    expect(stored).not.toBeNull();
    expect(stored?.equals(original)).toBe(false);
    // The record must describe what is actually stored. Leaving the original's
    // size beside re-encoded bytes is how a later integrity check fails for no
    // visible reason.
    expect(media.size).toBe(stored?.length);
  });
});
