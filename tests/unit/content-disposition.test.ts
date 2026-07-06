import { describe, it, expect } from 'vitest';
import { contentDispositionAttachment } from '../../src/utils/content-disposition';

describe('contentDispositionAttachment', () => {
  it('passes plain ASCII filenames through quoted', () => {
    expect(contentDispositionAttachment('report.pdf')).toBe('attachment; filename="report.pdf"');
    expect(contentDispositionAttachment('my file (1).txt')).toBe('attachment; filename="my file (1).txt"');
  });

  it('neutralizes double quotes and backslashes in the fallback', () => {
    const header = contentDispositionAttachment('evil".pdf;x="y');
    expect(header).toBe('attachment; filename="evil_.pdf;x=_y"');
    // The quoted-string must not contain an unescaped quote
    expect(header.match(/"/g)!.length).toBe(2);
  });

  it('strips CR/LF and other control characters (header injection)', () => {
    const header = contentDispositionAttachment('a\r\nSet-Cookie: x=1 .txt');
    expect(header).not.toMatch(/[\r\n]/);
    expect(header).toBe('attachment; filename="aSet-Cookie: x=1 .txt"');
  });

  it('emits RFC 5987 filename* for unicode names with an ASCII fallback', () => {
    const header = contentDispositionAttachment('räksmörgås.jpg');
    expect(header).toBe(
      'attachment; filename="r_ksm_rg_s.jpg"; filename*=UTF-8' + "''" + 'r%C3%A4ksm%C3%B6rg%C3%A5s.jpg',
    );
  });

  it('percent-encodes RFC 5987 specials in the extended form', () => {
    const header = contentDispositionAttachment("naïve'(*).png");
    expect(header).toContain("filename*=UTF-8''na%C3%AFve%27%28%2A%29.png");
  });

  it('falls back to "download" when everything is stripped', () => {
    expect(contentDispositionAttachment('\r\n')).toBe('attachment; filename="download"');
  });
});
