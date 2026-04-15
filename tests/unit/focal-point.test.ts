import { describe, it, expect } from 'vitest';
import {
  calculateFocalPointCrop,
  isValidFocalPoint,
  DEFAULT_FOCAL_POINT,
} from '../../src/processing/focal-point';

describe('calculateFocalPointCrop', () => {
  describe('center focal point (0.5, 0.5)', () => {
    it('should crop horizontally when original is wider than target aspect', () => {
      // 2000x1000 (2:1) → 1000x1000 (1:1)
      // originalAspect (2.0) > targetAspect (1.0) → crop horizontally
      // cropHeight = 1000, cropWidth = round(1000 * 1) = 1000
      // focalPixelX = round(0.5 * 2000) = 1000, focalPixelY = round(0.5 * 1000) = 500
      // left = 1000 - round(1000/2) = 500, top = 500 - round(1000/2) = 0
      // Clamp: left = max(0, min(500, 2000-1000)) = 500, top = max(0, min(0, 0)) = 0
      const result = calculateFocalPointCrop({
        originalWidth: 2000,
        originalHeight: 1000,
        targetWidth: 1000,
        targetHeight: 1000,
        focalX: 0.5,
        focalY: 0.5,
      });

      expect(result).toEqual({ left: 500, top: 0, width: 1000, height: 1000 });
    });

    it('should crop vertically when original is taller than target aspect', () => {
      // 1000x2000 (0.5:1) → 1000x1000 (1:1)
      // originalAspect (0.5) < targetAspect (1.0) → crop vertically
      // cropWidth = 1000, cropHeight = round(1000 / 1) = 1000
      // focalPixelX = round(0.5 * 1000) = 500, focalPixelY = round(0.5 * 2000) = 1000
      // left = 500 - round(1000/2) = 0, top = 1000 - round(1000/2) = 500
      // Clamp: left = max(0, min(0, 0)) = 0, top = max(0, min(500, 2000-1000)) = 500
      const result = calculateFocalPointCrop({
        originalWidth: 1000,
        originalHeight: 2000,
        targetWidth: 1000,
        targetHeight: 1000,
        focalX: 0.5,
        focalY: 0.5,
      });

      expect(result).toEqual({ left: 0, top: 500, width: 1000, height: 1000 });
    });
  });

  describe('off-center focal point', () => {
    it('should shift crop left/up for focal point (0.3, 0.4)', () => {
      // 2000x1500 → 400x400 (1:1)
      // originalAspect (1.333) > targetAspect (1.0) → crop horizontally
      // cropHeight = 1500, cropWidth = round(1500 * 1) = 1500
      // focalPixelX = round(0.3 * 2000) = 600, focalPixelY = round(0.4 * 1500) = 600
      // left = 600 - round(1500/2) = 600 - 750 = -150, top = 600 - round(1500/2) = 600 - 750 = -150
      // Clamp: left = max(0, min(-150, 500)) = 0, top = max(0, min(-150, 0)) = 0
      const result = calculateFocalPointCrop({
        originalWidth: 2000,
        originalHeight: 1500,
        targetWidth: 400,
        targetHeight: 400,
        focalX: 0.3,
        focalY: 0.4,
      });

      // Focal point at 0.3 pushes crop left; clamped to 0
      expect(result).toEqual({ left: 0, top: 0, width: 1500, height: 1500 });
    });

    it('should shift crop right/down for focal point (0.8, 0.7)', () => {
      // 2000x1000 → 500x500 (1:1)
      // originalAspect (2.0) > targetAspect (1.0) → crop horizontally
      // cropHeight = 1000, cropWidth = round(1000 * 1) = 1000
      // focalPixelX = round(0.8 * 2000) = 1600, focalPixelY = round(0.7 * 1000) = 700
      // left = 1600 - 500 = 1100, top = 700 - 500 = 200
      // Clamp: left = max(0, min(1100, 2000-1000)) = min(1100, 1000) = 1000, top = max(0, min(200, 0)) = 0
      const result = calculateFocalPointCrop({
        originalWidth: 2000,
        originalHeight: 1000,
        targetWidth: 500,
        targetHeight: 500,
        focalX: 0.8,
        focalY: 0.7,
      });

      expect(result.left).toBe(1000);
      expect(result.top).toBe(0);
      expect(result.width).toBe(1000);
      expect(result.height).toBe(1000);
    });
  });

  describe('edge focal points', () => {
    it('should clamp crop to top-left for focal point (0.0, 0.0)', () => {
      // 2000x1000 → 500x500 (1:1)
      // cropHeight = 1000, cropWidth = 1000
      // focalPixelX = 0, focalPixelY = 0
      // left = 0 - 500 = -500, top = 0 - 500 = -500
      // Clamp: left = max(0, -500) = 0, top = max(0, -500) = 0
      const result = calculateFocalPointCrop({
        originalWidth: 2000,
        originalHeight: 1000,
        targetWidth: 500,
        targetHeight: 500,
        focalX: 0.0,
        focalY: 0.0,
      });

      expect(result.left).toBe(0);
      expect(result.top).toBe(0);
      expect(result.width).toBe(1000);
      expect(result.height).toBe(1000);
    });

    it('should clamp crop to bottom-right for focal point (1.0, 1.0)', () => {
      // 2000x1000 → 500x500 (1:1)
      // cropHeight = 1000, cropWidth = 1000
      // focalPixelX = round(1.0 * 2000) = 2000, focalPixelY = round(1.0 * 1000) = 1000
      // left = 2000 - 500 = 1500, top = 1000 - 500 = 500
      // Clamp: left = max(0, min(1500, 2000-1000)) = min(1500, 1000) = 1000, top = max(0, min(500, 0)) = 0
      const result = calculateFocalPointCrop({
        originalWidth: 2000,
        originalHeight: 1000,
        targetWidth: 500,
        targetHeight: 500,
        focalX: 1.0,
        focalY: 1.0,
      });

      expect(result.left).toBe(1000);
      expect(result.top).toBe(0);
      expect(result.width).toBe(1000);
      expect(result.height).toBe(1000);
    });

    it('should clamp to bottom-right on a taller image for focal point (1.0, 1.0)', () => {
      // 1000x2000 → 500x500 (1:1)
      // originalAspect (0.5) < targetAspect (1.0) → crop vertically
      // cropWidth = 1000, cropHeight = round(1000 / 1) = 1000
      // focalPixelX = 1000, focalPixelY = 2000
      // left = 1000 - 500 = 500, top = 2000 - 500 = 1500
      // Clamp: left = max(0, min(500, 1000-1000)) = 0, top = max(0, min(1500, 2000-1000)) = 1000
      const result = calculateFocalPointCrop({
        originalWidth: 1000,
        originalHeight: 2000,
        targetWidth: 500,
        targetHeight: 500,
        focalX: 1.0,
        focalY: 1.0,
      });

      expect(result.left).toBe(0);
      expect(result.top).toBe(1000);
      expect(result.width).toBe(1000);
      expect(result.height).toBe(1000);
    });
  });

  describe('same aspect ratio', () => {
    it('should return full image when aspect ratios match exactly', () => {
      // 1920x1080 → 960x540 (same 16:9 aspect ratio)
      // originalAspect = targetAspect → goes to else branch
      // cropWidth = 1920, cropHeight = round(1920 / (960/540)) = round(1920 / 1.777...) = 1080
      const result = calculateFocalPointCrop({
        originalWidth: 1920,
        originalHeight: 1080,
        targetWidth: 960,
        targetHeight: 540,
        focalX: 0.5,
        focalY: 0.5,
      });

      expect(result.left).toBe(0);
      expect(result.top).toBe(0);
      expect(result.width).toBe(1920);
      expect(result.height).toBe(1080);
    });

    it('should return full image for identical dimensions', () => {
      const result = calculateFocalPointCrop({
        originalWidth: 800,
        originalHeight: 600,
        targetWidth: 800,
        targetHeight: 600,
        focalX: 0.5,
        focalY: 0.5,
      });

      expect(result.left).toBe(0);
      expect(result.top).toBe(0);
      expect(result.width).toBe(800);
      expect(result.height).toBe(600);
    });
  });

  describe('square conversions', () => {
    it('should crop vertically when converting square to landscape', () => {
      // 1000x1000 (1:1) → 800x400 (2:1)
      // originalAspect (1.0) < targetAspect (2.0) → else branch (crop vertically)
      // cropWidth = 1000, cropHeight = round(1000 / 2) = 500
      // focalPixelX = 500, focalPixelY = 500
      // left = 500 - 500 = 0, top = 500 - 250 = 250
      // Clamp: left = max(0, min(0, 0)) = 0, top = max(0, min(250, 1000-500)) = 250
      const result = calculateFocalPointCrop({
        originalWidth: 1000,
        originalHeight: 1000,
        targetWidth: 800,
        targetHeight: 400,
        focalX: 0.5,
        focalY: 0.5,
      });

      expect(result.width).toBe(1000);
      expect(result.height).toBe(500);
      expect(result.left).toBe(0);
      expect(result.top).toBe(250);
    });

    it('should crop horizontally when converting square to portrait', () => {
      // 1000x1000 (1:1) → 400x800 (0.5:1)
      // originalAspect (1.0) > targetAspect (0.5) → crop horizontally
      // cropHeight = 1000, cropWidth = round(1000 * 0.5) = 500
      // focalPixelX = 500, focalPixelY = 500
      // left = 500 - 250 = 250, top = 500 - 500 = 0
      // Clamp: left = max(0, min(250, 1000-500)) = 250, top = max(0, min(0, 0)) = 0
      const result = calculateFocalPointCrop({
        originalWidth: 1000,
        originalHeight: 1000,
        targetWidth: 400,
        targetHeight: 800,
        focalX: 0.5,
        focalY: 0.5,
      });

      expect(result.width).toBe(500);
      expect(result.height).toBe(1000);
      expect(result.left).toBe(250);
      expect(result.top).toBe(0);
    });
  });

  describe('out-of-range focal point clamping', () => {
    it('should clamp negative focal point values to 0', () => {
      const result = calculateFocalPointCrop({
        originalWidth: 2000,
        originalHeight: 1000,
        targetWidth: 500,
        targetHeight: 500,
        focalX: -0.5,
        focalY: -1.0,
      });

      // Same as (0.0, 0.0) — should be clamped to top-left
      const expected = calculateFocalPointCrop({
        originalWidth: 2000,
        originalHeight: 1000,
        targetWidth: 500,
        targetHeight: 500,
        focalX: 0.0,
        focalY: 0.0,
      });

      expect(result).toEqual(expected);
    });

    it('should clamp focal point values above 1 to 1', () => {
      const result = calculateFocalPointCrop({
        originalWidth: 2000,
        originalHeight: 1000,
        targetWidth: 500,
        targetHeight: 500,
        focalX: 1.5,
        focalY: 2.0,
      });

      // Same as (1.0, 1.0)
      const expected = calculateFocalPointCrop({
        originalWidth: 2000,
        originalHeight: 1000,
        targetWidth: 500,
        targetHeight: 500,
        focalX: 1.0,
        focalY: 1.0,
      });

      expect(result).toEqual(expected);
    });

    it('should clamp mixed out-of-range values correctly', () => {
      const result = calculateFocalPointCrop({
        originalWidth: 1000,
        originalHeight: 2000,
        targetWidth: 500,
        targetHeight: 500,
        focalX: -0.3,
        focalY: 5.0,
      });

      // Same as (0.0, 1.0)
      const expected = calculateFocalPointCrop({
        originalWidth: 1000,
        originalHeight: 2000,
        targetWidth: 500,
        targetHeight: 500,
        focalX: 0.0,
        focalY: 1.0,
      });

      expect(result).toEqual(expected);
    });
  });

  describe('crop region invariants', () => {
    it('should never produce a crop region extending beyond original bounds', () => {
      const testCases = [
        { focalX: 0, focalY: 0 },
        { focalX: 0.5, focalY: 0.5 },
        { focalX: 1, focalY: 1 },
        { focalX: 0.1, focalY: 0.9 },
        { focalX: 0.9, focalY: 0.1 },
      ];

      for (const { focalX, focalY } of testCases) {
        const result = calculateFocalPointCrop({
          originalWidth: 1920,
          originalHeight: 1080,
          targetWidth: 400,
          targetHeight: 400,
          focalX,
          focalY,
        });

        expect(result.left).toBeGreaterThanOrEqual(0);
        expect(result.top).toBeGreaterThanOrEqual(0);
        expect(result.left + result.width).toBeLessThanOrEqual(1920);
        expect(result.top + result.height).toBeLessThanOrEqual(1080);
      }
    });

    it('should always produce a crop matching the target aspect ratio', () => {
      const result = calculateFocalPointCrop({
        originalWidth: 3000,
        originalHeight: 2000,
        targetWidth: 1600,
        targetHeight: 900,
        focalX: 0.3,
        focalY: 0.7,
      });

      const targetAspect = 1600 / 900;
      const cropAspect = result.width / result.height;

      // Allow small rounding difference
      expect(Math.abs(cropAspect - targetAspect)).toBeLessThan(0.01);
    });

    it('should produce positive width and height', () => {
      const result = calculateFocalPointCrop({
        originalWidth: 100,
        originalHeight: 100,
        targetWidth: 50,
        targetHeight: 200,
        focalX: 0.5,
        focalY: 0.5,
      });

      expect(result.width).toBeGreaterThan(0);
      expect(result.height).toBeGreaterThan(0);
    });
  });

  describe('docstring example', () => {
    it('should compute correct crop for the docstring scenario', () => {
      // 2000x1500 → 400x400 with focal (0.3, 0.4)
      // originalAspect (1.333) > targetAspect (1.0) → crop horizontally
      // cropHeight = 1500, cropWidth = round(1500 * 1) = 1500
      // focalPixelX = round(0.3 * 2000) = 600, focalPixelY = round(0.4 * 1500) = 600
      // left = 600 - 750 = -150 → clamped to 0
      // top = 600 - 750 = -150 → clamped to 0
      const result = calculateFocalPointCrop({
        originalWidth: 2000,
        originalHeight: 1500,
        targetWidth: 400,
        targetHeight: 400,
        focalX: 0.3,
        focalY: 0.4,
      });

      expect(result).toEqual({ left: 0, top: 0, width: 1500, height: 1500 });
    });
  });

  describe('non-standard aspect ratios', () => {
    it('should handle 16:9 to 9:16 conversion (landscape to portrait)', () => {
      // 1920x1080 → 1080x1920 (9:16)
      // originalAspect (1.778) > targetAspect (0.5625) → crop horizontally
      // cropHeight = 1080, cropWidth = round(1080 * (1080/1920)) = round(1080 * 0.5625) = 608
      // Math.round(1080 * 9/16) = Math.round(607.5) = 608
      const result = calculateFocalPointCrop({
        originalWidth: 1920,
        originalHeight: 1080,
        targetWidth: 1080,
        targetHeight: 1920,
        focalX: 0.5,
        focalY: 0.5,
      });

      expect(result.height).toBe(1080);
      expect(result.width).toBe(608);
      // Centered: left = 960 - 304 = 656
      expect(result.left).toBe(656);
      expect(result.top).toBe(0);
    });

    it('should handle very wide panoramic crop', () => {
      // 1000x1000 → 500x100 (5:1 aspect)
      // originalAspect (1.0) < targetAspect (5.0) → crop vertically
      // cropWidth = 1000, cropHeight = round(1000 / 5) = 200
      // focalPixelX = 500, focalPixelY = 500
      // left = 500 - 500 = 0, top = 500 - 100 = 400
      const result = calculateFocalPointCrop({
        originalWidth: 1000,
        originalHeight: 1000,
        targetWidth: 500,
        targetHeight: 100,
        focalX: 0.5,
        focalY: 0.5,
      });

      expect(result.width).toBe(1000);
      expect(result.height).toBe(200);
      expect(result.left).toBe(0);
      expect(result.top).toBe(400);
    });

    it('should handle very tall portrait crop', () => {
      // 1000x1000 → 100x500 (0.2:1 aspect)
      // originalAspect (1.0) > targetAspect (0.2) → crop horizontally
      // cropHeight = 1000, cropWidth = round(1000 * 0.2) = 200
      // focalPixelX = 500, focalPixelY = 500
      // left = 500 - 100 = 400, top = 500 - 500 = 0
      const result = calculateFocalPointCrop({
        originalWidth: 1000,
        originalHeight: 1000,
        targetWidth: 100,
        targetHeight: 500,
        focalX: 0.5,
        focalY: 0.5,
      });

      expect(result.width).toBe(200);
      expect(result.height).toBe(1000);
      expect(result.left).toBe(400);
      expect(result.top).toBe(0);
    });
  });
});

