/**
 * URL import operation — fetch file from URL and upload.
 * Includes SSRF protection: private IP blocking, DNS rebinding prevention via IP pinning.
 */

import http from 'http';
import https from 'https';
import dns from 'dns';
import type { OperationDeps } from './types';
import type {
  ImportOptions,
  OperationContext,
  UploadInput,
  IMediaDocument,
  EventContext,
  EventError,
} from '../types';
import { getMimeType } from '../utils/mime';
import { upload } from './upload';
import { log } from './helpers';

/**
 * Import a file from a URL.
 *
 * 1. Fetch URL with streaming (check Content-Length for size limit)
 * 2. Extract filename from URL path or Content-Disposition header
 * 3. Detect MIME from Content-Type header
 * 4. Buffer the response, then run through standard upload flow
 */
export async function importFromUrl(
  deps: OperationDeps,
  url: string,
  options?: ImportOptions,
  context?: OperationContext,
): Promise<IMediaDocument> {
  const eventCtx: EventContext<{ url: string; options?: ImportOptions }> = {
    data: { url, options },
    context,
    timestamp: new Date(),
  };
  await deps.events.emit('before:import', eventCtx);

  try {
    const maxSize = options?.maxSize || deps.config.fileTypes?.maxSize || 100 * 1024 * 1024;
    const timeout = options?.timeout || 30000;

    const { buffer, mimeType, filename: detectedFilename } = await fetchUrl(url, maxSize, timeout);

    // Determine final filename
    const filename = options?.filename || detectedFilename;

    // Determine MIME type (use detected or derive from filename)
    const finalMimeType = mimeType || getMimeType(filename);

    // Build upload input — tags are passed here, upload() persists them via createMedia()
    const uploadInput: UploadInput = {
      buffer,
      filename,
      mimeType: finalMimeType,
      folder: options?.folder,
      alt: options?.alt,
      title: options?.title,
      tags: options?.tags,
    };

    // Run through standard upload flow
    const media = await upload(deps, uploadInput, context);

    log(deps, 'info', 'Media imported from URL', {
      url,
      id: media._id,
      filename,
    });

    await deps.events.emit('after:import', {
      context: eventCtx,
      result: media,
      timestamp: new Date(),
    });

    return media;
  } catch (error) {
    await deps.events.emit('error:import', {
      context: eventCtx,
      error: error as Error,
      timestamp: new Date(),
    });
    throw error;
  }
}

/**
 * Check if an IP address is in a private/reserved range (SSRF protection).
 * Handles IPv4, IPv6, and IPv4-mapped IPv6 (::ffff:x.x.x.x) encodings.
 * Exported for testability.
 */
function isPrivateIP(ip: string): boolean {
  // Normalize IPv4-mapped IPv6 (::ffff:127.0.0.1 → 127.0.0.1)
  let normalized = ip;
  const v4MappedMatch = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (v4MappedMatch) {
    normalized = v4MappedMatch[1]!;
  }

  // IPv4 private/reserved ranges
  const parts = normalized.split('.').map(Number);
  if (parts.length === 4 && parts.every((p) => p >= 0 && p <= 255)) {
    if (parts[0]! === 10) return true; // 10.0.0.0/8
    if (parts[0]! === 172 && parts[1]! >= 16 && parts[1]! <= 31) return true; // 172.16.0.0/12
    if (parts[0]! === 192 && parts[1]! === 168) return true; // 192.168.0.0/16
    if (parts[0]! === 127) return true; // 127.0.0.0/8 (loopback)
    if (parts[0]! === 169 && parts[1]! === 254) return true; // 169.254.0.0/16 (link-local / cloud metadata)
    if (parts[0]! === 0) return true; // 0.0.0.0/8
    if (parts[0]! === 100 && parts[1]! >= 64 && parts[1]! <= 127) return true; // 100.64.0.0/10 (carrier-grade NAT)
    if (parts[0]! === 198 && (parts[1]! === 18 || parts[1]! === 19)) return true; // 198.18.0.0/15 (benchmarking)
    if (parts[0]! === 192 && parts[1]! === 0 && parts[2]! === 0) return true; // 192.0.0.0/24 (IETF protocol)
    if (parts[0]! === 192 && parts[1]! === 0 && parts[2]! === 2) return true; // 192.0.2.0/24 (TEST-NET-1)
    if (parts[0]! === 198 && parts[1]! === 51 && parts[2]! === 100) return true; // 198.51.100.0/24 (TEST-NET-2)
    if (parts[0]! === 203 && parts[1]! === 0 && parts[2]! === 113) return true; // 203.0.113.0/24 (TEST-NET-3)
    if (parts[0]! >= 224) return true; // 224.0.0.0+ (multicast + reserved)
    return false;
  }

  // IPv6 private/reserved ranges (only reached for non-IPv4 addresses)
  const lower = ip.toLowerCase();
  if (lower === '::1') return true; // loopback
  if (lower === '::') return true; // unspecified
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // fc00::/7 unique local
  if (lower.startsWith('fe80')) return true; // link-local
  if (lower.startsWith('::ffff:')) return true; // IPv4-mapped with non-dotted notation (unparseable → block)
  if (lower.startsWith('100::')) return true; // discard prefix (100::/64)
  if (lower.startsWith('2001:db8')) return true; // documentation prefix
  if (lower.startsWith('ff')) return true; // multicast

  return false;
}

/**
 * Validate URL safety before making requests (SSRF protection).
 * Blocks private/internal IPs, non-http(s) protocols, and known metadata endpoints.
 * Returns the resolved IP address so callers can pin it (prevents DNS rebinding TOCTOU).
 */
