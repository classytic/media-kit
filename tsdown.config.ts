import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'providers/s3': 'src/providers/s3.provider.ts',
    'providers/gcs': 'src/providers/gcs.provider.ts',
    'providers/local': 'src/providers/local.provider.ts',
    'providers/router': 'src/providers/router.ts',
    transforms: 'src/transforms/index.ts',
  },
  format: ['esm'],
  dts: true,
  clean: true,
  sourcemap: false,
  platform: 'node',
  target: 'node22',
  publint: true,
  attw: {
    profile: 'esm-only',
  },
  deps: { skipNodeModulesBundle: true },
});
