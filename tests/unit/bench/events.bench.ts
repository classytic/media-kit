/**
 * Microbenchmarks — event dispatch cost.
 *
 * Run with: npx vitest bench
 *
 * Guards against regressions in the hot path:
 *   - InProcessMediaBus.publish() with 0/1/100 subscribers
 *   - createMediaEvent() allocation cost
 *   - Pattern matching cost (exact / wildcard / glob)
 */

import { bench, describe } from 'vitest';
import { InProcessMediaBus } from '../../../src/events/in-process-bus.js';
import { createMediaEvent } from '../../../src/events/helpers.js';

describe('InProcessMediaBus.publish', () => {
  bench('no subscribers', async () => {
    const bus = new InProcessMediaBus();
    await bus.publish(createMediaEvent('media:asset.uploaded', { id: 'x' }));
  });

  bench('1 exact-match subscriber', async () => {
    const bus = new InProcessMediaBus();
    await bus.subscribe('media:asset.uploaded', () => {});
    await bus.publish(createMediaEvent('media:asset.uploaded', { id: 'x' }));
  });

  bench('100 exact-match subscribers', async () => {
    const bus = new InProcessMediaBus();
    for (let i = 0; i < 100; i++) {
      await bus.subscribe('media:asset.uploaded', () => {});
    }
    await bus.publish(createMediaEvent('media:asset.uploaded', { id: 'x' }));
  });

  bench('1 glob-match subscriber (media:*)', async () => {
    const bus = new InProcessMediaBus();
    await bus.subscribe('media:*', () => {});
    await bus.publish(createMediaEvent('media:asset.uploaded', { id: 'x' }));
  });

  bench('1 wildcard (*) subscriber', async () => {
    const bus = new InProcessMediaBus();
    await bus.subscribe('*', () => {});
    await bus.publish(createMediaEvent('media:asset.uploaded', { id: 'x' }));
  });
});

describe('createMediaEvent', () => {
  bench('minimal event (no ctx)', () => {
    createMediaEvent('media:asset.uploaded', { assetId: 'x' });
  });

  bench('with full ctx', () => {
    createMediaEvent(
      'media:asset.uploaded',
      { assetId: 'x', filename: 'y.jpg', size: 1024 },
      { userId: 'u1', organizationId: 'o1', correlationId: 'trace_abc' },
    );
  });
});
