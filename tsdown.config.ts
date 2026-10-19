import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'storage-budget': 'src/storage-budget.ts',
    'repositories/storage-budget.store': 'src/repositories/storage-budget.store.ts',
    'providers/s3': 'src/providers/s3.provider.ts',
    'providers/gcs': 'src/providers/gcs.provider.ts',
    'providers/local': 'src/providers/local.provider.ts',
    'providers/imgbb': 'src/providers/imgbb.provider.ts',
    'providers/imagekit': 'src/providers/imagekit.provider.ts',
    'providers/cloudinary': 'src/providers/cloudinary.provider.ts',
    'providers/cloudflare-images': 'src/providers/cloudflare-images.provider.ts',
    'providers/router': 'src/providers/router.ts',
    transforms: 'src/transforms/index.ts',
    resumable: 'src/resumable/index.ts',
    schemas: 'src/validators/index.ts',
    signing: 'src/signing/index.ts',
    types: 'src/types/index.ts',
    'types/storage': 'src/types/storage.ts',
    'types/media': 'src/types/media.ts',
    'types/processing': 'src/types/processing.ts',
    'types/uploads': 'src/types/uploads.ts',
    'types/config': 'src/types/config.ts',
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
  deps: {
    skipNodeModulesBundle: true,
    // Explicit scope patterns so the rule does not depend on `skipNodeModulesBundle` to
    // be correct. media-kit has seven `@classytic/*` deps; inlining one would put two
    // copies of a stateful kernel in one process — a correctness bug, not a size
    // regression — and a build that does it still prints `✔ Build complete`.
    // `@spinekit/` is listed because a scope that stops matching after a rename still
    // reports success (commerce/AGENTS.md §"eight things that are NOT a source grep").
    neverBundle: [/^@classytic\//, /^@spinekit\//],
  },
});
