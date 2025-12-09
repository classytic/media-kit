import { defineConfig } from 'tsup';

export default defineConfig({
  entry: [
    'src/index.ts',
    'src/providers/s3.provider.ts',
    'src/providers/gcs.provider.ts',
  ],
  format: ['esm'],
  dts: true,
  clean: true,
  splitting: true,
  sourcemap: true,
  treeshake: true,
  external: [
    'mongoose',
    '@classytic/mongokit',
    'sharp',
    '@aws-sdk/client-s3',
    '@aws-sdk/s3-request-presigner',
    '@google-cloud/storage',
  ],
});
