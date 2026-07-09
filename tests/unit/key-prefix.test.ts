import { describe, it, expect } from 'vitest';
import {
  generateKey,
  generateScopedKey,
  normalizeKeyPrefix,
  tenantKeySegment,
} from '../../src/operations/helpers';

const ORG = '507f1f77bcf86cd799439011';

describe('normalizeKeyPrefix', () => {
  it('empty / undefined → ""', () => {
    expect(normalizeKeyPrefix()).toBe('');
    expect(normalizeKeyPrefix('')).toBe('');
    expect(normalizeKeyPrefix('   ')).toBe('');
  });
  it('trims + strips leading/trailing slashes + collapses repeats', () => {
    expect(normalizeKeyPrefix('/eternal/')).toBe('eternal');
    expect(normalizeKeyPrefix('  eternal  ')).toBe('eternal');
    expect(normalizeKeyPrefix('a//b')).toBe('a/b');
    expect(normalizeKeyPrefix('///a///b///')).toBe('a/b');
  });
});

describe('generateKey — deployment keyPrefix', () => {
  it('NO prefix is byte-identical to the classic shape (back-compatible)', () => {
    const k = generateKey('photo.jpg', 'products');
    // folder/<ts>-<12hex>-<name>.<ext>
    expect(k).toMatch(/^products\/\d+-[0-9a-f]{12}-photo\.jpg$/);
    // Passing empty/undefined prefix must not change the shape.
    expect(generateKey('photo.jpg', 'products', '')).toMatch(/^products\//);
    expect(generateKey('photo.jpg', 'products', undefined)).toMatch(/^products\//);
  });

  it('prefix namespaces the KEY: <prefix>/<folder>/<file>', () => {
    const k = generateKey('photo.jpg', 'products', 'eternal');
    expect(k).toMatch(/^eternal\/products\/\d+-[0-9a-f]{12}-photo\.jpg$/);
  });

  it('normalizes a messy prefix', () => {
    expect(generateKey('a.png', 'general', '/eternal/')).toMatch(/^eternal\/general\//);
  });

  it('two deployments in one bucket land under distinct roots', () => {
    const a = generateKey('x.jpg', 'general', 'eternal');
    const b = generateKey('x.jpg', 'general', 'bigboss');
    expect(a.startsWith('eternal/general/')).toBe(true);
    expect(b.startsWith('bigboss/general/')).toBe(true);
  });
});

describe('generateScopedKey — prefix composes with tenant segment', () => {
  it('no org, no prefix → classic', () => {
    expect(generateScopedKey('f.jpg', 'general')).toMatch(/^general\//);
  });
  it('prefix, no org → <prefix>/<folder>/<file>', () => {
    expect(generateScopedKey('f.jpg', 'general', undefined, 'eternal')).toMatch(/^eternal\/general\//);
  });
  it('prefix + org → <prefix>/<folder>/__t-<org>/<file> (deployment root outermost)', () => {
    const k = generateScopedKey('f.jpg', 'products', ORG, 'eternal');
    expect(k).toMatch(new RegExp(`^eternal/products/${tenantKeySegment(ORG)}/\\d+-[0-9a-f]{12}-f\\.jpg$`));
  });
});
