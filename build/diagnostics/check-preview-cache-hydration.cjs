#!/usr/bin/env node
/**
 * Regression checks for shared-to-local preview cache hydration.
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

function testHydrationRuntimeExistsAndIsPolicyDriven() {
  assertIncludes('src/main/preview/runtime/previewCacheHydrationRuntime.ts', 'createPreviewCacheHydrationRuntime')
  assertIncludes('src/main/preview/runtime/previewCacheHydrationRuntime.ts', 'DEFAULT_HYDRATE_MAX_IN_FLIGHT = 2')
  assertIncludes('src/main/preview/runtime/previewCacheHydrationRuntime.ts', 'DEFAULT_HYDRATE_TIMEOUT_MS = 2000')
  assertIncludes('src/main/preview/runtime/previewCacheHydrationRuntime.ts', 'HFM_PREVIEW_HYDRATE_MAX_IN_FLIGHT')
  assertIncludes('src/main/preview/runtime/previewCacheHydrationRuntime.ts', 'HFM_PREVIEW_HYDRATE_TIMEOUT_MS')
  assertIncludes('src/main/preview/runtime/previewCacheHydrationRuntime.ts', 'HFM_PREVIEW_SHARED_NEGATIVE_TTL_MS')
}

function testHydrationCoalescesAndNegativeCachesSharedMisses() {
  const text = readText('src/main/preview/runtime/previewCacheHydrationRuntime.ts')
  assert(text.includes('const inFlight = new Map'), 'hydration runtime missing in-flight de-duplication')
  assert(text.includes('const negative = new Map'), 'hydration runtime missing shared negative cache')
  assert(text.includes('rememberSharedMiss'), 'hydration runtime does not remember shared misses')
  assert(text.includes('hydratePreviewCacheRows'), 'hydration runtime missing batch hydration')
}

function testReadPathHydratesOnlyAfterLocalMiss() {
  const text = readText('src/main/preview/runtime/previewCacheStorageRuntime.ts')
  assert(text.includes('hydrationRuntime.rememberLocalHit'), 'read path does not count local hits')
  assert(text.includes('const localMissRows = chunk.filter'), 'read path does not isolate local misses')
  assert(text.includes('hydrationRuntime.hydratePreviewCacheRows') && text.includes('group.storage') && text.includes('localMissRows'), 'read path does not hydrate shared hits into local cache')
  assert(text.includes('hydrationRuntime.rememberRenderQueued'), 'read path does not count render-queued misses')
}

function testRenderPathHydratesBeforeRendering() {
  const text = readText('src/main/preview/previewRuntime.ts')
  assert(text.includes('if (!ignorePreviewIndex && previewCache.shared)'), 'render path does not check shared cache before rendering')
  assert(text.includes('hydratePreviewCache(previewCache'), 'render path does not hydrate shared cache before render fallback')
  assert(text.includes('预览缓存已从共享缓存拉取到本地'), 'render path missing hydration completion message')
}

function testPackageScriptAndVersion() {
  const pkg = readJson('package.json')
  assert(pkg.version === '3.0.0', 'package.json version changed')
  assert(pkg.scripts && pkg.scripts['diagnostics:preview-cache-hydration'] === 'node build/diagnostics/check-preview-cache-hydration.cjs', 'missing diagnostics:preview-cache-hydration script')
}

const tests = [
  testHydrationRuntimeExistsAndIsPolicyDriven,
  testHydrationCoalescesAndNegativeCachesSharedMisses,
  testReadPathHydratesOnlyAfterLocalMiss,
  testRenderPathHydratesBeforeRendering,
  testPackageScriptAndVersion,
]

for (const test of tests) test()
console.log(`preview cache hydration checks passed (${tests.length})`)
