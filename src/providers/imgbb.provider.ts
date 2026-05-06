/**
 * imgbb Storage Driver
 *
 * Implements StorageDriver for imgbb — a free public image-hosting API.
 * imgbb is write-once: images are uploaded via a base64 POST and accessed
 * via a stable public URL. Delete is best-effort via a dedicated delete URL.
 *
 * Key encoding: `<displayUrl>\n<deleteUrl>` — the newline cannot appear in
 * HTTP URLs, making it a safe compound separator. `getPublicUrl(key)` and
 * `delete(key)` both parse this format. `read()` / `stat()` / `exists()`
 * proxy to the public URL via HTTP — imgbb has no read-by-key API.
 *
 * Unsupported operations (presigned uploads, multipart, list, copy, move)
 * throw `UnsupportedOperationError` — do not implement them as imgbb has no
 * equivalent API.
 *
 * @example
 * ```ts
 * import { ImgbbProvider } from '@classytic/media-kit/providers/imgbb';
 *
 * const engine = await createMedia({
 *   connection: mongoose.connection,
 *   driver: new ImgbbProvider({ apiKey: process.env.IMGBB_KEY }),
 *   tenant: { enabled: true, field: 'organizationId' },
 *   processing: { enabled: false }, // imgbb stores originals only
 * });
 * ```
 */

import { Readable } from 'node:stream';
import type { FileStat, StorageDriver, WriteResult } from '../types.js';

/** Separator that cannot appear in HTTP URLs. */
const SEP = '\n';

export interface ImgbbProviderConfig {
  /** imgbb API key — https://api.imgbb.com/ */
  apiKey: string;
}

interface ImgbbUploadResponse {
  success?: boolean;
  data?: {
    id: string;
    display_url: string;
    delete_url: string;
    width: number;
    height: number;
  };
  error?: { message?: string };
}

function parseKey(key: string): { displayUrl: string; deleteUrl: string | undefined } {
  const idx = key.indexOf(SEP);
  if (idx === -1) return { displayUrl: key, deleteUrl: undefined };
  return { displayUrl: key.slice(0, idx), deleteUrl: key.slice(idx + 1) };
}

async function toBuffer(data: Buffer | NodeJS.ReadableStream): Promise<Buffer> {
  if (Buffer.isBuffer(data)) return data;
  const chunks: Buffer[] = [];
  for await (const chunk of data as AsyncIterable<unknown>) {
    if (Buffer.isBuffer(chunk)) chunks.push(chunk);
    else if (chunk instanceof Uint8Array) chunks.push(Buffer.from(chunk));
    else if (typeof chunk === 'string') chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/**
 * imgbb Storage Driver — plug into any @classytic/media-kit engine.
 */
export class ImgbbProvider implements StorageDriver {
  readonly name = 'imgbb';
  private readonly apiKey: string;

  constructor(config: ImgbbProviderConfig) {
    if (!config.apiKey) throw new Error('ImgbbProvider: apiKey is required');
    this.apiKey = config.apiKey;
  }

  /**
   * Upload a file to imgbb.
   *
   * The `key` parameter is used as the imgbb image name (filename without
   * extension). The returned composite key encodes both the public display URL
   * and the delete URL so that `delete()` and `getPublicUrl()` can work purely
   * from the stored key — no extra database columns needed.
   */
  async write(key: string, data: Buffer | NodeJS.ReadableStream, _contentType: string): Promise<WriteResult> {
    const buffer = await toBuffer(data);
    const base64 = buffer.toString('base64');

    // Use the key (filename) as the imgbb image name — strip extension.
    const name = key.replace(/\.[^.]+$/, '').replace(/[/\\]/g, '_');

    const body = new URLSearchParams();
    body.set('image', base64);
    body.set('name', name);

    const res = await fetch(`https://api.imgbb.com/1/upload?key=${this.apiKey}`, {
      method: 'POST',
      body,
    });

    const json = (await res.json()) as ImgbbUploadResponse;

    if (!res.ok || !json.success || !json.data) {
      throw new Error(json.error?.message ?? `imgbb upload failed (${res.status})`);
    }

    const { display_url, delete_url } = json.data;
    const compositeKey = display_url + SEP + delete_url;

    return {
      key: compositeKey,
      url: display_url,
      size: buffer.length,
      metadata: {
        id: json.data.id,
        displayUrl: display_url,
        deleteUrl: delete_url,
        ...(json.data.width !== undefined && { width: json.data.width }),
        ...(json.data.height !== undefined && { height: json.data.height }),
      },
    };
  }

  /**
   * Read a file by proxying a GET to the imgbb public URL.
   * imgbb has no read-by-key API — the public URL is the only access path.
   */
  async read(key: string): Promise<NodeJS.ReadableStream> {
    const { displayUrl } = parseKey(key);
    const res = await fetch(displayUrl);

    if (!res.ok) {
      throw new Error(`imgbb read failed (${res.status}): ${displayUrl}`);
    }
    if (!res.body) throw new Error('imgbb response has no body');

    // Convert Web ReadableStream → Node.js ReadableStream
    return Readable.fromWeb(res.body as import('stream/web').ReadableStream);
  }

  /**
   * Delete an image from imgbb via its delete URL (best-effort GET).
   * Returns true regardless — imgbb deletion is advisory, not guaranteed.
   */
  async delete(key: string): Promise<boolean> {
    const { deleteUrl } = parseKey(key);
    if (!deleteUrl) return false;

    try {
      await fetch(deleteUrl, { method: 'GET' });
    } catch {
      // Best-effort — network failures must not block DB removal.
    }
    return true;
  }

  /**
   * Check if the imgbb URL is still accessible.
   */
  async exists(key: string): Promise<boolean> {
    const { displayUrl } = parseKey(key);
    try {
      const res = await fetch(displayUrl, { method: 'HEAD' });
      return res.ok;
    } catch {
      return false;
    }
  }

  /**
   * Get file metadata via HTTP HEAD on the imgbb URL.
   */
  async stat(key: string): Promise<FileStat> {
    const { displayUrl } = parseKey(key);
    const res = await fetch(displayUrl, { method: 'HEAD' });

    if (!res.ok) {
      throw new Error(`imgbb stat failed (${res.status}): ${displayUrl}`);
    }

    const lastModifiedRaw = res.headers.get('last-modified');
    return {
      size: Number(res.headers.get('content-length') ?? 0),
      contentType: res.headers.get('content-type') ?? 'application/octet-stream',
      lastModified: lastModifiedRaw ? new Date(lastModifiedRaw) : undefined,
    };
  }

  /**
   * Extract the imgbb public display URL from the composite key.
   */
  getPublicUrl(key: string): string {
    return parseKey(key).displayUrl;
  }
}

export default ImgbbProvider;
