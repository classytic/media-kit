import { describe, it, expect } from 'vitest';
import { generateKey, generateScopedKey, tenantKeySegment, assertGeneratedKeyShape } from '../../src/operations/helpers';

const VALID_BASENAME = `${Date.now()}-abcdef012345-photo.jpg`;
const ORG = '507f1f77bcf86cd799439011';

describe('assertGeneratedKeyShape', () => {
  it('accepts keys produced by generateKey (incl. nested folders + weird filenames)', () => {
    for (const [filename, folder] of [
      ['photo.jpg', 'uploads'],
      ['my photo (final).PNG', 'products/featured/summer'],
      ['no-extension', 'general'],
      ['.hidden.png', 'uploads'],
      ['über naïve.webp', 'a/b/c/d'],
    ] as const) {
      const key = generateKey(filename, folder);
      const shape = assertGeneratedKeyShape(key);
      expect(shape.tenantSegment).toBeUndefined();
      expect(shape.folder).toBe(folder);
    }
  });

  it('extracts the tenant segment + clean folder from tenant-scoped keys', () => {
    for (const folder of ['uploads', 'products/featured/summer']) {
      const key = generateScopedKey('photo.jpg', folder, ORG);
      const shape = assertGeneratedKeyShape(key);
      expect(shape.tenantSegment).toBe(tenantKeySegment(ORG));
      expect(shape.folder).toBe(folder);
    }
  });

  it('generateScopedKey without a tenant matches generateKey format exactly', () => {
    const key = generateScopedKey('photo.jpg', 'uploads');
    const shape = assertGeneratedKeyShape(key);
    expect(shape.tenantSegment).toBeUndefined();
    expect(shape.folder).toBe('uploads');
  });

  it('sanitizes hostile organizationIds into the segment charset', () => {
    const key = generateScopedKey('photo.jpg', 'uploads', '../evil/$id with spaces');
    const shape = assertGeneratedKeyShape(key);
    expect(shape.tenantSegment).toBe('__t-___evil__id_with_spaces');
    expect(shape.folder).toBe('uploads');
  });

  it('a folder literally named t-shirts is NOT mistaken for a tenant segment', () => {
    const key = generateKey('photo.jpg', 'products/t-shirts');
    const shape = assertGeneratedKeyShape(key);
    expect(shape.tenantSegment).toBeUndefined();
    expect(shape.folder).toBe('products/t-shirts');
  });

  it('rejects reserved __t- segments in the folder path or as the only prefix', () => {
    for (const key of [
      `__t-${ORG}/${VALID_BASENAME}`, // tenant segment with no folder prefix
      `uploads/__t-${ORG}/x/${VALID_BASENAME}`, // reserved prefix inside folder path
      `uploads/__t-!bad!/${VALID_BASENAME}`, // segment outside sanitizer charset
    ]) {
      expect(() => assertGeneratedKeyShape(key)).toThrow(/Invalid storage key/);
    }
  });

  it('rejects hand-crafted keys that lack the generated basename shape', () => {
    for (const key of [
      `uploads/evil.jpg`,
      `uploads/${Date.now()}-XYZ-photo.jpg`, // random segment not 12 hex chars
      `uploads/${Date.now()}-ABCDEF012345-photo.jpg`, // uppercase hex never generated
      `uploads/123-abcdef012345-photo.jpg`, // timestamp too short
      VALID_BASENAME, // missing folder prefix
    ]) {
      expect(() => assertGeneratedKeyShape(key)).toThrow(/Invalid storage key/);
    }
  });

  it('rejects traversal / malformed paths with a 400 HttpError', () => {
    for (const key of [
      `../secrets/${VALID_BASENAME}`,
      `uploads/../other/${VALID_BASENAME}`,
      `/uploads/${VALID_BASENAME}`,
      `uploads//${VALID_BASENAME}`,
      `uploads\\${VALID_BASENAME}`,
      `https://evil.example.com/${VALID_BASENAME}`,
      `uploads/./${VALID_BASENAME}`,
    ]) {
      try {
        assertGeneratedKeyShape(key);
        expect.unreachable(`expected rejection for key: ${key}`);
      } catch (err) {
        const e = err as Error & { status?: number; code?: string };
        expect(e.status).toBe(400);
        expect(e.code).toBe('media.confirm.invalid_key');
      }
    }
  });
});