describe('isValidFocalPoint', () => {
  describe('valid inputs', () => {
    it('should return true for center point', () => {
      expect(isValidFocalPoint({ x: 0.5, y: 0.5 })).toBe(true);
    });

    it('should return true for origin (0, 0)', () => {
      expect(isValidFocalPoint({ x: 0, y: 0 })).toBe(true);
    });

    it('should return true for max (1, 1)', () => {
      expect(isValidFocalPoint({ x: 1, y: 1 })).toBe(true);
    });

    it('should return true for boundary values', () => {
      expect(isValidFocalPoint({ x: 0, y: 1 })).toBe(true);
      expect(isValidFocalPoint({ x: 1, y: 0 })).toBe(true);
    });

    it('should return true for arbitrary valid values', () => {
      expect(isValidFocalPoint({ x: 0.123, y: 0.987 })).toBe(true);
      expect(isValidFocalPoint({ x: 0.001, y: 0.999 })).toBe(true);
    });
  });

  describe('invalid inputs', () => {
    it('should return false for null', () => {
      expect(isValidFocalPoint(null)).toBe(false);
    });

    it('should return false for undefined', () => {
      expect(isValidFocalPoint(undefined)).toBe(false);
    });

    it('should return false for primitive types', () => {
      expect(isValidFocalPoint(42)).toBe(false);
      expect(isValidFocalPoint('0.5,0.5')).toBe(false);
      expect(isValidFocalPoint(true)).toBe(false);
    });

    it('should return false for empty object', () => {
      expect(isValidFocalPoint({})).toBe(false);
    });

    it('should return false for object missing y', () => {
      expect(isValidFocalPoint({ x: 0.5 })).toBe(false);
    });

    it('should return false for object missing x', () => {
      expect(isValidFocalPoint({ y: 0.5 })).toBe(false);
    });

    it('should return false for non-number x or y', () => {
      expect(isValidFocalPoint({ x: '0.5', y: 0.5 })).toBe(false);
      expect(isValidFocalPoint({ x: 0.5, y: '0.5' })).toBe(false);
    });

    it('should return false for out-of-range x', () => {
      expect(isValidFocalPoint({ x: -0.1, y: 0.5 })).toBe(false);
      expect(isValidFocalPoint({ x: 1.1, y: 0.5 })).toBe(false);
    });

    it('should return false for out-of-range y', () => {
      expect(isValidFocalPoint({ x: 0.5, y: -0.1 })).toBe(false);
      expect(isValidFocalPoint({ x: 0.5, y: 1.1 })).toBe(false);
    });

    it('should return false for NaN values', () => {
      expect(isValidFocalPoint({ x: NaN, y: 0.5 })).toBe(false);
      expect(isValidFocalPoint({ x: 0.5, y: NaN })).toBe(false);
    });

    it('should return false for arrays', () => {
      expect(isValidFocalPoint([0.5, 0.5])).toBe(false);
    });
  });
});

describe('DEFAULT_FOCAL_POINT', () => {
  it('should equal { x: 0.5, y: 0.5 }', () => {
    expect(DEFAULT_FOCAL_POINT).toEqual({ x: 0.5, y: 0.5 });
  });

  it('should have numeric x and y properties', () => {
    expect(typeof DEFAULT_FOCAL_POINT.x).toBe('number');
    expect(typeof DEFAULT_FOCAL_POINT.y).toBe('number');
  });

  it('should be a valid focal point', () => {
    expect(isValidFocalPoint(DEFAULT_FOCAL_POINT)).toBe(true);
  });
});
