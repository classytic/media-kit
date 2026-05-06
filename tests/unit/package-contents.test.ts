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

    // mongokit must be >=3.13.0 — that release ships `claim()` (atomic
    // CAS state transition with `where` for compound predicates) which
    // media-kit's upload pipeline uses for race-safe pending →
    // processing → ready transitions, plus `findOneAndUpdate` plugin-
    // pipeline routing for tag/focal-point updates (avoids cross-tenant
    // write surface). Also brings the LookupBuilder sanitization
    // restoration + array-form `select` parity from 3.12 that media-kit
    // relies on transitively via `lookupPopulate`.
    expect(peerDeps['@classytic/mongokit']).toBe('>=3.13.0');
    // primitives 0.4.0 ships the `assertAndClaim` surface that
    // media-kit's upload pipeline (`presigned.ts`) uses to validate
    // state-machine transitions before the database round-trip. The
    // earlier `>=0.3.1` pin was wrong on two counts: (1) `0.3.1` was
    // never published (only 0.1.0, 0.1.1, 0.2.0, 0.3.0, 0.4.0 exist),
    // so the lower bound was unreachable; (2) `assertAndClaim` only
    // landed in 0.4.0. Hosts on 0.3.x silently broke at runtime with
    // an `ImportError` on first upload.
    expect(peerDeps['@classytic/primitives']).toBe('>=0.4.0');
    // repo-core 0.4.0 ships `StandardRepo.claim()` + the
    // `ClaimTransition.where` compound-CAS predicate that the new
    // upload-pipeline state-machine writes against. media-kit also
    // resolves the canonical TenantConfig vocabulary via
    // `resolveTenantConfig()` from `@classytic/repo-core/tenant`.
    expect(peerDeps['@classytic/repo-core']).toBe('>=0.4.0');
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
