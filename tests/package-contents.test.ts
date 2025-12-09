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
    
    // mongokit should be >=3.0.0
    expect(peerDeps['@classytic/mongokit']).toBe('>=3.0.0');
  });

  it('should only have mime-types as runtime dependency', () => {
    const packageJson = JSON.parse(
      readFileSync(join(__dirname, '../package.json'), 'utf-8')
    );

    const deps = Object.keys(packageJson.dependencies || {});

    expect(deps).toEqual(['mime-types']);
  });

  it('should be ESM-only with clean exports', () => {
    const packageJson = JSON.parse(
      readFileSync(join(__dirname, '../package.json'), 'utf-8')
    );

    // ESM-only setup
    expect(packageJson.type).toBe('module');
    expect(packageJson.main).toBe('./dist/index.js');
    expect(packageJson.types).toBe('./dist/index.d.ts');
    
    // No module field needed for ESM-only
    expect(packageJson.module).toBeUndefined();
  });

  it('should export main entry points correctly', () => {
    const packageJson = JSON.parse(
      readFileSync(join(__dirname, '../package.json'), 'utf-8')
    );

    // Main export - simple ESM-only
    expect(packageJson.exports['.']).toEqual({
      types: './dist/index.d.ts',
      default: './dist/index.js',
    });

    // Provider exports
    expect(packageJson.exports['./providers/s3']).toEqual({
      types: './dist/providers/s3.provider.d.ts',
      default: './dist/providers/s3.provider.js',
    });
    
    expect(packageJson.exports['./providers/gcs']).toEqual({
      types: './dist/providers/gcs.provider.d.ts',
      default: './dist/providers/gcs.provider.js',
    });
  });
});
