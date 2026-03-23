/**
 * ThumbHash — Compact Image Placeholders
 *
 * Generates a ~25 byte ThumbHash from an image buffer for blur-up loading.
 * The encoder is fully inlined (pure DCT math) so no runtime dependency is needed.
 *
 * Algorithm: https://github.com/evanw/thumbhash (MIT License, Evan Wallace)
 *
 * @example
 * ```ts
 * import sharp from 'sharp';
 * import { generateThumbHash } from './thumbhash';
 *
 * const buffer = fs.readFileSync('photo.jpg');
 * const hash = await generateThumbHash(sharp, buffer);
 * // => "3OcRJYB4d3h/iIeHeEh3eIhw+j3A" (base64, ~25 bytes)
 * ```
 */

/**
 * Encode an RGBA image into a ThumbHash byte array.
 *
 * This is the reference ThumbHash encoder by Evan Wallace, inlined to avoid
 * adding a runtime dependency. RGB values should NOT be premultiplied by alpha.
 *
 * @param w - Image width in pixels
 * @param h - Image height in pixels
 * @param rgba - Raw RGBA pixel data (4 bytes per pixel)
 * @returns ThumbHash as a Uint8Array (~25 bytes)
 *
 * @see https://github.com/evanw/thumbhash
 * @license MIT
 */
function rgbaToThumbHash(w: number, h: number, rgba: Uint8Array): Uint8Array {
  let { PI, round, max, cos, abs } = Math;
  let alphaCount = 0;
  let isLandscape = w > h;
  let lx = max(1, round(isLandscape ? 7 : (7 * w) / h));
  let ly = max(1, round(isLandscape ? (7 * h) / w : 7));
  let l: number[] = []; // luminance
  let p: number[] = []; // yellow - blue
  let q: number[] = []; // red - green
  let a: number[] = []; // alpha

  // Extract channel values
  for (let i = 0, j = 0; i < w * h; i++, j += 4) {
    let alpha = rgba[j + 3]! / 255;
    alphaCount += alpha;
    let r = (alpha / 255) * rgba[j]!;
    let g = (alpha / 255) * rgba[j + 1]!;
    let b = (alpha / 255) * rgba[j + 2]!;
    l.push((r + g + b) / 3);
    p.push((r + g) / 2 - b);
    q.push(r - g);
    a.push(alpha);
  }

  let hasAlpha = alphaCount < w * h;
  let lLimit = hasAlpha ? 5 : 7;
  let lCount = max(3, lx) * max(3, ly);
  let aCount = max(3, lx) * max(3, ly);

  // DCT per channel
  function encode(
    channel: number[],
    nx: number,
    ny: number
  ): [number, number[], number] {
    let dc = 0;
    let ac: number[] = [];
    let scale = 0;
    let fx: number[] = [];
    for (let cy = 0; cy < ny; cy++) {
      for (let cx = 0; cx * ny < nx * (ny - cy); cx++) {
        let f = 0;
        for (let x = 0; x < w; x++) {
          fx[x] = cos((PI / w) * cx * (x + 0.5));
        }
        for (let y = 0; y < h; y++) {
          let fy = cos((PI / h) * cy * (y + 0.5));
          for (let x = 0; x < w; x++) {
            f += channel[y * w + x]! * fx[x]! * fy;
          }
        }
        f /= w * h;
        if (cx > 0 || cy > 0) {
          ac.push(f);
          scale = max(scale, abs(f));
        } else {
          dc = f;
        }
      }
    }
    if (scale > 0) for (let i = 0; i < ac.length; i++) ac[i] = 0.5 + (0.5 / scale) * ac[i]!;
    return [dc, ac, scale];
  }

  let [lDC, lAC, lScale] = encode(l, max(3, lx), max(3, ly));
  let [pDC, pAC, pScale] = encode(p, 3, 3);
  let [qDC, qAC, qScale] = encode(q, 3, 3);
  let [aDC, aAC, aScale] = hasAlpha
    ? encode(a, 5, 5)
    : ([0, [], 0] as [number, number[], number]);

  // Write header
  let isLandscapeVal = w > h;
  let header24 =
    round(63 * lDC) |
    (round(31.5 + 31.5 * pDC) << 6) |
    (round(31.5 + 31.5 * qDC) << 12) |
    (round(31 * lScale) << 18) |
    ((hasAlpha ? 1 : 0) << 23);
  let header16 =
    (isLandscapeVal ? ly : lx) |
    (round(63 * pScale) << 3) |
    (round(63 * qScale) << 9) |
    ((isLandscapeVal ? 1 : 0) << 15);

  let acStart = hasAlpha ? 6 : 5;
  let acCount = lAC.length + pAC.length + qAC.length + aAC.length;
  let hash = new Uint8Array(acStart + (acCount + 1) / 2);
  hash[0] = header24 & 255;
  hash[1] = (header24 >> 8) & 255;
  hash[2] = (header24 >> 16) & 255;
  hash[3] = header16 & 255;
  hash[4] = (header16 >> 8) & 255;
  if (hasAlpha) hash[5] = round(15 * aDC) | (round(15 * aScale) << 4);

  // Write AC components
  let acIndex = 0;
  let allAC = [...lAC, ...pAC, ...qAC, ...aAC];
  for (let i = 0; i < allAC.length; i++) {
    let value = round(15 * allAC[i]!);
    if (acIndex & 1) {
      hash[acStart + (acIndex >> 1)]! |= value << 4;
    } else {
      hash[acStart + (acIndex >> 1)] = value;
    }
    acIndex++;
  }

  return hash;
}

/**
 * Generate a ThumbHash placeholder string from an image buffer.
 *
 * Resizes the image to fit within 100x100 (preserving aspect ratio),
 * extracts raw RGBA pixels, encodes them with the ThumbHash algorithm,
 * and returns the result as a base64 string.
 *
 * @param sharp - A Sharp constructor (passed in to avoid importing sharp directly)
 * @param buffer - The source image as a Buffer
 * @returns Base64-encoded ThumbHash string, or null if generation fails
 *
 * @example
 * ```ts
 * const hash = await generateThumbHash(sharp, imageBuffer);
 * if (hash) {
 *   // Store hash alongside the image record for blur-up placeholders
 *   await db.images.update(id, { thumbhash: hash });
 * }
 * ```
 */
export async function generateThumbHash(
  sharp: any,
  buffer: Buffer
): Promise<string | null> {
  try {
    const { data, info } = await sharp(buffer)
      .resize(100, 100, { fit: 'inside' })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const hash = rgbaToThumbHash(info.width, info.height, new Uint8Array(data));

    return Buffer.from(hash).toString('base64');
  } catch {
    return null;
  }
}
