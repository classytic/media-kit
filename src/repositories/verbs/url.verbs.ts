/**
 * URL & serving verbs — bridge-backed source resolution and CDN URLs
 * (resolveSource, resolveSourcesMany, getAssetUrl, getVariantUrls) plus
 * private-media serving (getSignedAssetUrl, revokeAccess, getContextPayload,
 * applyTransforms).
 *
 * Extracted from MediaRepository; each function takes the repository as its
 * first parameter. The class methods in media.repository.ts are thin
 * delegates that preserve the public API surface.
 */

import { createError } from '@classytic/repo-core/errors';
import type { IMediaDocument } from '../../types.js';
import type { MediaContext } from '../../engine/engine-types.js';
import type { SourceRef } from '../../bridges/source.bridge.js';
import type { TransformOpOutput } from '../../bridges/transform.bridge.js';
import { isImage } from '../../utils/mime.js';
import { isExternalMedia } from '../../utils/external.js';
import type { MediaRepository } from '../media.repository.js';

/**
 * Resolve a single media doc's polymorphic source via SourceBridge.
 * Returns `null` when no source set, no bridge configured, or bridge returns null.
 */
export async function resolveSourceVerb(
  repo: MediaRepository,
  media: IMediaDocument,
  ctx?: MediaContext,
): Promise<unknown | null> {
  const m = media as unknown as { sourceId?: string; sourceModel?: string };
  if (!m.sourceId || !m.sourceModel || !repo.bridges.source?.resolve) return null;
  return repo.bridges.source.resolve(m.sourceId, m.sourceModel, {
    organizationId: ctx?.organizationId ? String(ctx.organizationId) : undefined,
    userId: ctx?.userId ? String(ctx.userId) : undefined,
  });
}

/**
 * Batch-resolve polymorphic sources for a list of media docs.
 * Returns a Map<sourceId, sourceDoc> — use to enrich list responses without N+1.
 */
export async function resolveSourcesManyVerb(
  repo: MediaRepository,
  medias: IMediaDocument[],
  ctx?: MediaContext,
): Promise<Map<string, unknown>> {
  const resolver = repo.bridges.source?.resolveMany;
  if (!resolver) return new Map();
  const refs: SourceRef[] = [];
  for (const m of medias) {
    const mm = m as unknown as { sourceId?: string; sourceModel?: string };
    if (mm.sourceId && mm.sourceModel) {
      refs.push({ sourceId: mm.sourceId, sourceModel: mm.sourceModel });
    }
  }
  if (refs.length === 0) return new Map();
  return resolver(refs, {
    organizationId: ctx?.organizationId ? String(ctx.organizationId) : undefined,
    userId: ctx?.userId ? String(ctx.userId) : undefined,
  });
}

/**
 * Get the CDN-transformed URL for a media key. Falls back to driver.getPublicUrl
 * when no CdnBridge is configured.
 */
export async function getAssetUrlVerb(
  repo: MediaRepository,
  media: IMediaDocument,
  options?: { signed?: boolean; expiresIn?: number },
): Promise<string> {
  const defaultUrl =
    media.url || repo.registry.resolve(media.provider ?? repo.registry.defaultName).getPublicUrl(media.key);
  if (!repo.bridges.cdn) return defaultUrl;
  return repo.bridges.cdn.transform(media.key, defaultUrl, options);
}

/**
 * Get CDN-transformed URLs for all variants of a media doc.
 * Returns an array of `{ name, url }` — variants pass through their own URL
 * when no CdnBridge is configured.
 */
export async function getVariantUrlsVerb(
  repo: MediaRepository,
  media: IMediaDocument,
  options?: { signed?: boolean; expiresIn?: number },
): Promise<Array<{ name: string; url: string }>> {
  const variants = media.variants ?? [];
  if (!repo.bridges.cdn) return variants.map((v) => ({ name: v.name, url: v.url }));
  const results: Array<{ name: string; url: string }> = [];
  for (const v of variants) {
    const url = await repo.bridges.cdn.transform(v.key, v.url, options);
    results.push({ name: v.name, url });
  }
  return results;
}

/**
 * Mint a signed serve URL for an asset: `${servePath}/${id}[/variant]?e=...&kid=...&v=...&sig=...`.
 *
 * Requires engine `signing` config (`{ keys|secret, servePath, ... }`) —
 * throws a typed 500 `HttpError` (`code: 'media.signing.not_configured'`)
 * otherwise. The signature covers id, variant, expiry, kid, tokenVersion,
 * and every claim; `revokeAccess()` invalidates all outstanding URLs.
 *
 * When a CdnBridge is configured the minted URL is passed through
 * `bridges.cdn.transform(key, url, { signed: true, ... })` — the bridge
 * wins, so hosts can offload to CloudFront/edge signing instead.
 *
 * LLM note: URLs handed to LLM providers are re-fetched anonymously on
 * every chat-history replay — mint them with an `expiresIn` that covers the
 * conversation's lifetime, and do NOT re-sign the same asset per message
 * (a changing URL breaks Anthropic prompt caching). For indefinite access
 * prefer `getContextPayload()` (base64) or provider file ids.
 */
