/**
 * TransformBridge — pluggable on-the-fly transform ops.
 *
 * media-kit's built-in AssetTransformService handles resize/format via URL
 * params. But hosts often want custom ops (bg-remove, upscale, smart-crop,
 * watermark, etc.) that can be composed in URL strings like:
 *   /transform/:id?op=bg-remove,upscale&w=800
 *
 * This bridge lets hosts register named ops that receive a buffer + params
 * and return a new buffer. Ops are executed in declaration order.
 *
 * Hosts compose their own AI stack — media-kit stays thin:
 *
 * @example
 * ```typescript
 * import { createMedia } from '@classytic/media-kit';
 * import Replicate from 'replicate';
 *
 * const replicate = new Replicate();
 *
 * const engine = await createMedia({
 *   connection,
 *   driver,
 *   bridges: {
 *     transform: {
 *       ops: {
 *         'bg-remove': async (buffer) => {
 *           const output = await replicate.run('rembg/rembg-silueta', { input: { image: buffer } });
 *           return { buffer: output, mimeType: 'image/png' };
 *         },
 *         'upscale': async (buffer, params) => {
 *           const scale = Number(params.scale ?? 2);
 *           const output = await replicate.run('nightmareai/real-esrgan', { input: { image: buffer, scale } });
 *           return { buffer: output, mimeType: 'image/png' };
 *         },
 *         'face-crop': async (buffer) => {
 *           const crop = await detectAndCropFace(buffer);
 *           return { buffer: crop, mimeType: 'image/jpeg' };
 *         },
 *       },
 *     },
 *   },
 * });
 *
 * // Host exposes an HTTP route:
 * // GET /transform/:id?op=bg-remove,upscale&scale=4
 * const result = await engine.repositories.media.applyTransforms(id, {
 *   ops: ['bg-remove', 'upscale'],
 *   params: { scale: '4' },
 * });
 * ```
 */

export interface TransformOpInput {
  buffer: Buffer;
  mimeType: string;
}

export interface TransformOpOutput {
  buffer: Buffer;
  mimeType: string;
  width?: number;
  height?: number;
}

export interface TransformOpContext {
  /** Named params from the URL (e.g. `?op=upscale&scale=4` → `{ scale: '4' }`). */
  params: Record<string, string>;
  /** Original media document for ops that need metadata (focal point, tags, etc.). */
  media?: unknown;
  /** Organization / user scope. */
  organizationId?: string;
  userId?: string;
}

export type TransformOp = (
  input: TransformOpInput,
  ctx: TransformOpContext,
) => Promise<TransformOpOutput>;

export interface TransformBridge {
  /**
   * Named op registry. Ops are referenced by name in URL params and
   * executed in declaration order (pipeline composition).
   */
  ops?: Record<string, TransformOp>;
}
