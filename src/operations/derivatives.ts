import { signBudgetedUpload } from './storage-budget.js';
/**
 * Client-produced derivatives — presigning them, and admitting them safely.
 *
 * ## The flow this completes
 *
 * A presigned upload sends bytes browser → storage directly; the API never sees
 * them, which is exactly why the server can skip `sharp` on the hot path. But
 * it also means the server cannot DERIVE the thumbnail/medium sizes it used to,
 * because it never holds the pixels. Either the sizes stop existing (a media
 * grid then renders full-size originals as tiles and nothing complains), or the
 * device that already decoded the image produces them.
 *
 * The second is what WhatsApp, Amazon and every serious pipeline do, and it is
 * strictly cheaper: the client has the decoded bitmap in hand, so each extra
 * size is one more encode rather than a download + decode + encode + upload
 * round trip on a server.
 *
 * So: the client asks for presigned URLs for the sizes the HOST's policy told
 * it to produce, PUTs each straight to storage, and declares them at confirm
 * time.
 *
 * ## Keys are DERIVED, never client-supplied
 *
 * A derivative's key is composed here from the primary's key. Accepting a key
 * from the client would let a caller presign a write to any path in the bucket
 * — including over another tenant's object — which is a write primitive, not a
 * display hint. The name is sanitised for the same reason.
 */

import type { OperationContext } from '../types/uploads.js';
import type { PresignedUploadResult } from '../types/storage.js';
import type { OperationDeps } from './types.js';
import { enforcePresignPolicy } from './presigned.js';
import { assertStoredContentMatches, assertGeneratedKeyShape, tenantKeySegment, requireTenant } from './helpers.js';
import { createError } from '@classytic/repo-core/errors';

/** One size the client intends to produce and upload. */
export interface DerivativeUploadRequest {
  /** Variant identity — `thumbnail`, `medium`. Must match what readers look up. */
  name: string;
  contentType: string;
  /** Expected byte size; gated by the same MIME/size policy as any upload. */
  size?: number | undefined;
}

export interface DerivativeUploadTarget {
  name: string;
  upload: PresignedUploadResult;
}

/**
 * A variant the client says it uploaded. Registered only after the key is
 * confirmed to be one this server ISSUED for that primary — see
 * {@link assertDerivativeKey}.
 */
export interface ClientVariantInput {
  name: string;
  key: string;
  mimeType: string;
  size: number;
  width?: number | undefined;
  height?: number | undefined;
}

/**
 * `products/2026/abc.avif` + `thumbnail` → `products/2026/abc__thumbnail.avif`.
 *
 * Deterministic, so confirm-time validation recomputes the expected key rather
 * than trusting the one the client sends back. Extension comes from the
 * derivative's own content type, since a thumbnail may be encoded differently
 * from its primary.
 */
export function derivativeKey(primaryKey: string, name: string, extension: string): string {
  const safeName = sanitizeDerivativeName(name);
  const base = primaryKey.replace(/\.[^./]+$/, '');
  return `${base}__${safeName}.${extension}`;
}

/**
 * Variant names are IDENTITIES that become object keys, so they are restricted
 * to a conservative character set. `..`, `/` and friends are how a name becomes
 * a path traversal.
 */
export function sanitizeDerivativeName(name: string): string {
  const safe = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '');
  if (!safe) {
    throw createError(
      400,
      `[media] derivative name ${JSON.stringify(name)} contains no usable characters. ` +
        'Names must match [a-z0-9_-] — they become part of a storage key.',
    );
  }
  return safe;
}

const MIME_EXT: Record<string, string> = {
  'image/avif': 'avif',
  'image/webp': 'webp',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
};

function extensionFor(contentType: string): string {
  const ext = MIME_EXT[contentType.toLowerCase().split(';')[0]?.trim() ?? ''];
  if (!ext) {
    throw createError(
      400,
      `[media] ${contentType} is not a supported derivative format. ` +
        `Supported: ${Object.keys(MIME_EXT).join(', ')}.`,
    );
  }
  return ext;
}

/**
 * Presign a PUT for each requested derivative, beside the primary object.
 *
 * Runs the SAME `enforcePresignPolicy` MIME/size gate as any other upload — a
 * derivative is an object write like any other, and a path that skipped the
 * gate would be the way around it.
 */
