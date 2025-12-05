/**
 * Image Processing Module
 * 
 * Optional image processing using sharp.
 * Falls back gracefully if sharp is not installed.
 */

export { ImageProcessor, createImageProcessor } from './image';
export type { ProcessingOptions, ProcessedImage } from '../types';
