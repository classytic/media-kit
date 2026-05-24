/**
 * Integration tests — `withMediaCascade` owner-doc cascade helper.
 *
 * Covers:
 *   - findOneAndDelete cascades to single scalar id field
 *   - findOneAndDelete cascades to array-of-ids field
 *   - findOneAndDelete cascades across multiple fields
 *   - findOneAndDelete with null/missing field — no-op (no throw)
 *   - deleteOne (query form) cascades
 *   - deleteOne (document form, `doc.deleteOne()`) cascades
 *   - deleteMany cascades across N matched docs
 *   - context callback is invoked and threaded into hardDelete
 *   - onError: 'log' (default) — cascade failure does NOT bubble
 *   - onError: 'throw' — cascade failure surfaces
 *   - hard validation: empty fields, missing repository
 */

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose, { Schema, Types } from 'mongoose';
import {
  createTestEngine,
  createTestImageBuffer,
  teardownTestMongo,
  type TestEngineHandle,
} from '../helpers/create-test-engine.js';
import { withMediaCascade } from '../../src/utils/cascade.js';

// ── Engine + test owner model setup ─────────────────────────────────────────

let handle: TestEngineHandle;

interface VoiceClipDoc {
  text: string;
  audioMediaId?: Types.ObjectId | null;
  captionsMediaId?: Types.ObjectId | null;
  gallery?: Types.ObjectId[];
  organizationId?: string;
}

let VoiceClipModel: mongoose.Model<VoiceClipDoc>;
let uploadCount = 0;

async function uploadTwoMedia(): Promise<[string, string]> {
  const buf = createTestImageBuffer();
  uploadCount += 1;
  const a = await handle.engine.repositories.media.upload({
    buffer: buf,
    filename: `cascade-a-${uploadCount}.png`,
    mimeType: 'image/png',
  });
  uploadCount += 1;
  const b = await handle.engine.repositories.media.upload({
    buffer: buf,
    filename: `cascade-b-${uploadCount}.png`,
    mimeType: 'image/png',
  });
  return [String(a._id), String(b._id)];
}

beforeEach(async () => {
  handle = await createTestEngine();

  const VoiceClipSchema = new Schema<VoiceClipDoc>({
    text: String,
    audioMediaId: { type: Schema.Types.ObjectId, ref: 'media' },
    captionsMediaId: { type: Schema.Types.ObjectId, ref: 'media' },
    gallery: [{ type: Schema.Types.ObjectId, ref: 'media' }],
    organizationId: String,
  });
  withMediaCascade(VoiceClipSchema, {
    repository: handle.engine.repositories.media,
    fields: ['audioMediaId', 'captionsMediaId', 'gallery'],
  });
  // Unique model name per test — schemas can't be re-registered on the same
  // connection without throwing.
  const modelName = `voice_clip_${Math.random().toString(36).slice(2, 8)}`;
  VoiceClipModel = handle.connection.model<VoiceClipDoc>(modelName, VoiceClipSchema);
});

afterEach(async () => {
  await handle.cleanup();
});

afterAll(async () => {
  await teardownTestMongo();
});

// ── Tests ───────────────────────────────────────────────────────────────────

