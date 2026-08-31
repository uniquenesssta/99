#!/usr/bin/env node
/**
 * Regression checks for the L1/L2 preview cache tier architecture.
 * Front-path preview reads for watched NAS roots must prefer local SSD cache and
 * only use shared root cache as a hydration/publish tier.
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

function testTierRuntimeExists() {
  assertIncludes('src/main/preview/runtime/previewCacheTierRuntime.ts', 'createPreviewCacheTierRuntime')
  assertIncludes('src/main/preview/runtime/previewCacheTierRuntime.ts', 'localStorageForRoot')
  assertIncludes('src/main/preview/runtime/previewCacheTierRuntime.ts', 'previewCacheStorageToShared')
  assertIncludes('src/main/preview/runtime/previewCacheTierRuntime.ts', "join(options.localPreviewImageDir(), 'roots'")
}

function testStorageRuntimeReturnsLocalTierForWatchedRoots() {
  const text = readText('src/main/preview/runtime/previewCacheStorageRuntime.ts')
  assert(text.includes('return tierRuntime.localStorageForRoot(root, identity)'), 'watched-root preview storage does not return local L1 tier')
  assert(text.includes('preview cache shared tier unavailable, local tier will be used'), 'unavailable shared tier is not downgraded to local tier')
  assert(text.includes('tierRuntime.localStorageForPath'), 'unwatched/system fonts no longer use local fallback storage')
}

function testRuntimeTypeCarriesSharedTier() {
  assertIncludes('src/main/preview/runtime/previewRuntimeTypes.ts', 'PreviewSharedCacheStorage')
  assertIncludes('src/main/preview/runtime/previewRuntimeTypes.ts', 'shared?: PreviewSharedCacheStorage')
}

function testPackageScriptAndVersion() {
  const pkg = readJson('package.json')
  assert(pkg.version === '3.0.0', 'package.json version changed')
  assert(pkg.scripts && pkg.scripts['diagnostics:preview-cache-tier'] === 'node build/diagnostics/check-preview-cache-tier.cjs', 'missing diagnostics:preview-cache-tier script')
}

const tests = [
  testTierRuntimeExists,
  testStorageRuntimeReturnsLocalTierForWatchedRoots,
  testRuntimeTypeCarriesSharedTier,
  testPackageScriptAndVersion,
]

for (const test of tests) test()
console.log(`preview cache tier checks passed (${tests.length})`)
