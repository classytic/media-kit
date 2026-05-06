import { defineConfig } from 'vitest/config';
import { resolve } from 'path';
import { config as loadEnv } from 'dotenv';

// Load env from tests/.env for e2e provider credentials
loadEnv({ path: resolve(__dirname, 'tests/.env') });

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    coverage: {
      reporter: ['text', 'json', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/index.ts'],
    },
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['tests/unit/**/*.test.ts'],
          testTimeout: 10_000,
          hookTimeout: 10_000,
          // Group 0 — pure functions, parallel-safe.
          sequence: { groupOrder: 0 },
        },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          include: ['tests/integration/**/*.test.ts'],
          testTimeout: 30_000,
          hookTimeout: 30_000,
          // Vitest 4 — `poolOptions.forks.singleFork: true` migrated to
          // `maxWorkers: 1` + `isolate: false`. mongoose + mongodb-memory-
          // server share a connection; running them in one worker avoids
          // races. Different `maxWorkers` than `unit` requires unique
          // groupOrder.
          maxWorkers: 1,
          isolate: false,
          sequence: { groupOrder: 1 },
        },
      },
      {
        extends: true,
        test: {
          name: 'e2e',
          include: ['tests/e2e/**/*.test.ts'],
          testTimeout: 120_000,
          hookTimeout: 60_000,
          maxWorkers: 1,
          isolate: false,
          sequence: { groupOrder: 2 },
        },
      },
    ],
  },
  resolve: {
    alias: {
      '@classytic/mongokit': resolve(__dirname, 'node_modules/@classytic/mongokit/dist/index.mjs'),
    },
  },
});
