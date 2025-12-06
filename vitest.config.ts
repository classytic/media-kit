import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    coverage: {
      reporter: ['text', 'json', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/index.ts'],
    },
  },
  resolve: {
    alias: {
      // Resolve @classytic/mongokit to the installed npm package
      '@classytic/mongokit': resolve(__dirname, 'node_modules/@classytic/mongokit/dist/index.js'),
    },
  },
});
