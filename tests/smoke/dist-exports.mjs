#!/usr/bin/env node
/**
 * Smoke test — verify the built dist/ exports everything the public API promises.
 *
 * Runs against `dist/` (not src/), catching:
 *   - tsdown build stripping something we depend on
 *   - package.json exports paths not resolving
 *   - a public export disappearing silently in a refactor
 *
 * Run via: npm run build && node tests/smoke/dist-exports.mjs
 *
 * Exit 0 = smoke passed. Exit 1 = missing export or import failure.
 */

import { strict as assert } from 'node:assert';

const FAIL = (msg) => {
  console.error(`❌ ${msg}`);
  process.exit(1);
};
const OK = (msg) => console.log(`✅ ${msg}`);

// ── Main entry: @classytic/media-kit ────────────────────────────
const main = await import('../../dist/index.mjs').catch((err) => FAIL(`main import failed: ${err.message}`));

const EXPECTED_MAIN = [
  // Engine
  'createMedia',
  // Repository
  'MediaRepository',
  'createMediaRepositories',
  // Models
  'createMediaModels',
  'buildMediaSchema',
  'tenantFieldDef',
  'DEFAULT_TENANT_CONFIG',
  // Events
  'InProcessMediaBus',
  'MEDIA_EVENTS',
  'createMediaEvent',
  // Processing
  'ImageProcessor',
  'createImageProcessor',
  'calculateFocalPointCrop',
  'isValidFocalPoint',
  'DEFAULT_FOCAL_POINT',
  'generateThumbHash',
  'DEVICE_WIDTHS',
  'COMPACT_WIDTHS',
  'IMAGE_WIDTHS',
  'generateResponsiveVariants',
  'resolvePresetWidths',
  'PROCESSING_PRESETS',
  'resolveProcessingPreset',
  // Query (re-export from mongokit)
  'QueryParser',
];

for (const name of EXPECTED_MAIN) {
  assert.ok(
    typeof main[name] !== 'undefined',
    `main export missing: ${name}`,
  );
}
OK(`main — ${EXPECTED_MAIN.length} exports present`);

// Verify MEDIA_EVENTS is a frozen const with the expected keys
assert.equal(typeof main.MEDIA_EVENTS, 'object');
for (const key of ['ASSET_UPLOADED', 'ASSET_DELETED', 'ASSET_REPLACED', 'ASSET_MOVED', 'FOLDER_RENAMED']) {
  assert.ok(main.MEDIA_EVENTS[key], `MEDIA_EVENTS.${key} missing`);
  assert.equal(
    main.MEDIA_EVENTS[key].startsWith('media:'),
    true,
    `MEDIA_EVENTS.${key} must start with "media:"`,
  );
}
OK('MEDIA_EVENTS const — all entries follow media:resource.verb convention');

// InProcessMediaBus should be instantiable
const bus = new main.InProcessMediaBus();
assert.equal(bus.name, 'in-process-media');
assert.equal(typeof bus.publish, 'function');
assert.equal(typeof bus.subscribe, 'function');
OK('InProcessMediaBus — instantiable and exposes publish/subscribe');

// createMediaEvent should produce arc-compatible DomainEvent
const evt = main.createMediaEvent('media:asset.uploaded', { assetId: 'x' }, { userId: 'u1' });
assert.equal(evt.type, 'media:asset.uploaded');
assert.ok(evt.meta.id);
assert.ok(evt.meta.timestamp instanceof Date);
assert.equal(evt.meta.userId, 'u1');
OK('createMediaEvent — produces arc-compatible DomainEvent shape');

// ── Subpath: providers ─────────────────────────────────────────
const s3 = await import('../../dist/providers/s3.mjs').catch((err) => FAIL(`providers/s3 import failed: ${err.message}`));
assert.ok(s3.S3Provider, 'S3Provider missing');
OK('./providers/s3 — S3Provider exported');

const gcs = await import('../../dist/providers/gcs.mjs').catch((err) => FAIL(`providers/gcs import failed: ${err.message}`));
assert.ok(gcs.GCSProvider, 'GCSProvider missing');
OK('./providers/gcs — GCSProvider exported');

