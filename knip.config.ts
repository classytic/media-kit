import type { KnipConfig } from 'knip';

/**
 * Production entry points come from package.json `exports` (knip reads those
 * automatically) — that is what keeps src dead-code detection meaningful.
 *
 * Tests use vitest `projects`; knip's auto-detection picks up unit/integration
 * but misses the e2e project, so its shared helpers (`tests/helpers/*`) read as
 * dead code. Declare the test files + standalone scripts as entries explicitly.
 */
export default {
  entry: [
    'tests/unit/**/*.test.ts',
    'tests/integration/**/*.test.ts',
    'tests/e2e/**/*.test.ts',
    'tests/smoke/*.mjs',
  ],
  project: ['src/**/*.ts', 'tests/**/*.ts'],
  // `mime-types` is an OPTIONAL peer, lazily `require()`d with a built-in
  // fallback (src/utils/mime.ts) — referencing it is intentional, so knip's
  // "referenced optional peerDependency" hint is expected here, not a defect.
  rules: { optionalPeerDependencies: 'off' },
} satisfies KnipConfig;