describe('withMediaCascade — findOneAndDelete', () => {
  it('cascades a single scalar id field on findOneAndDelete', async () => {
    const [audioId] = await uploadTwoMedia();
    const owner = await VoiceClipModel.create({
      text: 'hello',
      audioMediaId: new Types.ObjectId(audioId),
    });

    await VoiceClipModel.findOneAndDelete({ _id: owner._id });

    const survivor = await handle.engine.repositories.media.getById(audioId, {
      throwOnNotFound: false,
    } as Record<string, unknown>);
    expect(survivor).toBeNull();
  });

  it('cascades across multiple scalar fields', async () => {
    const [audioId, captionsId] = await uploadTwoMedia();
    const owner = await VoiceClipModel.create({
      text: 'hello',
      audioMediaId: new Types.ObjectId(audioId),
      captionsMediaId: new Types.ObjectId(captionsId),
    });

    await VoiceClipModel.findOneAndDelete({ _id: owner._id });

    const audioSurvivor = await handle.engine.repositories.media.getById(audioId, {
      throwOnNotFound: false,
    } as Record<string, unknown>);
    const captionsSurvivor = await handle.engine.repositories.media.getById(captionsId, {
      throwOnNotFound: false,
    } as Record<string, unknown>);
    expect(audioSurvivor).toBeNull();
    expect(captionsSurvivor).toBeNull();
  });

  it('cascades an array-of-ids field', async () => {
    const [a, b] = await uploadTwoMedia();
    const owner = await VoiceClipModel.create({
      text: 'hello',
      gallery: [new Types.ObjectId(a), new Types.ObjectId(b)],
    });

    await VoiceClipModel.findOneAndDelete({ _id: owner._id });

    const aSurvivor = await handle.engine.repositories.media.getById(a, {
      throwOnNotFound: false,
    } as Record<string, unknown>);
    const bSurvivor = await handle.engine.repositories.media.getById(b, {
      throwOnNotFound: false,
    } as Record<string, unknown>);
    expect(aSurvivor).toBeNull();
    expect(bSurvivor).toBeNull();
  });

  it('is a no-op when all cascade fields are null/absent', async () => {
    const owner = await VoiceClipModel.create({ text: 'no media' });
    // Must not throw, must not call hardDelete.
    await expect(VoiceClipModel.findOneAndDelete({ _id: owner._id })).resolves.not.toThrow();
  });

  it('skips null entries inside an array-of-ids', async () => {
    const [a] = await uploadTwoMedia();
    const owner = await VoiceClipModel.create({
      text: 'with one media',
      gallery: [new Types.ObjectId(a)],
    });

    await VoiceClipModel.findOneAndDelete({ _id: owner._id });

    const aSurvivor = await handle.engine.repositories.media.getById(a, {
      throwOnNotFound: false,
    } as Record<string, unknown>);
    expect(aSurvivor).toBeNull();
  });
});

describe('withMediaCascade — deleteOne (query form)', () => {
  it('cascades on Model.deleteOne({ ... })', async () => {
    const [audioId] = await uploadTwoMedia();
    const owner = await VoiceClipModel.create({
      text: 'hello',
      audioMediaId: new Types.ObjectId(audioId),
    });

    await VoiceClipModel.deleteOne({ _id: owner._id });

    const survivor = await handle.engine.repositories.media.getById(audioId, {
      throwOnNotFound: false,
    } as Record<string, unknown>);
    expect(survivor).toBeNull();
  });
});

describe('withMediaCascade — deleteOne (document form)', () => {
  it('cascades on doc.deleteOne()', async () => {
    const [audioId] = await uploadTwoMedia();
    const owner = await VoiceClipModel.create({
      text: 'hello',
      audioMediaId: new Types.ObjectId(audioId),
    });

    await owner.deleteOne();

    const survivor = await handle.engine.repositories.media.getById(audioId, {
      throwOnNotFound: false,
    } as Record<string, unknown>);
    expect(survivor).toBeNull();
  });
});

describe('withMediaCascade — deleteMany', () => {
  it('cascades across every matched owner doc', async () => {
    const [a1, b1] = await uploadTwoMedia();
    const [a2, b2] = await uploadTwoMedia();
    await VoiceClipModel.create([
      { text: 'one', audioMediaId: new Types.ObjectId(a1), captionsMediaId: new Types.ObjectId(b1) },
      { text: 'two', audioMediaId: new Types.ObjectId(a2), captionsMediaId: new Types.ObjectId(b2) },
    ]);

    await VoiceClipModel.deleteMany({});

    for (const id of [a1, b1, a2, b2]) {
      const survivor = await handle.engine.repositories.media.getById(id, {
        throwOnNotFound: false,
      } as Record<string, unknown>);
      expect(survivor).toBeNull();
    }
  });
});

