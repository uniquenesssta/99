#!/usr/bin/env node
/**
 * Regression checks for local L1 preview cache eviction.
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

function testEvictionRuntimeExistsAndIsConfigurable() {
  assertIncludes('src/main/preview/runtime/previewLocalCacheEvictionRuntime.ts', 'createPreviewLocalCacheEvictionRuntime')
  assertIncludes('src/main/preview/runtime/previewLocalCacheEvictionRuntime.ts', 'HFM_PREVIEW_LOCAL_CACHE_MAX_GB')
  assertIncludes('src/main/preview/runtime/previewLocalCacheEvictionRuntime.ts', 'HFM_PREVIEW_LOCAL_CACHE_MAX_FILES')
  assertIncludes('src/main/preview/runtime/previewLocalCacheEvictionRuntime.ts', 'HFM_PREVIEW_LOCAL_CACHE_EVICT_IDLE_MS')
}

function testEvictionOnlyTargetsLocalPreviewCacheAndCleansIndex() {
  const text = readText('src/main/preview/runtime/previewLocalCacheEvictionRuntime.ts')
  assert(text.includes('options.localPreviewImageDir()'), 'eviction runtime should only scan local L1 preview cache')
  assert(text.includes("endsWith('.png')"), 'eviction runtime should only remove preview png files')
  assert(text.includes('DELETE FROM preview_cache WHERE output_path IN'), 'eviction runtime must delete local index rows for evicted files')
  assert(text.includes('preview local cache eviction summary'), 'eviction runtime missing summary log')
}

function testStorageRuntimeSchedulesEvictionAfterLocalOkWrites() {
  const text = readText('src/main/preview/runtime/previewCacheStorageRuntime.ts')
  assert(text.includes('createPreviewLocalCacheEvictionRuntime'), 'storage runtime missing local eviction runtime')
  assert(text.includes('evictionRuntime.schedulePreviewLocalCacheEviction'), 'storage runtime does not schedule local eviction')
  assert(text.includes('storage.storage === \"local\"') && text.includes('data.status === \"ok\"'), 'storage runtime should schedule eviction only for local ok writes')
}

function testPackageScriptAndVersion() {
  const pkg = readJson('package.json')
  assert(pkg.version === '3.0.0', 'package.json version changed')
  assert(pkg.scripts && pkg.scripts['diagnostics:preview-local-cache-eviction'] === 'node build/diagnostics/check-preview-local-cache-eviction.cjs', 'missing diagnostics:preview-local-cache-eviction script')
}

const tests = [
  testEvictionRuntimeExistsAndIsConfigurable,
  testEvictionOnlyTargetsLocalPreviewCacheAndCleansIndex,
  testStorageRuntimeSchedulesEvictionAfterLocalOkWrites,
  testPackageScriptAndVersion,
]

for (const test of tests) test()
console.log(`preview local cache eviction checks passed (${tests.length})`)
