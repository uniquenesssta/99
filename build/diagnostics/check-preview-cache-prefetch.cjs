#!/usr/bin/env node
/**
 * Regression checks for background shared-to-local preview cache prefetch.
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

function testPrefetchRuntimeExistsAndIsIdleDriven() {
  assertIncludes('src/main/preview/runtime/previewCachePrefetchRuntime.ts', 'createPreviewCachePrefetchRuntime')
  assertIncludes('src/main/preview/runtime/previewCachePrefetchRuntime.ts', 'HFM_PREVIEW_BACKGROUND_PREFETCH')
  assertIncludes('src/main/preview/runtime/previewCachePrefetchRuntime.ts', 'HFM_PREVIEW_PREFETCH_BATCH_SIZE')
  assertIncludes('src/main/preview/runtime/previewCachePrefetchRuntime.ts', 'HFM_PREVIEW_PREFETCH_IDLE_DELAY_MS')
  assertIncludes('src/main/preview/runtime/previewCachePrefetchRuntime.ts', 'DEFAULT_PREFETCH_MAX_IN_FLIGHT = 1')
}

function testPrefetchUsesHydrationAndDedupedQueue() {
  const text = readText('src/main/preview/runtime/previewCachePrefetchRuntime.ts')
  assert(text.includes('const queue = new Map'), 'prefetch runtime missing de-duped queue')
  assert(text.includes('hydratePreviewCacheRows'), 'prefetch runtime must reuse hydration runtime')
  assert(text.includes('preview cache prefetch summary'), 'prefetch runtime missing summary log')
  assert(text.includes('trimQueue'), 'prefetch runtime missing queue pressure guard')
}

function testStatusPathSchedulesBackgroundPrefetchWithoutBlocking() {
  const text = readText('src/main/preview/runtime/previewCacheStorageRuntime.ts')
  assert(text.includes('createPreviewCachePrefetchRuntime'), 'storage runtime missing prefetch runtime')
  assert(text.includes('prefetchRuntime.schedulePreviewCachePrefetch'), 'status path does not schedule background prefetch')
  assert(text.includes('schedulePrefetchForStatusMisses'), 'status path missing local-miss prefetch helper')
}

function testPackageScriptAndVersion() {
  const pkg = readJson('package.json')
  assert(pkg.version === '3.0.0', 'package.json version changed')
  assert(pkg.scripts && pkg.scripts['diagnostics:preview-cache-prefetch'] === 'node build/diagnostics/check-preview-cache-prefetch.cjs', 'missing diagnostics:preview-cache-prefetch script')
}

const tests = [
  testPrefetchRuntimeExistsAndIsIdleDriven,
  testPrefetchUsesHydrationAndDedupedQueue,
  testStatusPathSchedulesBackgroundPrefetchWithoutBlocking,
  testPackageScriptAndVersion,
]

for (const test of tests) test()
console.log(`preview cache prefetch checks passed (${tests.length})`)
