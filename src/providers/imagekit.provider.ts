/**
 * ImageKit Storage Driver
 *
 * Implements StorageDriver for ImageKit — a managed image CDN with built-in
 * optimization, transformations, and real-time image processing.
 *
 * Unlike S3/local drivers, ImageKit is a transformation-first CDN. The driver:
 *   - Uploads via ImageKit's Upload API (multipart/form-data, buffer input)
 *   - Returns a composite key `fileId\nfilePath` where filePath allows
 *     URL reconstruction with CDN transformations appended
 *   - Deletes via ImageKit's Management API using the fileId
 *   - Lists via ImageKit's file list API (async generator)
 *
 * Key encoding: `{fileId}\n{filePath}` — newline cannot appear in these fields.
 *   - `getPublicUrl(key)` → urlEndpoint + filePath  (transformation-ready URL)
 *   - `delete(key)` → DELETE /v1/files/{fileId}
 *
 * ImageKit transformation URLs are automatically supported since the base URL
 * is reconstructed from the stored filePath + urlEndpoint. Append ImageKit
 * transformation strings to the URL as needed: `url + '?tr=w-400,h-300'`.
 *
 * @example
 * ```ts
 * import { ImageKitProvider } from '@classytic/media-kit/providers/imagekit';
 *
 * const engine = await createMedia({
 *   connection: mongoose.connection,
 *   driver: new ImageKitProvider({
 *     publicKey: process.env.IMAGEKIT_PUBLIC_KEY,
 *     privateKey: process.env.IMAGEKIT_PRIVATE_KEY,
 *     urlEndpoint: 'https://ik.imagekit.io/your-id',
 *   }),
 *   processing: { enabled: false }, // ImageKit handles optimization
 * });
 * ```
 */

import { Readable } from 'node:stream';
import type { FileStat, StorageDriver, WriteResult } from '../types.js';

const UPLOAD_URL = 'https://upload.imagekit.io/api/v1/files/upload';
const API_URL = 'https://api.imagekit.io/v1';

/** Separator that cannot appear in fileId or filePath. */
const SEP = '\n';

export interface ImageKitProviderConfig {
  /** ImageKit public key */
  publicKey: string;
  /** ImageKit private key (used for upload/delete auth) */
  privateKey: string;
  /** CDN URL endpoint, e.g. 'https://ik.imagekit.io/your-imagekit-id' */
  urlEndpoint: string;
  /**
   * Default folder for uploads (e.g. 'shajghor/media').
   * Defaults to '' (root).
   */
  defaultFolder?: string;
  /**
   * Whether ImageKit should auto-generate unique filenames.
   * Defaults to true (recommended — avoids collisions).
   */
  useUniqueFileName?: boolean;
}

/** Upload API response from ImageKit. */
interface ImageKitUploadResponse {
  fileId: string;
  name: string;
  url: string;
  thumbnailUrl?: string;
  height?: number;
  width?: number;
  size: number;
  filePath: string;
  fileType?: string;
}

/** File detail from management API. */
interface ImageKitFileDetail {
  fileId: string;
  name: string;
  url: string;
  filePath: string;
  size: number;
  height?: number;
  width?: number;
  mime?: string;
  createdAt?: string;
  updatedAt?: string;
}

function parseKey(key: string): { fileId: string; filePath: string } {
  const idx = key.indexOf(SEP);
  if (idx === -1) return { fileId: key, filePath: key };
  return { fileId: key.slice(0, idx), filePath: key.slice(idx + 1) };
}

function toBuffer(data: Buffer | NodeJS.ReadableStream): Promise<Buffer> {
  if (Buffer.isBuffer(data)) return Promise.resolve(data);
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    (data as NodeJS.ReadableStream).on('data', (chunk: Buffer | string) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    (data as NodeJS.ReadableStream).on('end', () => resolve(Buffer.concat(chunks)));
    (data as NodeJS.ReadableStream).on('error', reject);
  });
}

/**
 * ImageKit Storage Driver — plug into any @classytic/media-kit engine.
 */
export class ImageKitProvider implements StorageDriver {
  readonly name = 'imagekit';

  private readonly privateKey: string;
  private readonly urlEndpoint: string;
  private readonly defaultFolder: string;
  private readonly useUniqueFileName: boolean;
  private readonly authHeader: string;

  constructor(config: ImageKitProviderConfig) {
    if (!config.privateKey) throw new Error('ImageKitProvider: privateKey is required');
    if (!config.urlEndpoint) throw new Error('ImageKitProvider: urlEndpoint is required');

    this.privateKey = config.privateKey;
    this.urlEndpoint = config.urlEndpoint.replace(/\/+$/, '');
    this.defaultFolder = config.defaultFolder ?? '';
    this.useUniqueFileName = config.useUniqueFileName ?? true;

    // Basic auth: privateKey + ':' (empty password), base64-encoded
    this.authHeader = 'Basic ' + Buffer.from(this.privateKey + ':').toString('base64');
  }