export async function signDerivativeUploads(
  deps: OperationDeps,
  input: {
    primaryKey: string;
    derivatives: readonly DerivativeUploadRequest[];
    expiresIn?: number | undefined;
  },
  context?: OperationContext,
): Promise<DerivativeUploadTarget[]> {
  if (deps.repository.storageBudget) {
    const organizationId = requireTenant(deps, context);
    if (assertGeneratedKeyShape(input.primaryKey).tenantSegment !== tenantKeySegment(organizationId)) {
      throw createError(403, 'The primary upload belongs to a different tenant.');
    }
  }
  if (!deps.driver.getSignedUploadUrl) {
    throw new Error(`Driver '${deps.driver.name}' does not support presigned uploads`);
  }
  if (input.derivatives.length === 0) return [];

  const seen = new Set<string>();
  for (const d of input.derivatives) {
    enforcePresignPolicy(deps, d.contentType, d.size);
    const safe = sanitizeDerivativeName(d.name);
    // Two derivatives resolving to one name would presign two writers to a
    // single key; last-writer-wins would decide which pixels the variant holds.
    if (seen.has(safe)) {
      throw createError(400, `[media] duplicate derivative name "${safe}" — each name must be unique.`);
    }
    seen.add(safe);
  }

  return Promise.all(
    input.derivatives.map(async (d) => {
      const key = derivativeKey(input.primaryKey, d.name, extensionFor(d.contentType));
      const upload = await signBudgetedUpload({
        repository: deps.repository,
        driver: deps.driver,
        key,
        contentType: d.contentType,
        size: d.size,
        organizationId: context?.organizationId,
        expiresIn: input.expiresIn,
      });
      return { name: sanitizeDerivativeName(d.name), upload };
    }),
  );
}

/**
 * Refuse a client-declared variant whose key is not the one this server would
 * have issued for that primary + name + format.
 *
 * The client cannot invent keys: it PUT to a URL we signed, so it can always
 * report the key we gave it. Anything else is either a bug or an attempt to
 * bind an unrelated object — including another tenant's — into this record.
 * Rejecting loudly costs a legitimate caller nothing.
 */
export function assertDerivativeKey(primaryKey: string, variant: ClientVariantInput): void {
  const expected = derivativeKey(primaryKey, variant.name, extensionFor(variant.mimeType));
  if (variant.key !== expected) {
    /**
     * 422, not a bare throw. A bare `Error` surfaces as `arc.internal_error`
     * (500) — so a client sending a key we never signed read as a SERVER fault,
     * which pages an on-call for what is in fact the guard working correctly.
     * The status is part of the refusal: this is the caller's input being
     * rejected, and it must say so.
     */
    throw createError(
      422,
      `[media] variant "${variant.name}" reports key ${JSON.stringify(variant.key)} but this ` +
        `server issued ${JSON.stringify(expected)}. Refusing to register a key it did not sign.`,
    );
  }
}

/**
 * Validate + normalise client-declared variants into stored `variants[]` rows.
 *
 * Verifies each key against what we signed, then builds the row from SERVER
 * facts (`getPublicUrl`) rather than anything the client sent — the same rule
 * `confirmUpload` applies to the primary's URL.
 */
export async function toStoredVariants(
  deps: OperationDeps,
  primaryKey: string,
  variants: readonly ClientVariantInput[],
): Promise<
  Array<{
    name: string;
    key: string;
    url: string;
    filename: string;
    mimeType: string;
    size: number;
    width?: number;
    height?: number;
  }>
> {
  const seen = new Set<string>();
  const rows = [];
  for (const v of variants) {
    assertDerivativeKey(primaryKey, v);
    const name = sanitizeDerivativeName(v.name);
    if (seen.has(name)) {
      throw createError(400, `[media] duplicate variant name "${name}" in confirm payload.`);
    }
    seen.add(name);

    /**
     * The object must ACTUALLY BE THERE, and the size is read from storage.
     *
     * A signed key proves the client was ALLOWED to write there — not that it
     * did. A derivative PUT that was skipped, aborted or failed still leaves a
     * client able to declare the variant, and the record would then carry a
     * variant URL that 404s forever. Nothing would surface it: the media row is
     * `ready`, the variant is listed, and only a browser fetching that URL ever
     * finds out.
     *
     * Only the PRIMARY was storage-verified before this. Trusting the client
     * for the rest made the verification a property of one object out of three.
     */
    const stat = await deps.driver.stat(v.key).catch(() => null);
    if (!stat) {
      throw createError(
        422,
        `[media] variant "${name}" was declared but no object exists at ${JSON.stringify(v.key)}. ` +
          'Refusing to record a variant URL that would 404.',
      );
    }
    // A derivative is a client PUT like the primary: the same verifyContent sniff applies.
    await assertStoredContentMatches(deps, v.key, [stat.contentType, v.mimeType]);

    rows.push({
      name,
      key: v.key,
      url: deps.driver.getPublicUrl(v.key),
      filename: v.key.split('/').pop() ?? v.key,
      /**
       * Storage's own values win over the client's claim, exactly as the
       * primary's do. Dimensions stay client-reported — they are display hints
       * that storage cannot know, and a wrong one costs the tenant its own
       * layout, not correctness.
       */
      mimeType: stat.contentType || v.mimeType,
      size: stat.size ?? v.size,
      ...(v.width !== undefined ? { width: v.width } : {}),
      ...(v.height !== undefined ? { height: v.height } : {}),
    });
  }
  return rows;
}
