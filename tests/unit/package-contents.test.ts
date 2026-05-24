/**
 * Package Contents Test
 *
 * Verifies that only necessary files are included in npm package
 * and that exports/config match tsdown output conventions (.mjs / .d.mts).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

describe('Package Contents', () => {
  it('should only include dist/ and README.md in npm package', () => {
    const packageJson = JSON.parse(
      readFileSync(join(__dirname, '../../package.json'), 'utf-8')
    );

    expect(packageJson.files).toEqual(['dist', 'README.md', 'LICENSE']);
  });

  it('should exclude source files via files whitelist', () => {
    const packageJson = JSON.parse(
      readFileSync(join(__dirname, '../../package.json'), 'utf-8')
    );

    expect(packageJson.files).not.toContain('src');
    expect(packageJson.files).not.toContain('tests');
    expect(packageJson.files).not.toContain('examples');
  });

  it('should have prepublishOnly script that runs tests', () => {
    const packageJson = JSON.parse(
      readFileSync(join(__dirname, '../../package.json'), 'utf-8')
    );

    expect(packageJson.scripts.prepublishOnly).toContain('test');
    expect(packageJson.scripts.prepublishOnly).toContain('build');
    expect(packageJson.scripts.prepublishOnly).toContain('typecheck');
  });

  it('should have correct peer dependencies configuration', () => {
    const packageJson = JSON.parse(
      readFileSync(join(__dirname, '../../package.json'), 'utf-8')
    );

    const peerDeps = packageJson.peerDependencies;
    const peerDepsMeta = packageJson.peerDependenciesMeta;

    // sharp, aws-sdk, gcs, mime-types should be optional
    expect(peerDepsMeta['sharp']).toEqual({ optional: true });
    expect(peerDepsMeta['@aws-sdk/client-s3']).toEqual({ optional: true });
    expect(peerDepsMeta['@aws-sdk/s3-request-presigner']).toEqual({ optional: true });
    expect(peerDepsMeta['@google-cloud/storage']).toEqual({ optional: true });
    expect(peerDepsMeta['mime-types']).toEqual({ optional: true });

    // mongoose and mongokit should be required (not optional)
    expect(peerDepsMeta['mongoose']).toBeUndefined();
    expect(peerDepsMeta['@classytic/mongokit']).toBeUndefined();

    // mongokit must be >=3.14.0 — that release tracks the kit ecosystem
    // floor adopted by `@classytic/arc@2.17` and ships the soft-delete +
    // TTL surface media-kit's lifecycle hooks depend on. Earlier floors
    // (3.13.x) shipped `claim()` and the LookupBuilder restoration but
    // missed the `softDeletePlugin({ ttlDays })` partial-filter wiring
    // that media-kit's expiry pipeline now leverages.
    expect(peerDeps['@classytic/mongokit']).toBe('>=3.14.0');
    // primitives 0.6.0 is the canonical event-type floor the kit
    // ecosystem agreed on with `@classytic/arc@2.16+`. 0.6 brings the
    // `EventTransport` / `DomainEvent` / `EventMeta` typing media-kit
    // relies on for arc-compatible event emission. Earlier floors
    // (0.4.x) had a narrower `assertAndClaim` surface but missed the
    // canonical event vocabulary kits now share.
    expect(peerDeps['@classytic/primitives']).toBe('>=0.6.0');
    // repo-core 0.5.0 publishes the canonical `DataAdapter` /
    // `RepositoryLike` / `OpenApiSchemas` surface plus the
    // `MinimalRepo & Partial<StandardRepo>` contract arc 2.17 develops
    // against. Aligning the floor here keeps dev/peer expectations
    // consistent across the kit ecosystem.
    expect(peerDeps['@classytic/repo-core']).toBe('>=0.5.0');
  });

  it('should have no runtime dependencies (all are peer)', () => {
    const packageJson = JSON.parse(
      readFileSync(join(__dirname, '../../package.json'), 'utf-8')
    );

    const deps = Object.keys(packageJson.dependencies || {});
    expect(deps).toEqual([]);
  });

  it('should be ESM-only with tsdown output conventions', () => {
    const packageJson = JSON.parse(
      readFileSync(join(__dirname, '../../package.json'), 'utf-8')
    );

    expect(packageJson.type).toBe('module');
    expect(packageJson.main).toBe('./dist/index.mjs');
    expect(packageJson.types).toBe('./dist/index.d.mts');
    expect(packageJson.module).toBe('./dist/index.mjs');
  });

  it('should export main entry points correctly', () => {
    const packageJson = JSON.parse(
      readFileSync(join(__dirname, '../../package.json'), 'utf-8')
    );

    // Main export
    expect(packageJson.exports['.']).toEqual({
      types: './dist/index.d.mts',
      import: './dist/index.mjs',
    });

    // Provider exports
    expect(packageJson.exports['./providers/s3']).toEqual({
      types: './dist/providers/s3.d.mts',
      import: './dist/providers/s3.mjs',
    });

    expect(packageJson.exports['./providers/gcs']).toEqual({
      types: './dist/providers/gcs.d.mts',
      import: './dist/providers/gcs.mjs',
    });

    expect(packageJson.exports['./providers/local']).toEqual({
      types: './dist/providers/local.d.mts',
      import: './dist/providers/local.mjs',
    });

    expect(packageJson.exports['./providers/router']).toEqual({
      types: './dist/providers/router.d.mts',
      import: './dist/providers/router.mjs',
    });
  });

  it('should export transforms entry point', () => {
    const packageJson = JSON.parse(
      readFileSync(join(__dirname, '../../package.json'), 'utf-8')
    );

    expect(packageJson.exports['./transforms']).toEqual({
      types: './dist/transforms.d.mts',
      import: './dist/transforms.mjs',
    });
  });

  it('should have sideEffects: false for tree shaking', () => {
    const packageJson = JSON.parse(
      readFileSync(join(__dirname, '../../package.json'), 'utf-8')
    );

    expect(packageJson.sideEffects).toBe(false);
  });
});
