/**
 * Focal Point Crop Calculation
 *
 * Implements Payload CMS's extract-then-resize algorithm.
 * The focal point (0-1 normalized) determines which region of the
 * original image is preserved when cropping to a different aspect ratio.
 *
 * @example
 * ```ts
 * const crop = calculateFocalPointCrop({
 *   originalWidth: 2000,
 *   originalHeight: 1500,
 *   targetWidth: 400,
 *   targetHeight: 400,
 *   focalX: 0.3,
 *   focalY: 0.4,
 * });
 * // { left: 83, top: 0, width: 1500, height: 1500 }
 * // Then: sharp().extract(crop).resize(400, 400)
 * ```
 */

import type { FocalPoint } from '../types';

/**
 * Parameters for focal point crop calculation
 */
export interface FocalPointCropParams {
  /** Original image width */
  originalWidth: number;
  /** Original image height */
  originalHeight: number;
  /** Target output width */
  targetWidth: number;
  /** Target output height */
  targetHeight: number;
  /** Focal point X (0.0-1.0, default 0.5) */
  focalX: number;
  /** Focal point Y (0.0-1.0, default 0.5) */
  focalY: number;
}

/**
 * Crop region for sharp().extract()
 */
export interface CropRegion {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Calculate the optimal crop region that keeps the focal point visible.
 *
 * Algorithm:
 * 1. Determine the largest possible crop region that matches the target aspect ratio
 * 2. Position the crop so the focal point is as centered as possible
 * 3. Clamp to image boundaries
 */
export function calculateFocalPointCrop(params: FocalPointCropParams): CropRegion {
  const { originalWidth, originalHeight, targetWidth, targetHeight, focalX, focalY } = params;

  // Clamp focal point to 0-1
  const fx = Math.max(0, Math.min(1, focalX));
  const fy = Math.max(0, Math.min(1, focalY));

  const targetAspect = targetWidth / targetHeight;
  const originalAspect = originalWidth / originalHeight;

  let cropWidth: number;
  let cropHeight: number;

  if (originalAspect > targetAspect) {
    // Original is wider — crop horizontally
    cropHeight = originalHeight;
    cropWidth = Math.round(cropHeight * targetAspect);
  } else {
    // Original is taller — crop vertically
    cropWidth = originalWidth;
    cropHeight = Math.round(cropWidth / targetAspect);
  }

  // Ensure crop doesn't exceed original dimensions
  cropWidth = Math.min(cropWidth, originalWidth);
  cropHeight = Math.min(cropHeight, originalHeight);

  // Position crop centered on focal point
  const focalPixelX = Math.round(fx * originalWidth);
  const focalPixelY = Math.round(fy * originalHeight);

  let left = focalPixelX - Math.round(cropWidth / 2);
  let top = focalPixelY - Math.round(cropHeight / 2);

  // Clamp to image boundaries
  left = Math.max(0, Math.min(left, originalWidth - cropWidth));
  top = Math.max(0, Math.min(top, originalHeight - cropHeight));

  return { left, top, width: cropWidth, height: cropHeight };
}

/**
 * Check if focal point is valid (both x and y in 0-1 range)
 */
export function isValidFocalPoint(fp: unknown): fp is FocalPoint {
  if (!fp || typeof fp !== 'object') return false;
  const { x, y } = fp as FocalPoint;
  return (
    typeof x === 'number' && typeof y === 'number' &&
    x >= 0 && x <= 1 && y >= 0 && y <= 1
  );
}

/**
 * Default focal point (center)
 */
export const DEFAULT_FOCAL_POINT: FocalPoint = { x: 0.5, y: 0.5 };