async function validateUrlSafety(url: string): Promise<string> {
  const parsed = new URL(url);

  // Only allow http/https
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(
      `URL import failed: unsupported protocol '${parsed.protocol}' — only http/https allowed`,
    );
  }

  // Block known internal hostnames
  const hostname = parsed.hostname.toLowerCase();
  const blockedHosts = ['localhost', 'metadata.google.internal', 'metadata.google.internal.'];
  if (blockedHosts.includes(hostname) || hostname.endsWith('.localhost')) {
    throw new Error(`URL import failed: blocked internal hostname '${hostname}'`);
  }

  // Also block raw IP literals that are private
  if (isPrivateIP(hostname)) {
    throw new Error(`URL import failed: blocked private IP address '${hostname}'`);
  }

  // Resolve hostname and check if IP is private (fail-closed: DNS errors block the request)
  const { address } = await dns.promises.lookup(hostname).catch((err) => {
    throw new Error(
      `URL import failed: DNS resolution failed for '${hostname}' — ${err.code || err.message}`,
    );
  });

  if (isPrivateIP(address)) {
    throw new Error(
      `URL import failed: hostname '${hostname}' resolves to private IP '${address}'`,
    );
  }

  return address;
}

/**
 * Fetch a URL and return buffer, mime type, and filename.
 * Streams the response and checks Content-Length against size limit.
 * Includes SSRF protection: blocks private IPs on initial and redirect URLs.
 * Pins resolved IP to prevent DNS rebinding (TOCTOU) attacks.
 */
async function fetchUrl(
  url: string,
  maxSize: number,
  timeout: number,
  redirectDepth = 0,
): Promise<{ buffer: Buffer; mimeType: string; filename: string }> {
  const MAX_REDIRECTS = 5;

  // SSRF protection: validate URL safety and get pinned IP (prevents DNS rebinding)
  const resolvedIP = await validateUrlSafety(url);

  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const transport = parsedUrl.protocol === 'https:' ? https : http;

    // Pin resolved IP via custom lookup to prevent DNS rebinding between
    // our validation and the actual connection (TOCTOU mitigation)
    const pinnedLookup = (
      _hostname: string,
      options: unknown,
      callback?: (err: NodeJS.ErrnoException | null, address: string, family: number) => void,
    ) => {
      const cb = typeof options === 'function' ? options : callback;
      if (cb) {
        (cb as (err: null, address: string, family: number) => void)(
          null,
          resolvedIP,
          resolvedIP.includes(':') ? 6 : 4,
        );
      }
    };

    const req = transport.get(
      url,
      { timeout, lookup: pinnedLookup as typeof dns.lookup },
      (res) => {
        // Handle redirects (resolve relative Location against current URL)
        if (
          res.statusCode &&
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location
        ) {
          if (redirectDepth >= MAX_REDIRECTS) {
            reject(
              new Error(`URL import failed: too many redirects (>${MAX_REDIRECTS}) for ${url}`),
            );
            return;
          }
          const resolvedUrl = new URL(res.headers.location, url).href;
          fetchUrl(resolvedUrl, maxSize, timeout, redirectDepth + 1)
            .then(resolve)
            .catch(reject);
          return;
        }

        if (!res.statusCode || res.statusCode >= 400) {
          reject(new Error(`URL import failed: HTTP ${res.statusCode} for ${url}`));
          return;
        }

        // Check Content-Length before downloading
        const contentLength = parseInt(res.headers['content-length'] || '0', 10);
        if (contentLength > 0 && contentLength > maxSize) {
          const maxMB = Math.round(maxSize / 1024 / 1024);
          res.destroy();
          reject(
            new Error(
              `URL import failed: file size ${Math.round(contentLength / 1024 / 1024)}MB exceeds limit of ${maxMB}MB`,
            ),
          );
          return;
        }

        // Extract MIME type from Content-Type header
        const contentTypeHeader = res.headers['content-type'] || '';
        const detectedMimeType =
          contentTypeHeader.split(';')[0]!.trim() || 'application/octet-stream';

        // Extract filename from Content-Disposition or URL path
        let detectedFilename = 'imported-file';
        const disposition = res.headers['content-disposition'];
        if (disposition) {
          const filenameMatch = disposition.match(
            /filename\*?=['"]?(?:UTF-8'')?([^;\r\n"']+)/i,
          );
          if (filenameMatch) {
            detectedFilename = decodeURIComponent(filenameMatch[1]!.replace(/['"]/g, ''));
          }
        }
        if (detectedFilename === 'imported-file') {
          const urlPath = parsedUrl.pathname;
          const pathSegments = urlPath.split('/').filter(Boolean);
          if (pathSegments.length > 0) {
            const lastSegment = pathSegments[pathSegments.length - 1]!;
            if (lastSegment.includes('.')) {
              detectedFilename = decodeURIComponent(lastSegment);
            }
          }
        }

        // Buffer the response with size checks
        const chunks: Buffer[] = [];
        let totalSize = 0;

        res.on('data', (chunk: Buffer) => {
          totalSize += chunk.length;
          if (totalSize > maxSize) {
            const maxMB = Math.round(maxSize / 1024 / 1024);
            res.destroy();
            reject(
              new Error(`URL import failed: download exceeded size limit of ${maxMB}MB`),
            );
            return;
          }
          chunks.push(chunk);
        });

        res.on('end', () => {
          const responseBuffer = Buffer.concat(chunks);
          resolve({ buffer: responseBuffer, mimeType: detectedMimeType, filename: detectedFilename });
        });

        res.on('error', (err) => {
          reject(new Error(`URL import failed: ${err.message}`));
        });
      },
    );

    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`URL import failed: request timed out after ${timeout}ms`));
    });

    req.on('error', (err) => {
      reject(new Error(`URL import failed: ${err.message}`));
    });
  });
}
