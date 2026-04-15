/**
 * Bridges — host-implemented adapters for cross-package / external concerns.
 *
 * Following PACKAGE_RULES §7: packages stay host-agnostic by accepting
 * small, structurally-typed interfaces. Hosts implement these to plug
 * media-kit into their larger system.
 *
 * All bridges are OPTIONAL. media-kit works without any of them.
 */

export type { SourceBridge, SourceRef, SourceResolver } from './source.bridge.js';
export type { ScanBridge, ScanResult, ScanVerdict } from './scan.bridge.js';
export type { CdnBridge, CdnContext } from './cdn.bridge.js';
export type {
  TransformBridge,
  TransformOp,
  TransformOpInput,
  TransformOpOutput,
  TransformOpContext,
} from './transform.bridge.js';
export type { MediaBridges } from './types.js';
