#!/usr/bin/env node
/**
 * Regression checks for shared preview cache meta/checksum validation.
 */
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..', '..')

function readText(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8')
}

function readJson(relativePath) {
  return JSON.parse(readText(relativePath))
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function assertIncludes(relativePath, needle) {
  const text = readText(relativePath)
  assert(text.includes(needle), `${relativePath} missing ${needle}`)
}

function testMetaRuntimeWritesChecksumAndRenderVersion() {
  assertIncludes('src/main/preview/runtime/previewCacheMetaRuntime.ts', 'createPreviewCacheMetaRuntime')
  assertIncludes('src/main/preview/runtime/previewCacheMetaRuntime.ts', "checksumAlgorithm: 'sha1'")
  assertIncludes('src/main/preview/runtime/previewCacheMetaRuntime.ts', 'getPreviewRendererVersion()')
  assertIncludes('src/main/preview/runtime/previewCacheMetaRuntime.ts', '.meta.json')
  assertIncludes('src/main/preview/runtime/previewCacheMetaRuntime.ts', 'HFM_PREVIEW_SHARED_META_STRICT')
}

function testPublishWritesSharedMetaAfterAtomicImageRename() {
  const text = readText('src/main/preview/runtime/previewCachePublishRuntime.ts')
  assert(text.includes('writeSharedPreviewCacheMeta'), 'publish runtime missing meta write hook')
  assert(text.includes('metaWritten'), 'publish summary missing meta write counter')
  assert(text.includes('checksumMismatch'), 'publish summary missing checksum mismatch counter')
  assert(text.includes('preview cache publish meta failed'), 'publish runtime missing meta failure log')
}

function testHydrationValidatesSharedMetaBeforeCopy() {
  const text = readText('src/main/preview/runtime/previewCacheHydrationRuntime.ts')
  assert(text.includes('validateSharedPreviewCacheMeta'), 'hydration runtime missing shared meta validation hook')
  assert(text.includes('sharedMetaValidated'), 'hydration summary missing shared meta validation counter')
  assert(text.includes('sharedMetaMissing'), 'hydration summary missing shared meta missing counter')
  assert(text.includes('preview cache hydrate meta rejected'), 'hydration runtime missing rejected meta log')
}

function testPackageScriptAndVersion() {
  const pkg = readJson('package.json')
  assert(pkg.version === '3.0.0', 'package.json version changed')
  assert(pkg.scripts && pkg.scripts['diagnostics:preview-cache-meta'] === 'node build/diagnostics/check-preview-cache-meta.cjs', 'missing diagnostics:preview-cache-meta script')
}

const tests = [
  testMetaRuntimeWritesChecksumAndRenderVersion,
  testPublishWritesSharedMetaAfterAtomicImageRename,
  testHydrationValidatesSharedMetaBeforeCopy,
  testPackageScriptAndVersion,
]

for (const test of tests) test()
console.log(`preview cache meta checks passed (${tests.length})`)
