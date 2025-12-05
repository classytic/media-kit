# Publishing Checklist ✅

## 📦 **What Will Be Published**

Run this to preview:
```bash
npm run publish:dry
```

### ✅ **Included (Correct)**
- `dist/` - Compiled JavaScript (CJS + ESM)
- `dist/**/*.d.ts` - TypeScript declarations
- `README.md` - Documentation
- `package.json` - Package metadata
- `LICENSE` (if exists)

### ❌ **Excluded (Correct)**
- `src/` - TypeScript source (not needed, we ship dist/)
- `tests/` - Test files
- `examples/` - Example code
- `ENHANCEMENTS.md` - Development notes
- `.npmignore`, `tsconfig.json`, `vitest.config.ts`
- All other dev files

---

## 🧪 **Testing Before Publish**

### 1. Run All Tests
```bash
npm test
```

**Expected output:**
```
✓ tests/alt-text.test.ts (10 tests)
✓ tests/folders.test.ts (...)
✓ tests/mime.test.ts (...)
✓ tests/schema.test.ts (...)
✓ tests/integration.test.ts (15 tests) ← NEW!
✓ tests/package-contents.test.ts (6 tests) ← NEW!

Test Files  6 passed (6)
     Tests  XX passed (XX)
```

### 2. Type Check
```bash
npm run typecheck
```

**Expected:** No errors (only peer dependency warnings are OK)

### 3. Build Check
```bash
npm run build
```

**Expected output:**
```
dist/
├── index.js
├── index.mjs
├── index.d.ts
├── providers/
│   ├── s3.provider.js
│   ├── s3.provider.mjs
│   ├── s3.provider.d.ts
│   ├── gcs.provider.js
│   ├── gcs.provider.mjs
│   └── gcs.provider.d.ts
```

### 4. Dry Run Publish
```bash
npm run publish:dry
```

**Verify:**
- Package size is reasonable (< 100KB)
- Only `dist/` and `README.md` are included
- No `src/`, `tests/`, or `examples/`

### 5. Local Package Test
```bash
# Pack the package
npm pack

# This creates @classytic-media-kit-1.0.0.tgz
# Install in a test project:
cd ../test-project
npm install ../media-kit/@classytic-media-kit-1.0.0.tgz

# Test imports work
node -e "const { createMedia } = require('@classytic/media-kit'); console.log('✅ CJS works')"
node -e "import('@classytic/media-kit').then(m => console.log('✅ ESM works'))"
```

---

## 🚀 **Publishing**

### Option 1: Automatic (Recommended)
```bash
# Patch version (1.0.0 → 1.0.1)
npm run release:patch

# Minor version (1.0.0 → 1.1.0)
npm run release:minor

# Major version (1.0.0 → 2.0.0)
npm run release:major
```

**This automatically:**
1. Bumps version in package.json
2. Runs build
3. Runs tests
4. Runs typecheck
5. Publishes to npm
6. Creates git tag

### Option 2: Manual
```bash
# 1. Update version
npm version patch  # or minor, major

# 2. Build & test (automatic via prepublishOnly)
npm publish --access public
```

---

## ✅ **Post-Publish Verification**

### 1. Check npm page
```
https://www.npmjs.com/package/@classytic/media-kit
```

**Verify:**
- ✅ README renders correctly
- ✅ Version is updated
- ✅ Files list shows only dist/ and README.md
- ✅ Package size is reasonable

### 2. Test installation
```bash
# In a fresh directory
npm install @classytic/media-kit mongoose

# Test basic import
node -e "const { createMedia } = require('@classytic/media-kit'); console.log('✅ Works!')"
```

### 3. Test without optional deps
```bash
# Install without sharp/S3/GCS
npm install @classytic/media-kit mongoose

# Should work with no errors or warnings if suppressWarnings: true
```

---

## 🔍 **Integration Test Results**

### Test Coverage:
- ✅ Upload single file
- ✅ Upload multiple files
- ✅ Delete single file
- ✅ Delete multiple files
- ✅ Delete with variant cleanup
- ✅ Auto alt-text generation
- ✅ Event system (before/after/error)
- ✅ File validation (type, size)
- ✅ Folder validation
- ✅ Storage provider integration
- ✅ Database integration

### Package Validation:
- ✅ Only ships dist/ and README.md
- ✅ Source excluded from package
- ✅ Tests excluded from package
- ✅ Examples excluded from package
- ✅ Peer dependencies optional (except mongoose)
- ✅ Only mime-types as runtime dep

---

## 📊 **Package Stats**

Run to check size:
```bash
npm pack --dry-run
```

**Expected size:**
- Unpacked: ~200-300 KB
- Packed (tarball): ~40-60 KB

**If larger than 500KB:** Something is wrong, check what's included

---

## 🎯 **Pre-Publish Command Summary**

```bash
# Complete pre-publish check
npm run build && \
npm test && \
npm run typecheck && \
npm run publish:dry

# If all pass, publish with:
npm run release:patch  # or minor/major
```

---

## ⚠️ **Common Issues**

### Issue: Tests fail
**Fix:** Run `npm test` and fix failing tests before publishing

### Issue: Type errors
**Fix:** Run `npm run typecheck` - ignore peer dependency warnings

### Issue: Package too large
**Fix:** Check `npm pack --dry-run` output, verify files whitelist

### Issue: Missing types in published package
**Fix:** Ensure `--dts` flag in build script, check dist/ has .d.ts files

### Issue: Import errors after install
**Fix:** Check exports in package.json match dist/ structure

---

## 📝 **Version Strategy**

**Patch (1.0.x):** Bug fixes, no breaking changes
**Minor (1.x.0):** New features, backwards compatible
**Major (x.0.0):** Breaking changes

**Current:** Following semver strictly
