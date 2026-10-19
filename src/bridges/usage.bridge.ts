import type { MediaContext } from '../engine/engine-types.js';

/** Refuse destruction while a domain still references the asset or one of its URLs. */
export interface MediaUsageBridge {
  inUse(mediaId: string, urls: readonly string[], context: MediaContext): Promise<boolean>;
}
