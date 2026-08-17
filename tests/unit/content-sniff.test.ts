/**
 * Magic-byte content sniffing (strict-profile validation).
 */

import { describe, it, expect } from 'vitest';
import { sniffContentKind, detectDangerousMismatch } from '../../src/utils/content-sniff';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBP')]);
const PDF = Buffer.from('%PDF-1.7\n...');
const HTML = Buffer.from('<!DOCTYPE html><html><script>alert(1)</script></html>');
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
const SVG_WS = Buffer.from('\n  \t<svg onload="alert(1)"></svg>');

describe('sniffContentKind', () => {
  it('detects common binary signatures', () => {
    expect(sniffContentKind(PNG)).toBe('png');
    expect(sniffContentKind(JPEG)).toBe('jpeg');
    expect(sniffContentKind(WEBP)).toBe('webp');
    expect(sniffContentKind(PDF)).toBe('pdf');
  });

  it('detects active-content text shapes (even with leading whitespace/BOM)', () => {
    expect(sniffContentKind(HTML)).toBe('html');
    expect(sniffContentKind(SVG)).toBe('svg');
    expect(sniffContentKind(SVG_WS)).toBe('svg');
  });

  it('returns unknown for unrecognized bytes (never a false reject)', () => {
    expect(sniffContentKind(Buffer.from([0x00, 0x01, 0x02, 0x99]))).toBe('unknown');
    expect(sniffContentKind(Buffer.from(''))).toBe('unknown');
  });
});

describe('detectDangerousMismatch', () => {
  it('REJECTS HTML declared as an image (stored-XSS vector)', () => {
    expect(detectDangerousMismatch(HTML, 'image/png')).toMatch(/HTML/);
  });

  it('REJECTS SVG declared as a raster image', () => {
    expect(detectDangerousMismatch(SVG, 'image/jpeg')).toMatch(/SVG/);
  });

  it('REJECTS HTML declared as SVG', () => {
    expect(detectDangerousMismatch(HTML, 'image/svg+xml')).toMatch(/HTML, not SVG/);
  });

  it('ALLOWS a real SVG declared as image/svg+xml', () => {
    expect(detectDangerousMismatch(SVG, 'image/svg+xml')).toBeNull();
  });

  it('ALLOWS matching binary content', () => {
    expect(detectDangerousMismatch(PNG, 'image/png')).toBeNull();
    expect(detectDangerousMismatch(WEBP, 'image/webp')).toBeNull();
  });

  it('ALLOWS HTML declared as text/html (not an inert binary type)', () => {
    expect(detectDangerousMismatch(HTML, 'text/html')).toBeNull();
  });

  it('does not reject content it cannot recognize', () => {
    expect(detectDangerousMismatch(Buffer.from([0, 1, 2, 3, 4]), 'image/png')).toBeNull();
  });
});
