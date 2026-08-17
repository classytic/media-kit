/**
 * Kernel Construction Standard conformance — the EXECUTABLE §11 invariant list.
 *
 * The suite lives in `@classytic/mongokit/kernel-conformance` (a kernel may never depend on
 * arc, and every kernel already depends on mongokit), and is RUN here rather than
 * copy-pasted: when the standard gains a check, this file gets it on the next install.
 *
 * ## Why this file did not exist until now
 *
 * The fleet's conformance gate (`spine/scripts/check-kernel-conformance.mjs`) discovered
 * kernels by scanning `commerce/packages` alone — and media-kit lives in
 * `D:/projects/packages`, one of the four roots AGENTS.md lists. So the gate reported
 * "clean" over 40 kernels while never having looked at this one. A discovery gate cannot
 * fail on a package it cannot see, and media-kit's own suites stayed green throughout:
 * a kernel suite proves its behaviour still works, never that the standard holds.
 *
 * Unit project — `mongoose.createConnection()` is never connected, which is all these checks
 * need: model registration, schema identity and the index-call spies are registry-level, and
 * an unconnected connection also guarantees mongoose's own `autoIndex` cannot muddy the
 * "bind performs no index I/O" observation.
 */
import { describeKernelConformance } from '@classytic/mongokit/kernel-conformance';
import mongoose from 'mongoose';
import { describe, it } from 'vitest';
import type { MediaBlueprint, MediaEngine } from '../../src/engine/engine-types.js';
import type { StorageDriver } from '../../src/types/storage.js';
import * as kernel from '../../src/index.js';

/**
 * The one REQUIRED runtime collaborator: `bind()` refuses without a driver or a
 * provider map. Inert on purpose — conformance never writes an object.
 */
const driver: StorageDriver = {
  name: 'conformance-inert',
  write: async () => ({ key: '', size: 0, contentType: '' }) as never,
  read: async () => null as never,
  delete: async () => true,
  exists: async () => false,
} as unknown as StorageDriver;

describeKernelConformance<MediaBlueprint, MediaEngine>({
  name: 'media-kit',
  // The package is `media-kit`; the construction API is `defineMedia`. Stated
  // rather than derived, because the suite's default would look for
  // `defineMediaKit` and report a missing export that never existed.
  constructionExportName: 'defineMedia',
  runner: { describe, it },

  /**
   * A FACTORY, so the suite can watch `defineMedia` run and prove it registers nothing.
   *
   * No `forceRecreate` — the collision check needs a real collision. `autoIndex: false`
   * matters: `defineMediaModels` defaults it to TRUE, so an unset flag makes every bind
   * create indexes as a construction side effect, which is the thing §11 forbids.
   */
  blueprint: () => kernel.defineMedia({ autoIndex: false } as never),

  connect: async () => mongoose.createConnection(),

  bind: (blueprint, connection) => blueprint.bind(connection, { driver }),

  expectedModelNames: ['Media'],
  moduleExports: kernel,

  /**
   * §11.5 — a REAL, falsifiable unmet requirement: `bind()` throws
   * `Either driver or providers must be specified` (src/engine/define-media.ts).
   * Without one the engine would accept uploads it has nowhere to put.
   */
  bindWithUnmetRequirement: (connection) =>
    kernel.defineMedia({ autoIndex: false } as never).bind(connection, {}),

  skip: [
    {
      check: 'optional-modules-register-no-models',
      reason:
        'media-kit declares NO optional model families — `defineMediaModels` registers exactly ' +
        'one model (Media) for every shape. The progressive axes (processing, deduplication, ' +
        'folders, providers) gate BEHAVIOUR and collaborators, never a collection, so no ' +
        'combination of shape flags yields a smaller model set for the check to compare against.',
    },
  ],
});