const local = await import('../../dist/providers/local.mjs').catch((err) => FAIL(`providers/local import failed: ${err.message}`));
assert.ok(local.LocalProvider, 'LocalProvider missing');
OK('./providers/local — LocalProvider exported');

const router = await import('../../dist/providers/router.mjs').catch((err) => FAIL(`providers/router import failed: ${err.message}`));
assert.ok(router.StorageRouter, 'StorageRouter missing');
OK('./providers/router — StorageRouter exported');

// ── Subpath: transforms ────────────────────────────────────────
const transforms = await import('../../dist/transforms.mjs').catch((err) => FAIL(`transforms import failed: ${err.message}`));
assert.ok(transforms.AssetTransformService, 'AssetTransformService missing');
OK('./transforms — AssetTransformService exported');

// ── Subpath: schemas (Zod validators) ──────────────────────────
const schemas = await import('../../dist/schemas.mjs').catch((err) => FAIL(`schemas import failed: ${err.message}`));
assert.ok(schemas.mediaConfigSchema, 'mediaConfigSchema missing');
assert.ok(schemas.uploadInputSchema, 'uploadInputSchema missing');
assert.equal(typeof schemas.mediaConfigSchema.parse, 'function');
OK('./schemas — Zod schemas exported and callable');

// Verify Zod parse works at runtime
const parsed = schemas.mediaConfigSchema.parse({});
assert.equal(parsed.tenantFieldType, 'string', 'default tenantFieldType should be "string"');
OK('schemas.mediaConfigSchema.parse({}) — defaults applied');

// ── Package.json: no unexpected dependencies ──────────────────
const { readFileSync } = await import('node:fs');
const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf-8'));

assert.equal(pkg.type, 'module', 'package must be ESM-only');
assert.equal(pkg.sideEffects, false, 'package must declare sideEffects: false for tree-shaking');
assert.equal(
  typeof pkg.dependencies,
  'undefined',
  'package must not have runtime deps — everything is peer',
);
OK('package.json — ESM-only, sideEffects:false, no runtime deps');

// Mongokit peer dep is >=3.6.2 (required for fieldType)
assert.ok(
  pkg.peerDependencies?.['@classytic/mongokit']?.includes('3.6.2'),
  `mongokit peer must be >=3.6.2, got: ${pkg.peerDependencies?.['@classytic/mongokit']}`,
);
OK('package.json — @classytic/mongokit peer dep >=3.6.2');

// Zod peer is >=4.0.0
assert.ok(
  pkg.peerDependencies?.zod?.includes('4'),
  `zod peer must be >=4, got: ${pkg.peerDependencies?.zod}`,
);
OK('package.json — zod peer dep >=4.0.0');

// ── Publishing hygiene: package size ceiling ──────────────────
// Keep under 500 KB unpacked to avoid bloat. If this trips, check the
// tsdown build for stray test fixtures or large assets getting bundled.
const { statSync } = await import('node:fs');
const distStats = [
  'dist/index.mjs',
  'dist/index.d.mts',
  'dist/providers/s3.mjs',
  'dist/providers/gcs.mjs',
  'dist/schemas.mjs',
  'dist/transforms.mjs',
];
let totalMjsBytes = 0;
for (const rel of distStats) {
  const url = new URL(`../../${rel}`, import.meta.url);
  const sz = statSync(url).size;
  totalMjsBytes += sz;
}
assert.ok(
  totalMjsBytes < 200_000,
  `dist JS size ${totalMjsBytes} bytes exceeds 200KB budget`,
);
OK(`package.json — dist JS size ${(totalMjsBytes / 1024).toFixed(1)} KB (budget 200 KB)`);

// Subpath exports all resolve (already verified above, but assert count)
const subpathExports = Object.keys(pkg.exports).filter((k) => k !== '.' && k !== './package.json');
assert.ok(subpathExports.length >= 6, `expected 6+ subpath exports, got ${subpathExports.length}`);
OK(`package.json — ${subpathExports.length} subpath exports (providers + transforms + schemas)`);

console.log('\n🎉 Smoke test passed — dist is healthy.');