export async function getSignedAssetUrlVerb(
  repo: MediaRepository,
  idOrDoc: string | IMediaDocument,
  options: { variant?: string; expiresIn?: number; claims?: Record<string, string> } = {},
  ctx?: MediaContext,
): Promise<string> {
  const signingConfig = repo.mediaConfig.signing;
  if (!repo.signer || !signingConfig?.servePath) {
    const err = createError(
      500,
      '[media-kit] getSignedAssetUrl requires the engine `signing` config ({ keys | secret, servePath })',
    );
    err.code = 'media.signing.not_configured';
    throw err;
  }

  const media = await repo._resolveDoc(idOrDoc, ctx);
  if (options.variant && !(media.variants ?? []).some((v) => v.name === options.variant)) {
    throw new Error(`[media-kit] Variant '${options.variant}' not found on media ${String(media._id)}`);
  }

  const id = String(media._id);
  const { query } = repo.signer.sign({
    id,
    variant: options.variant,
    expiresIn: options.expiresIn,
    claims: options.claims,
    tokenVersion: media.tokenVersion ?? 0,
  });

  const servePath = signingConfig.servePath.replace(/\/+$/, '');
  const url = `${servePath}/${id}${options.variant ? `/${encodeURIComponent(options.variant)}` : ''}?${query}`;

  // Bridge wins — lets hosts route signed serving through CloudFront etc.
  if (repo.bridges.cdn) {
    return repo.bridges.cdn.transform(media.key, url, {
      signed: true,
      ...(options.expiresIn !== undefined && { expiresIn: options.expiresIn }),
      ...(ctx?.organizationId !== undefined && { organizationId: String(ctx.organizationId) }),
    });
  }
  return url;
}

/**
 * Revoke every outstanding signed URL for an asset by bumping its
 * `tokenVersion` (`$inc`). Signed URLs embed the version they were minted
 * with; verification compares it to the doc's current value, so old URLs
 * fail with `version_mismatch` immediately. Routed through the plugin
 * pipeline (`findOneAndUpdate`) so tenant scoping and cache invalidation
 * fire like any other update.
 */
export async function revokeAccessVerb(
  repo: MediaRepository,
  idOrDoc: string | IMediaDocument,
  ctx?: MediaContext,
): Promise<IMediaDocument> {
  const id = typeof idOrDoc === 'string' ? idOrDoc : String(idOrDoc._id);
  const result = await repo.findOneAndUpdate({ _id: id }, { $inc: { tokenVersion: 1 } }, {
    returnDocument: 'after',
    ...(ctx?.organizationId !== undefined && { organizationId: ctx.organizationId }),
    ...(ctx?.session !== undefined && { session: ctx.session }),
  } as Record<string, unknown>);
  if (!result) throw new Error(`Media ${id} not found`);

  repo._log('info', 'Media access revoked (tokenVersion bumped)', { id, tokenVersion: result.tokenVersion });
  return result;
}

/**
 * Load an asset's bytes for LLM context (works regardless of visibility —
 * this is a server-side read, the caller IS the trust boundary).
 *
 * - Streams from the driver with a hard cap (`maxBytes`, default 25MB) —
 *   exceeding it throws a 413 `HttpError` (`code: 'media.context.too_large'`).
 * - Images larger than `maxDimension` (default 1568px — Anthropic's token
 *   sweet spot; hard limits are 10MB / 8000px per image) are downscaled
 *   (fit inside, no enlargement) when sharp is available.
 * - Output is byte-stable for unchanged inputs — replaying the same base64
 *   in chat history is prompt-cache-friendly, unlike re-signed URLs.
 * - Bedrock/Vertex only accept base64 images — this is the portable path.
 *
 * @returns `{ data, contentType, bytes }` where `data` is a base64 string
 * (default), a `data:` URL, or a raw Buffer depending on `options.as`.
 */
