#!/usr/bin/env node
/**
 * Regression checks for preview cache generation cancellation.
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

function testGenerationRuntimeIsModular() {
  assertIncludes('src/main/preview/runtime/previewTaskGenerationRuntime.ts', 'createPreviewTaskGenerationRuntime')
  assertIncludes('src/main/preview/runtime/previewTaskGenerationRuntime.ts', 'beginGeneration')
  assertIncludes('src/main/preview/runtime/previewTaskGenerationRuntime.ts', 'isCurrentGeneration')
}

function testPrefetchQueueCarriesGeneration() {
  const text = readText('src/main/preview/runtime/previewCachePrefetchRuntime.ts')
  assert(text.includes('generation: number'), 'prefetch queue task does not carry generation')
  assert(text.includes('beginPreviewCachePrefetchGeneration'), 'prefetch runtime missing generation boundary function')
  assert(text.includes('stats.cancelled'), 'prefetch runtime does not count cancelled stale tasks')
  assert(text.includes('generationRuntime.isCurrentGeneration'), 'prefetch pump does not skip stale generation work')
}

function testStatusPathAdvancesGeneration() {
  const text = readText('src/main/preview/runtime/previewCacheStorageRuntime.ts')
  assert(text.includes('beginPreviewCachePrefetchGeneration(\"preview-cache-status\")') || text.includes("beginPreviewCachePrefetchGeneration('preview-cache-status')"), 'status path does not cancel stale prefetch tasks')
}

function testPackageScriptAndVersion() {
  const pkg = readJson('package.json')
  assert(pkg.version === '3.0.0', 'package.json version changed')
  assert(pkg.scripts && pkg.scripts['diagnostics:preview-cache-generation'] === 'node build/diagnostics/check-preview-cache-generation.cjs', 'missing diagnostics:preview-cache-generation script')
}

const tests = [
  testGenerationRuntimeIsModular,
  testPrefetchQueueCarriesGeneration,
  testStatusPathAdvancesGeneration,
  testPackageScriptAndVersion,
]

for (const test of tests) test()
console.log(`preview cache generation checks passed (${tests.length})`)
