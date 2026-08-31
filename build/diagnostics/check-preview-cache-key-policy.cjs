#!/usr/bin/env node
/**
 * Regression checks for preview cache key policy and strict v2 opt-in.
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

function testKeyRuntimeHasStructuredDescriptor() {
  const text = readText('src/main/preview/runtime/previewCacheKeyRuntime.ts')
  for (const needle of [
    'PREVIEW_CACHE_KEY_SCHEMA_VERSION',
    'previewCacheKeyDescriptor',
    'rendererVersion',
    'fontSignature',
    'textHash',
    'outputFormat',
    'dpiBucket',
    'foregroundMode',
    'HFM_PREVIEW_CACHE_KEY_STRICT',
    'legacyPreviewCacheKey',
    'strictPreviewCacheKey',
  ]) {
    assert(text.includes(needle), `preview cache key runtime missing ${needle}`)
  }
}

function testMetaWritesKeyPolicyFieldsCompatibly() {
  const text = readText('src/main/preview/runtime/previewCacheMetaRuntime.ts')
  for (const needle of [
    'keySchemaVersion',
    'previewCacheDpiBucket()',
    'previewCacheForegroundMode()',
    'key-schema-version-mismatch',
    'dpi-bucket-mismatch',
    'foreground-mode-mismatch',
  ]) {
    assert(text.includes(needle), `preview cache meta runtime missing ${needle}`)
  }
}

function testPackageScriptAndVersion() {
  const pkg = readJson('package.json')
  assert(pkg.version === '3.0.0', 'package.json version changed')
  assert(pkg.scripts && pkg.scripts['diagnostics:preview-cache-key-policy'] === 'node build/diagnostics/check-preview-cache-key-policy.cjs', 'missing diagnostics:preview-cache-key-policy script')
}

const tests = [
  testKeyRuntimeHasStructuredDescriptor,
  testMetaWritesKeyPolicyFieldsCompatibly,
  testPackageScriptAndVersion,
]

for (const test of tests) test()
console.log(`preview cache key policy checks passed (${tests.length})`)