export async function getContextPayloadVerb(
  repo: MediaRepository,
  idOrDoc: string | IMediaDocument,
  options: { as?: 'base64' | 'dataUrl' | 'buffer'; maxDimension?: number; maxBytes?: number } = {},
  ctx?: MediaContext,
): Promise<{ data: string | Buffer; contentType: string; bytes: number }> {
  const as = options.as ?? 'base64';
  const maxBytes = options.maxBytes ?? 25 * 1024 * 1024;
  const maxDimension = options.maxDimension ?? 1568;

  const media = await repo._resolveDoc(idOrDoc, ctx);

  // External records have no readable bytes in any registered driver.
  // Deliberately NOT fetched server-side: fetching arbitrary stored URLs
  // here would be an SSRF surface. Hosts fetch `media.url` themselves.
  // (Future option: route through url-import's pinned, SSRF-guarded fetch
  // as an explicit opt-in.)
  if (isExternalMedia(media)) {
    const err = createError(
      400,
      `[media-kit] Media ${String(media._id)} is an external reference — no bytes to load. ` +
        `Fetch media.url yourself (or re-host it via importFromUrl()).`,
    );
    err.code = 'media.context.external';
    throw err;
  }

  const driver = repo.registry.resolve(media.provider ?? repo.registry.defaultName);

  const stream = await driver.read(media.key);
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream as AsyncIterable<Buffer | string>) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > maxBytes) {
      (stream as NodeJS.ReadableStream & { destroy?: (err?: Error) => void }).destroy?.();
      const err = createError(
        413,
        `[media-kit] Media ${String(media._id)} exceeds getContextPayload maxBytes (${maxBytes} bytes)`,
      );
      err.code = 'media.context.too_large';
      throw err;
    }
    chunks.push(buf);
  }
  let buffer: Buffer = Buffer.concat(chunks) as Buffer;
  const contentType = media.mimeType;

  if (maxDimension > 0 && isImage(media.mimeType)) {
    const sharp = await repo._getSharp();
    if (sharp) {
      try {
        const meta = await sharp(buffer).metadata();
        const longEdge = Math.max(meta.width ?? 0, meta.height ?? 0);
        if (longEdge > maxDimension) {
          buffer = (await sharp(buffer)
            .resize(maxDimension, maxDimension, { fit: 'inside', withoutEnlargement: true })
            .toBuffer()) as Buffer;
        }
      } catch {
        // Un-decodable "image" — fall through with the original bytes.
      }
    }
  }

  const bytes = buffer.length;
  if (as === 'buffer') return { data: buffer, contentType, bytes };
  const b64 = buffer.toString('base64');
  if (as === 'dataUrl') return { data: `data:${contentType};base64,${b64}`, contentType, bytes };
  return { data: b64, contentType, bytes };
}

/**
 * Apply a pipeline of transform ops to an existing asset buffer.
 *
 * Ops are resolved from `bridges.transform.ops` and executed in order.
 * The asset's current buffer is read from storage, piped through each op,
 * and the result returned (NOT persisted). Callers decide what to do —
 * stream to response, cache in CDN, save as a new variant, etc.
 *
 * This is the primitive for building ImageKit-style URL transforms
 * (`GET /transform/:id?op=bg-remove,upscale&scale=4`).
 *
 * @throws if the media is not found, no TransformBridge configured, or any op is unknown
 */
export async function applyTransformsVerb(
  repo: MediaRepository,
  mediaId: string,
  options: { ops: string[]; params?: Record<string, string> },
  ctx?: MediaContext,
): Promise<TransformOpOutput> {
  const media = await repo.getById(mediaId, { ...ctx });
  if (!media) throw new Error(`Media ${mediaId} not found`);

  // External records own no bytes to transform.
  if (isExternalMedia(media)) {
    const err = createError(
      400,
      `[media-kit] applyTransforms() is not supported for external media ${mediaId} — ` +
        `it references a third-party URL and owns no bytes.`,
    );
    err.code = 'media.external.no_bytes';
    throw err;
  }

  const opsRegistry = repo.bridges.transform?.ops;
  if (!opsRegistry || Object.keys(opsRegistry).length === 0) {
    throw new Error('[media-kit] No TransformBridge configured — register ops via bridges.transform.ops');
  }

  for (const name of options.ops) {
    if (!opsRegistry[name]) {
      throw new Error(
        `[media-kit] Unknown transform op: '${name}'. Registered: ${Object.keys(opsRegistry).join(', ') || '(none)'}`,
      );
    }
  }

  // Read source buffer from storage (route to the provider that stored this file)
  const stream = await repo.registry.resolve(media.provider ?? repo.registry.defaultName).read(media.key);
  const chunks: Buffer[] = [];
  for await (const chunk of stream as AsyncIterable<Buffer>) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  let buffer: Buffer = Buffer.concat(chunks) as Buffer;
  let mimeType = media.mimeType;
  let width: number | undefined = media.width;
  let height: number | undefined = media.height;

  const opCtx = {
    params: options.params ?? {},
    media,
    organizationId: ctx?.organizationId ? String(ctx.organizationId) : undefined,
    userId: ctx?.userId ? String(ctx.userId) : undefined,
  };

  for (const name of options.ops) {
    const op = opsRegistry[name]!;
    const result = await op({ buffer, mimeType }, opCtx);
    buffer = result.buffer;
    mimeType = result.mimeType;
    width = result.width ?? width;
    height = result.height ?? height;
  }

  return { buffer, mimeType, width, height };
}