describe('withMediaCascade — context callback', () => {
  it('threads the resolved MediaContext into repository.hardDelete', async () => {
    // Rewire cascade with a context resolver and a spied repository.
    const hardDeleteSpy = vi.fn(async () => true);
    const VoiceClipWithCtxSchema = new Schema<VoiceClipDoc>({
      text: String,
      audioMediaId: { type: Schema.Types.ObjectId, ref: 'media' },
      organizationId: String,
    });
    withMediaCascade(VoiceClipWithCtxSchema, {
      repository: { hardDelete: hardDeleteSpy },
      fields: ['audioMediaId'],
      context: (doc) => ({ organizationId: doc.organizationId as string }),
    });
    const modelName = `vc_ctx_${Math.random().toString(36).slice(2, 8)}`;
    const M = handle.connection.model<VoiceClipDoc>(modelName, VoiceClipWithCtxSchema);

    const audioMediaId = new Types.ObjectId();
    const owner = await M.create({
      text: 'hi',
      audioMediaId,
      organizationId: 'org-acme',
    });
    await M.findOneAndDelete({ _id: owner._id });

    expect(hardDeleteSpy).toHaveBeenCalledTimes(1);
    expect(hardDeleteSpy).toHaveBeenCalledWith(String(audioMediaId), {
      organizationId: 'org-acme',
    });
  });
});

describe('withMediaCascade — onError modes', () => {
  it("'log' (default) swallows cascade failure and lets the owner delete succeed", async () => {
    const failing = vi.fn(async () => {
      throw new Error('boom');
    });
    const logger = { warn: vi.fn() };
    const S = new Schema<VoiceClipDoc>({
      text: String,
      audioMediaId: { type: Schema.Types.ObjectId, ref: 'media' },
    });
    withMediaCascade(S, {
      repository: { hardDelete: failing },
      fields: ['audioMediaId'],
      logger,
    });
    const M = handle.connection.model<VoiceClipDoc>(
      `vc_log_${Math.random().toString(36).slice(2, 8)}`,
      S,
    );
    const owner = await M.create({ text: 'hi', audioMediaId: new Types.ObjectId() });

    // Must not throw — owner delete completes despite cascade error.
    await expect(M.findOneAndDelete({ _id: owner._id })).resolves.not.toThrow();
    expect(failing).toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();

    // Owner is actually gone.
    const gone = await M.findById(owner._id);
    expect(gone).toBeNull();
  });

  it("'throw' surfaces cascade failure (owner is still deleted — POST hook)", async () => {
    const failing = vi.fn(async () => {
      throw new Error('cascade exploded');
    });
    const S = new Schema<VoiceClipDoc>({
      text: String,
      audioMediaId: { type: Schema.Types.ObjectId, ref: 'media' },
    });
    withMediaCascade(S, {
      repository: { hardDelete: failing },
      fields: ['audioMediaId'],
      onError: 'throw',
    });
    const M = handle.connection.model<VoiceClipDoc>(
      `vc_throw_${Math.random().toString(36).slice(2, 8)}`,
      S,
    );
    const owner = await M.create({ text: 'hi', audioMediaId: new Types.ObjectId() });

    await expect(M.findOneAndDelete({ _id: owner._id })).rejects.toThrow(/cascade exploded/);
    // Even though the cascade threw, the owner was already deleted (post hook).
    const gone = await M.findById(owner._id);
    expect(gone).toBeNull();
  });
});

describe('withMediaCascade — validation', () => {
  it('throws when fields is empty', () => {
    const S = new Schema({ text: String });
    expect(() =>
      withMediaCascade(S, { repository: { hardDelete: async () => true }, fields: [] }),
    ).toThrow(/at least one field/);
  });

  it('throws when repository.hardDelete is missing', () => {
    const S = new Schema({ text: String });
    expect(() =>
      withMediaCascade(S, {
        repository: {} as unknown as { hardDelete: () => Promise<boolean> },
        fields: ['x'],
      }),
    ).toThrow(/repository\.hardDelete/);
  });
});
