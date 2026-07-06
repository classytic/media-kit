import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Readable } from 'node:stream';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { LocalProvider } from '../../src/providers/local.provider';

describe('LocalProvider — partial file cleanup on failed stream pipeline', () => {
  let dir: string;
  let provider: LocalProvider;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mk-local-partial-'));
    provider = new LocalProvider({ basePath: dir, baseUrl: 'http://localhost:3000/uploads' });
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('unlinks the partial file when the source stream errors mid-write', async () => {
    let pushed = 0;
    const source = new Readable({
      read() {
        pushed++;
        if (pushed <= 2) {
          this.push(Buffer.alloc(1024, 1));
        } else {
          this.destroy(new Error('source stream broke'));
        }
      },
    });

    await expect(
      provider.write('sub/partial.bin', source, 'application/octet-stream'),
    ).rejects.toThrow('source stream broke');

    // The partial file must not linger on disk
    await expect(fs.access(path.join(dir, 'sub', 'partial.bin'))).rejects.toThrow();
  });

  it('successful stream writes are unaffected', async () => {
    const source = Readable.from([Buffer.from('hello '), Buffer.from('world')]);
    const result = await provider.write('sub/ok.txt', source, 'text/plain');
    expect(result.size).toBe(11);
    const written = await fs.readFile(path.join(dir, 'sub', 'ok.txt'), 'utf-8');
    expect(written).toBe('hello world');
  });
});
