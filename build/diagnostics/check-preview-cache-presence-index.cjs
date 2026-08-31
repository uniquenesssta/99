#!/usr/bin/env node
/**
 * Regression checks for persistent shared preview cache presence index.
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

function testPresenceIndexRuntimeIsPersistentAndBoundedByTtl() {
  assertIncludes('src/main/preview/runtime/previewCachePresenceIndexRuntime.ts', 'createPreviewCacheSharedPresenceIndexRuntime')
  assertIncludes('src/main/preview/runtime/previewCachePresenceIndexRuntime.ts', 'CREATE TABLE IF NOT EXISTS preview_shared_presence')
  assertIncludes('src/main/preview/runtime/previewCachePresenceIndexRuntime.ts', 'PRIMARY KEY(storage_key, preview_key)')
  assertIncludes('src/main/preview/runtime/previewCachePresenceIndexRuntime.ts', 'HFM_PREVIEW_SHARED_PRESENCE_INDEX_OK_TTL_MS')
  assertIncludes('src/main/preview/runtime/previewCachePresenceIndexRuntime.ts', 'HFM_PREVIEW_SHARED_PRESENCE_INDEX_MISSING_TTL_MS')
}

function testHydrationUsesPersistentIndexBeforeSharedDb() {
  const text = readText('src/main/preview/runtime/previewCacheHydrationRuntime.ts')
  assert(text.includes('sharedPresenceIndex?: PreviewCacheSharedPresenceIndexRuntime'), 'hydration runtime missing persistent presence index dependency')
  assert(text.includes('getSharedPresenceIndex'), 'hydration runtime does not read persistent shared presence index')
  assert(text.includes('rememberSharedPresenceIndex'), 'hydration runtime does not remember persistent shared presence index')
  assert(text.includes('sharedPresenceIndexHit'), 'hydration summary missing persistent index hit counter')
}

function testStorageMaintainsPersistentIndexOnSharedIndexChanges() {
  const text = readText('src/main/preview/runtime/previewCacheStorageRuntime.ts')
  assert(text.includes('createPreviewCacheSharedPresenceIndexRuntime'), 'storage runtime missing persistent shared presence index runtime')
  assert(text.includes('rememberSharedPresenceIndex') && text.includes('storage') && text.includes('previewKey'), 'storage runtime does not persist shared presence on writes')
  assert(text.includes('forgetSharedPresenceIndex') && text.includes('storage') && text.includes('previewKey'), 'storage runtime does not clear persistent shared presence on delete')
}

function testPackageScriptAndVersion() {
  const pkg = readJson('package.json')
  assert(pkg.version === '3.0.0', 'package.json version changed')
  assert(pkg.scripts && pkg.scripts['diagnostics:preview-cache-presence-index'] === 'node build/diagnostics/check-preview-cache-presence-index.cjs', 'missing diagnostics:preview-cache-presence-index script')
}

const tests = [
  testPresenceIndexRuntimeIsPersistentAndBoundedByTtl,
  testHydrationUsesPersistentIndexBeforeSharedDb,
  testStorageMaintainsPersistentIndexOnSharedIndexChanges,
  testPackageScriptAndVersion,
]

for (const test of tests) test()
console.log(`preview cache presence index checks passed (${tests.length})`)
