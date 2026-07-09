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
  'STALE_PENDING_MAX_AGE_MS',
  'createMediaRepositories',
  // Models
  'createMediaModels',
  'buildMediaSchema',
  'resolveMediaTenant',
  'injectTenantField',
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
  // URL signing (also standalone via ./signing)
  'createUrlSigner',
  'resolveVisibility',
  // External (reference-only) media
  'EXTERNAL_PROVIDER',
  'EXTERNAL_KEY_PREFIX',
  'isExternalMedia',
  'buildExternalKey',
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

// External media helpers — sentinel + discriminator sanity
assert.equal(main.EXTERNAL_PROVIDER, 'external');
assert.equal(main.isExternalMedia({ provider: 'external' }), true);
assert.equal(main.isExternalMedia({ provider: 's3' }), false);
assert.match(main.buildExternalKey('https://cdn.example.com/x.png'), /^__external__\/[0-9a-f]{16}$/);
assert.ok(main.MEDIA_EVENTS.ASSET_EXTERNAL_REGISTERED, 'MEDIA_EVENTS.ASSET_EXTERNAL_REGISTERED missing');
OK('external media — sentinel key + provider discriminator + event constant');

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

const imgbb = await import('../../dist/providers/imgbb.mjs').catch((err) => FAIL(`providers/imgbb import failed: ${err.message}`));
assert.ok(imgbb.ImgbbProvider, 'ImgbbProvider missing');
OK('./providers/imgbb — ImgbbProvider exported');

const imagekit = await import('../../dist/providers/imagekit.mjs').catch((err) => FAIL(`providers/imagekit import failed: ${err.message}`));
assert.ok(imagekit.ImageKitProvider, 'ImageKitProvider missing');
OK('./providers/imagekit — ImageKitProvider exported');

const cloudinary = await import('../../dist/providers/cloudinary.mjs').catch((err) => FAIL(`providers/cloudinary import failed: ${err.message}`));
assert.ok(cloudinary.CloudinaryProvider, 'CloudinaryProvider missing');
OK('./providers/cloudinary — CloudinaryProvider exported');

const cfImages = await import('../../dist/providers/cloudflare-images.mjs').catch((err) => FAIL(`providers/cloudflare-images import failed: ${err.message}`));
assert.ok(cfImages.CloudflareImagesProvider, 'CloudflareImagesProvider missing');
{
  const cf = new cfImages.CloudflareImagesProvider({
    accountId: 'acc',
    apiToken: 'token',
    accountHash: 'hash',
  });
  assert.equal(cf.name, 'cloudflare-images');
  assert.equal(cf.getPublicUrl('media/img.png'), 'https://imagedelivery.net/hash/media/img.png/public');
}
OK('./providers/cloudflare-images — CloudflareImagesProvider exported + delivery URL shape');

// ── Subpath: transforms ────────────────────────────────────────
const transforms = await import('../../dist/transforms.mjs').catch((err) => FAIL(`transforms import failed: ${err.message}`));
assert.ok(transforms.AssetTransformService, 'AssetTransformService missing');
OK('./transforms — AssetTransformService exported');

// ── Subpath: signing (zero-dep HMAC URL signer) ────────────────
const signing = await import('../../dist/signing.mjs').catch((err) => FAIL(`signing import failed: ${err.message}`));
assert.ok(signing.createUrlSigner, 'createUrlSigner missing');
{
  const signer = signing.createUrlSigner({ secret: 'smoke-secret' });
  const { query, expiresAt } = signer.sign({ id: 'smoke-id', expiresIn: 60 });
  assert.ok(query.includes('sig='), 'signed query must include sig=');
  assert.ok(expiresAt > Math.floor(Date.now() / 1000), 'expiresAt must be in the future');
  const params = Object.fromEntries(new URLSearchParams(query));
  assert.deepEqual(signer.verify({ id: 'smoke-id', params }), { ok: true });
  assert.equal(signer.verify({ id: 'other-id', params }).ok, false);
}
OK('./signing — createUrlSigner sign/verify round-trip');

// ── Subpath: schemas (Zod validators) ──────────────────────────
const schemas = await import('../../dist/schemas.mjs').catch((err) => FAIL(`schemas import failed: ${err.message}`));
assert.ok(schemas.mediaConfigSchema, 'mediaConfigSchema missing');
assert.ok(schemas.uploadInputSchema, 'uploadInputSchema missing');
assert.equal(typeof schemas.mediaConfigSchema.parse, 'function');
OK('./schemas — Zod schemas exported and callable');

// Verify Zod parse works at runtime
const parsed = schemas.mediaConfigSchema.parse({});
assert.equal(parsed.suppressWarnings, false, 'default suppressWarnings should be false');
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

// Mongokit peer floor must be at least 3.13.0 (UpdatePatch rename +
// class-level bulk ops). Parse the range floor instead of string-matching a
// specific version so legitimate floor bumps don't break the smoke test.
const mongokitPeer = pkg.peerDependencies?.['@classytic/mongokit'] ?? '';
const mongokitFloor = mongokitPeer.match(/>=\s*(\d+)\.(\d+)\.(\d+)/);
assert.ok(
  mongokitFloor &&
    (Number(mongokitFloor[1]) > 3 ||
      (Number(mongokitFloor[1]) === 3 && Number(mongokitFloor[2]) >= 13)),
  `mongokit peer floor must be >=3.13.0, got: ${mongokitPeer}`,
);
OK(`package.json — @classytic/mongokit peer dep ${mongokitPeer} (floor >=3.13.0)`);

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
  'dist/signing.mjs',
];
let totalMjsBytes = 0;
for (const rel of distStats) {
  const url = new URL(`../../${rel}`, import.meta.url);
  const sz = statSync(url).size;
  totalMjsBytes += sz;
}
// Budget raised 200 → 220 KB in 3.4.0: the release legitimately grew the
// core bundle (private serving + signing + external/reference records left
// it at ~209 KB). Still a bloat tripwire — if this trips again, check for
// stray fixtures/assets before raising it.
assert.ok(
  totalMjsBytes < 220_000,
  `dist JS size ${totalMjsBytes} bytes exceeds 220KB budget`,
);
OK(`package.json — dist JS size ${(totalMjsBytes / 1024).toFixed(1)} KB (budget 220 KB)`);

// Subpath exports all resolve (already verified above, but assert count)
const subpathExports = Object.keys(pkg.exports).filter((k) => k !== '.' && k !== './package.json');
assert.ok(subpathExports.length >= 9, `expected 9+ subpath exports, got ${subpathExports.length}`);
OK(`package.json — ${subpathExports.length} subpath exports (providers + transforms + schemas)`);

console.log('\n🎉 Smoke test passed — dist is healthy.');
