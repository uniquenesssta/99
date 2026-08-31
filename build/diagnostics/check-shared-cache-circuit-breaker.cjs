#!/usr/bin/env node
/**
 * Regression checks for shared preview cache circuit breaker behavior.
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

function testCircuitBreakerRuntimeExistsAndIsConfigurable() {
  assertIncludes('src/main/preview/runtime/previewSharedStorageCircuitBreakerRuntime.ts', 'createPreviewSharedStorageCircuitBreakerRuntime')
  assertIncludes('src/main/preview/runtime/previewSharedStorageCircuitBreakerRuntime.ts', 'HFM_SHARED_CACHE_CIRCUIT_FAILURES')
  assertIncludes('src/main/preview/runtime/previewSharedStorageCircuitBreakerRuntime.ts', 'HFM_SHARED_CACHE_CIRCUIT_OPEN_MS')
  assertIncludes('src/main/preview/runtime/previewSharedStorageCircuitBreakerRuntime.ts', 'HFM_SHARED_CACHE_CIRCUIT_LONG_OPEN_MS')
}

function testRootAvailabilityUsesCircuitBreaker() {
  const text = readText('src/main/preview/runtime/previewCacheRootAvailabilityRuntime.ts')
  assert(text.includes('createPreviewSharedStorageCircuitBreakerRuntime'), 'root availability runtime does not use shared storage circuit breaker')
  assert(text.includes('canUseSharedStorage'), 'root availability runtime does not short-circuit open circuit')
  assert(text.includes('recordSharedStorageFailure'), 'root availability runtime does not record shared failures')
  assert(text.includes('recordSharedStorageSuccess'), 'root availability runtime does not reset circuit on success')
}

function testPackageScriptAndVersion() {
  const pkg = readJson('package.json')
  assert(pkg.version === '3.0.0', 'package.json version changed')
  assert(pkg.scripts && pkg.scripts['diagnostics:shared-cache-circuit-breaker'] === 'node build/diagnostics/check-shared-cache-circuit-breaker.cjs', 'missing diagnostics:shared-cache-circuit-breaker script')
}

const tests = [
  testCircuitBreakerRuntimeExistsAndIsConfigurable,
  testRootAvailabilityUsesCircuitBreaker,
  testPackageScriptAndVersion,
]

for (const test of tests) test()
console.log(`shared cache circuit breaker checks passed (${tests.length})`)
