/**
 * MediaBridges — aggregate of all host-implemented bridges.
 */

import type { SourceBridge } from './source.bridge.js';
import type { ScanBridge } from './scan.bridge.js';
import type { CdnBridge } from './cdn.bridge.js';
import type { TransformBridge } from './transform.bridge.js';

export interface MediaBridges {
  /** Resolve polymorphic sourceId/sourceModel refs to external entities. */
  source?: SourceBridge;
  /** Scan uploaded buffers for viruses/NSFW/policy violations. */
  scan?: ScanBridge;
  /** Transform storage URLs through CDN / image service. */
  cdn?: CdnBridge;
  /** Custom transform ops composable via URL params (bg-remove, upscale, etc.). */
  transform?: TransformBridge;
}