  /**
   * Upload a file to ImageKit.
   *
   * The `key` parameter is used as the base filename (without extension is
   * fine — ImageKit preserves extension from the buffer content type).
   * Returns a composite key `fileId\nfilePath` so that `getPublicUrl` and
   * `delete` both work from the stored key.
   */
  async write(key: string, data: Buffer | NodeJS.ReadableStream, contentType: string): Promise<WriteResult> {
    const buffer = await toBuffer(data);

    // Derive filename from key — use basename if key includes path separators.
    const filename = key.split('/').pop() ?? key;

    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(buffer)], { type: contentType }), filename);
    form.append('fileName', filename);
    if (this.defaultFolder) form.append('folder', this.defaultFolder);
    form.append('useUniqueFileName', String(this.useUniqueFileName));

    const res = await fetch(UPLOAD_URL, {
      method: 'POST',
      headers: { Authorization: this.authHeader },
      body: form,
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`ImageKit upload failed (${res.status}): ${body}`);
    }

    const json = (await res.json()) as ImageKitUploadResponse;

    // Composite key: fileId (for delete) + filePath (for URL reconstruction).
    const compositeKey = json.fileId + SEP + json.filePath;

    return {
      key: compositeKey,
      url: json.url,
      size: json.size,
      metadata: {
        fileId: json.fileId,
        filePath: json.filePath,
        name: json.name,
        ...(json.width !== undefined && { width: json.width }),
        ...(json.height !== undefined && { height: json.height }),
        ...(json.fileType !== undefined && { fileType: json.fileType }),
      },
    };
  }

  /**
   * Read a file by proxying a GET to the ImageKit CDN URL.
   */
  async read(key: string): Promise<NodeJS.ReadableStream> {
    const url = this.getPublicUrl(key);
    const res = await fetch(url);

    if (!res.ok) {
      throw new Error(`ImageKit read failed (${res.status}): ${url}`);
    }
    if (!res.body) throw new Error('ImageKit response has no body');

    return Readable.fromWeb(res.body as import('stream/web').ReadableStream);
  }

  /**
   * Delete a file from ImageKit via the Management API using its fileId.
   */
  async delete(key: string): Promise<boolean> {
    const { fileId } = parseKey(key);

    const res = await fetch(`${API_URL}/files/${fileId}`, {
      method: 'DELETE',
      headers: { Authorization: this.authHeader },
    });

    // 404 = already gone — treat as success.
    if (res.status === 404) return true;
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`ImageKit delete failed (${res.status}): ${body}`);
    }
    return true;
  }

  /**
   * Check if a file is still accessible at its CDN URL.
   */
  async exists(key: string): Promise<boolean> {
    const url = this.getPublicUrl(key);
    try {
      const res = await fetch(url, { method: 'HEAD' });
      return res.ok;
    } catch {
      return false;
    }
  }

  /**
   * Get file metadata from ImageKit's Management API.
   */
  async stat(key: string): Promise<FileStat> {
    const { fileId } = parseKey(key);

    const res = await fetch(`${API_URL}/files/${fileId}/details`, {
      headers: { Authorization: this.authHeader },
    });

    if (!res.ok) {
      throw new Error(`ImageKit stat failed (${res.status}): fileId=${fileId}`);
    }

    const json = (await res.json()) as ImageKitFileDetail;
    return {
      size: json.size,
      contentType: json.mime ?? 'application/octet-stream',
      lastModified: json.updatedAt ? new Date(json.updatedAt) : undefined,
    };
  }

  /**
   * List files under a folder prefix using ImageKit's file list API.
   * Yields composite keys (fileId\nfilePath) for each file found.
   */
  async *list(prefix: string): AsyncIterable<string> {
    const folder = prefix ? `/${prefix.replace(/^\//, '')}` : '/';
    let skip = 0;
    const limit = 100;

    while (true) {
      const params = new URLSearchParams({
        path: folder,
        skip: String(skip),
        limit: String(limit),
      });

      const res = await fetch(`${API_URL}/files?${params}`, {
        headers: { Authorization: this.authHeader },
      });

      if (!res.ok) break;

      const files = (await res.json()) as ImageKitFileDetail[];
      if (!Array.isArray(files) || files.length === 0) break;

      for (const f of files) {
        yield f.fileId + SEP + f.filePath;
      }

      if (files.length < limit) break;
      skip += limit;
    }
  }

  /**
   * Reconstruct the CDN URL from the stored composite key.
   * The filePath is stable even if the endpoint domain changes.
   */
  getPublicUrl(key: string): string {
    const { filePath } = parseKey(key);
    const path = filePath.startsWith('/') ? filePath : '/' + filePath;
    return this.urlEndpoint + path;
  }
}

export default ImageKitProvider;
