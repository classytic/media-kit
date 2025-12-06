/**
 * Package Contents Test
 *
 * Verifies that only necessary files are included in npm package
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

describe('Package Contents', () => {
  it('should only include dist/ and README.md in npm package', () => {
    const packageJson = JSON.parse(
      readFileSync(join(__dirname, '../package.json'), 'utf-8')
    );

    expect(packageJson.files).toEqual(['dist', 'README.md']);
  });

  it('should exclude source files via files whitelist', () => {
    const packageJson = JSON.parse(
      readFileSync(join(__dirname, '../package.json'), 'utf-8')
    );

    // Source should NOT be in files array
    expect(packageJson.files).not.toContain('src');
    expect(packageJson.files).not.toContain('tests');
    expect(packageJson.files).not.toContain('examples');
  });

  it('should have prepublishOnly script that runs tests', () => {
    const packageJson = JSON.parse(
      readFileSync(join(__dirname, '../package.json'), 'utf-8')
    );

    expect(packageJson.scripts.prepublishOnly).toContain('test');
    expect(packageJson.scripts.prepublishOnly).toContain('build');
    expect(packageJson.scripts.prepublishOnly).toContain('typecheck');
  });

  it('should have correct peer dependencies configuration', () => {
    const packageJson = JSON.parse(
      readFileSync(join(__dirname, '../package.json'), 'utf-8')
    );

    const peerDeps = packageJson.peerDependencies;
    const peerDepsMeta = packageJson.peerDependenciesMeta;

    // sharp, aws-sdk, gcs should be optional
    expect(peerDepsMeta['sharp']).toEqual({ optional: true });
    expect(peerDepsMeta['@aws-sdk/client-s3']).toEqual({ optional: true });
    expect(peerDepsMeta['@google-cloud/storage']).toEqual({ optional: true });

    // mongoose and mongokit should be required (not optional)
    expect(peerDepsMeta['mongoose']).toBeUndefined();
    expect(peerDepsMeta['@classytic/mongokit']).toBeUndefined();
    
    // mongokit should be >=2.1.0
    expect(peerDeps['@classytic/mongokit']).toBe('>=2.1.0');
  });

  it('should only have mime-types as runtime dependency', () => {
    const packageJson = JSON.parse(
      readFileSync(join(__dirname, '../package.json'), 'utf-8')
    );

    const deps = Object.keys(packageJson.dependencies || {});

    expect(deps).toEqual(['mime-types']);
  });

  it('should export main entry points correctly', () => {
    const packageJson = JSON.parse(
      readFileSync(join(__dirname, '../package.json'), 'utf-8')
    );

    // Main export
    expect(packageJson.exports['.']).toBeDefined();
    expect(packageJson.exports['.'].import).toBe('./dist/index.mjs');
    expect(packageJson.exports['.'].require).toBe('./dist/index.cjs');
    expect(packageJson.exports['.'].types).toBe('./dist/index.d.ts');

    // Provider exports
    expect(packageJson.exports['./providers/s3']).toBeDefined();
    expect(packageJson.exports['./providers/s3'].import).toBe('./dist/providers/s3.provider.mjs');
    expect(packageJson.exports['./providers/s3'].require).toBe('./dist/providers/s3.provider.cjs');
    
    expect(packageJson.exports['./providers/gcs']).toBeDefined();
    expect(packageJson.exports['./providers/gcs'].import).toBe('./dist/providers/gcs.provider.mjs');
    expect(packageJson.exports['./providers/gcs'].require).toBe('./dist/providers/gcs.provider.cjs');
  });

  it('should have type: module for ESM-first', () => {
    const packageJson = JSON.parse(
      readFileSync(join(__dirname, '../package.json'), 'utf-8')
    );

    expect(packageJson.type).toBe('module');
    expect(packageJson.main).toBe('dist/index.cjs');
    expect(packageJson.module).toBe('dist/index.mjs');
  });
});
