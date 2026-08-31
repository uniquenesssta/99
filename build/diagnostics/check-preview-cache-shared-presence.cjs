#!/usr/bin/env node
/**
 * Regression checks for shared preview cache presence memory.
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

function testSharedPresenceRuntimeIsModularAndBounded() {
  assertIncludes('src/main/preview/runtime/previewCacheSharedPresenceRuntime.ts', 'createPreviewCacheSharedPresenceRuntime')
  assertIncludes('src/main/preview/runtime/previewCacheSharedPresenceRuntime.ts', 'HFM_PREVIEW_SHARED_PRESENCE_OK_TTL_MS')
  assertIncludes('src/main/preview/runtime/previewCacheSharedPresenceRuntime.ts', 'HFM_PREVIEW_SHARED_PRESENCE_MISSING_TTL_MS')
  assertIncludes('src/main/preview/runtime/previewCacheSharedPresenceRuntime.ts', 'HFM_PREVIEW_SHARED_PRESENCE_LIMIT')
  assertIncludes('src/main/preview/runtime/previewCacheSharedPresenceRuntime.ts', 'trim')
}

function testHydrationUsesSharedPresenceBeforeSharedDb() {
  const text = readText('src/main/preview/runtime/previewCacheHydrationRuntime.ts')
  assert(text.includes('sharedPresence?: PreviewCacheSharedPresenceRuntime'), 'hydration runtime missing shared presence dependency')
  assert(text.includes('getSharedPresence'), 'hydration runtime does not consult shared presence cache')
  assert(text.includes('sharedPresenceHit'), 'hydration runtime does not log shared presence hits')
  assert(text.includes('forgetSharedPresence'), 'hydration runtime does not drop stale positive presence on copy failure')
}

function testStorageMaintainsSharedPresenceOnIndexChanges() {
  const text = readText('src/main/preview/runtime/previewCacheStorageRuntime.ts')
  assert(text.includes('createPreviewCacheSharedPresenceRuntime'), 'storage runtime missing shared presence runtime')
  assert(text.includes('rememberSharedPresence(storage, previewKey'), 'storage runtime does not remember shared index writes')
  assert(text.includes('forgetSharedPresence(storage, previewKey'), 'storage runtime does not clear shared presence on delete')
}

function testPackageScriptAndVersion() {
  const pkg = readJson('package.json')
  assert(pkg.version === '3.0.0', 'package.json version changed')
  assert(pkg.scripts && pkg.scripts['diagnostics:preview-cache-shared-presence'] === 'node build/diagnostics/check-preview-cache-shared-presence.cjs', 'missing diagnostics:preview-cache-shared-presence script')
}

const tests = [
  testSharedPresenceRuntimeIsModularAndBounded,
  testHydrationUsesSharedPresenceBeforeSharedDb,
  testStorageMaintainsSharedPresenceOnIndexChanges,
  testPackageScriptAndVersion,
]

for (const test of tests) test()
console.log(`preview cache shared presence checks passed (${tests.length})`)
