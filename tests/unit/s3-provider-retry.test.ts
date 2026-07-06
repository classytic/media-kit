import { describe, it, expect, vi } from 'vitest';
import { Readable } from 'node:stream';
import { S3Provider } from '../../src/providers/s3.provider';

/**
 * Verifies the write() retry contract:
 *   - Buffer bodies ARE retried, with the PutObjectCommand rebuilt per attempt
 *     so each attempt carries the full, intact body.
 *   - Stream bodies are NOT retried — a consumed stream would re-send
 *     truncated/empty data.
 */

interface FakeCommand {
  input: { Body: unknown; Key: string; Bucket: string; ContentType: string };
}

function makeProvider(sendImpl: (command: FakeCommand) => Promise<unknown>) {
  const provider = new S3Provider({ bucket: 'test-bucket', region: 'us-east-1' });
  const send = vi.fn(sendImpl);
  // Inject a fake client past the lazy SDK init
  (provider as unknown as { client: unknown }).client = { send };
  (provider as unknown as { sdkAvailable: boolean }).sdkAvailable = true;
  return { provider, send };
}

const transientError = () => Object.assign(new Error('socket blew up'), { code: 'ECONNRESET' });

describe('S3Provider.write retry behavior', () => {
  it('retries Buffer bodies with a fresh command carrying the intact body', async () => {
    const buffer = Buffer.from('full body content that must survive the retry');
    const seen: FakeCommand[] = [];
    let calls = 0;

    const { provider, send } = makeProvider(async (command) => {
      seen.push(command);
      calls++;
      if (calls === 1) throw transientError();
      return {};
    });

    const result = await provider.write('uploads/file.bin', buffer, 'application/octet-stream');

    expect(send).toHaveBeenCalledTimes(2);
    // Command rebuilt per attempt — never the same (possibly consumed) instance
    expect(seen[0]).not.toBe(seen[1]);
    // Both attempts carried the full body
    expect(seen[0]!.input.Body).toBe(buffer);
    expect(seen[1]!.input.Body).toBe(buffer);
    expect((seen[1]!.input.Body as Buffer).toString()).toBe(
      'full body content that must survive the retry',
    );
    expect(result.size).toBe(buffer.length);
    expect(result.key).toBe('uploads/file.bin');
  });

  it('does NOT retry stream bodies — single attempt, transient error propagates', async () => {
    const stream = Readable.from([Buffer.from('chunk-1'), Buffer.from('chunk-2')]);

    const { provider, send } = makeProvider(async () => {
      throw transientError();
    });

    await expect(
      provider.write('uploads/file.bin', stream, 'application/octet-stream'),
    ).rejects.toThrow('socket blew up');

    expect(send).toHaveBeenCalledTimes(1);
  });

  it('still fails fast on non-retryable errors for Buffer bodies', async () => {
    const { provider, send } = makeProvider(async () => {
      throw Object.assign(new Error('Access Denied'), { $metadata: { httpStatusCode: 403 } });
    });

    await expect(
      provider.write('uploads/file.bin', Buffer.from('x'), 'text/plain'),
    ).rejects.toThrow('Access Denied');

    expect(send).toHaveBeenCalledTimes(1);
  });
});
