#!/usr/bin/env node
/**
 * Regression checks for NAS preview cache summary observability.
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

function testTierSummaryHasNasCacheCounters() {
  const text = readText('src/main/preview/runtime/previewCacheHydrationRuntime.ts')
  for (const needle of [
    'localHit=',
    'sharedHit=',
    'hydrated=',
    'renderQueued=',
    'sharedUnavailable=',
    'deadlineDropped=',
    'sharedNegativeHit=',
    'sharedPresenceHit=',
    'sharedPresenceIndexHit=',
    'sharedMetaValidated=',
    'sharedMetaMissing=',
    'checksumMismatch=',
  ]) {
    assert(text.includes(needle), `preview cache tier summary missing ${needle}`)
  }
}

function testPublishSummaryHasNasCacheCounters() {
  const text = readText('src/main/preview/runtime/previewCachePublishRuntime.ts')
  for (const needle of [
    'queued=',
    'published=',
    'skippedExisting=',
    'sharedUnavailable=',
    'deadlineDropped=',
    'lockBusy=',
    'metaWritten=',
    'checksumMismatch=',
    'manifestWritten=',
    'indexSkipped=',
  ]) {
    assert(text.includes(needle), `preview cache publish summary missing ${needle}`)
  }
}

function testPrefetchAndCircuitDiagnosticsStillPresent() {
  assert(fs.existsSync(path.join(root, 'build/diagnostics/check-preview-cache-prefetch.cjs')), 'prefetch diagnostic missing')
  assert(fs.existsSync(path.join(root, 'build/diagnostics/check-shared-cache-circuit-breaker.cjs')), 'circuit breaker diagnostic missing')
  assert(fs.existsSync(path.join(root, 'build/diagnostics/check-preview-local-cache-eviction.cjs')), 'local eviction diagnostic missing')
  assert(fs.existsSync(path.join(root, 'build/diagnostics/check-preview-cache-manifest.cjs')), 'manifest diagnostic missing')
  assert(fs.existsSync(path.join(root, 'build/diagnostics/check-preview-cache-key-policy.cjs')), 'key policy diagnostic missing')
}

function testPackageScriptAndVersion() {
  const pkg = readJson('package.json')
  assert(pkg.version === '3.0.0', 'package.json version changed')
  assert(pkg.scripts && pkg.scripts['diagnostics:nas-cache'] === 'node build/diagnostics/check-nas-cache-summary.cjs', 'missing diagnostics:nas-cache script')
}

const tests = [
  testTierSummaryHasNasCacheCounters,
  testPublishSummaryHasNasCacheCounters,
  testPrefetchAndCircuitDiagnosticsStillPresent,
  testPackageScriptAndVersion,
]

for (const test of tests) test()
console.log(`nas cache summary checks passed (${tests.length})`)
