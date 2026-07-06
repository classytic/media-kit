/**
 * Visibility resolution — decides the effective visibility for a new upload.
 *
 * Precedence (first match wins):
 *   1. explicit per-upload `visibility`
 *   2. `visibility.byFolder` — longest matching folder-path prefix
 *      (a rule for 'invoices' also covers 'invoices/2026/q1')
 *   3. `visibility.default`
 *   4. 'public'
 */

import type { MediaVisibility, VisibilityConfig } from '../types.js';

/**
 * Return true when `folder` equals `rule` or lives underneath it
 * (segment-aware: 'inv' does NOT match 'invoices').
 */
function folderMatches(folder: string, rule: string): boolean {
  return folder === rule || folder.startsWith(`${rule}/`);
}

/**
 * Resolve the effective visibility for an upload into `folder`.
 */
export function resolveVisibility(
  config: VisibilityConfig | undefined,
  folder: string,
  explicit?: MediaVisibility | undefined,
): MediaVisibility {
  if (explicit) return explicit;

  const byFolder = config?.byFolder;
  if (byFolder) {
    let best: { rule: string; value: MediaVisibility } | null = null;
    for (const [rule, value] of Object.entries(byFolder)) {
      if (folderMatches(folder, rule) && (best === null || rule.length > best.rule.length)) {
        best = { rule, value };
      }
    }
    if (best) return best.value;
  }

  return config?.default ?? 'public';
}
