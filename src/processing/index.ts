/**
 * Image Processing Module
 *
 * Optional image processing using sharp.
 * Falls back gracefully if sharp is not installed.
 */

export { ImageProcessor, createImageProcessor } from './image';
export { generateThumbHash } from './thumbhash';
export { DEVICE_WIDTHS, COMPACT_WIDTHS, IMAGE_WIDTHS, generateResponsiveVariants, resolvePresetWidths } from './presets';
export type { ProcessingOptions, ProcessedImage } from '../types';
