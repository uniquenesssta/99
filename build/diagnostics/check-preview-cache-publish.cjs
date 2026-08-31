#!/usr/bin/env node
/**
 * Regression checks for local-to-shared preview cache publish.
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

function testPublishRuntimeExistsAndIsLowPriority() {
  assertIncludes('src/main/preview/runtime/previewCachePublishRuntime.ts', 'createPreviewCachePublishRuntime')
  assertIncludes('src/main/preview/runtime/previewCachePublishRuntime.ts', 'DEFAULT_PUBLISH_DELAY_MS = 7000')
  assertIncludes('src/main/preview/runtime/previewCachePublishRuntime.ts', 'DEFAULT_PUBLISH_MAX_IN_FLIGHT = 1')
  assertIncludes('src/main/preview/runtime/previewCachePublishRuntime.ts', 'HFM_PREVIEW_PUBLISH_DELAY_MS')
  assertIncludes('src/main/preview/runtime/previewCachePublishRuntime.ts', 'enqueuePreviewCachePublish')
}

function testPublishUsesLockTmpAndSharedIndex() {
  const text = readText('src/main/preview/runtime/previewCachePublishRuntime.ts')
  assert(text.includes('preview-cache-publish-mkdir'), 'publish runtime must create shared directory before acquiring lock')
  assert(text.includes('.publish.lock'), 'publish runtime missing per-preview lock')
  assert(text.includes('.tmp.'), 'publish runtime missing temporary file write')
  assert(text.includes('await fsp.rename(tmpPath, sharedOutputPath)'), 'publish runtime does not finalize via rename')
  assert(text.includes('published-from-local-preview-cache'), 'publish runtime does not mark shared index source')
  assert(text.includes('preview cache publish summary'), 'publish runtime missing publish summary log')
}

function testRenderPathPublishesAfterLocalWrite() {
  const text = readText('src/main/preview/previewRuntime.ts')
  assert(text.includes('createPreviewCachePublishRuntime'), 'preview runtime missing publish runtime')
  assert(text.includes('previewCachePublishRuntime.enqueuePreviewCachePublish(previewCache'), 'render path does not enqueue shared publish after local render')
}

function testPackageScriptAndVersion() {
  const pkg = readJson('package.json')
  assert(pkg.version === '3.0.0', 'package.json version changed')
  assert(pkg.scripts && pkg.scripts['diagnostics:preview-cache-publish'] === 'node build/diagnostics/check-preview-cache-publish.cjs', 'missing diagnostics:preview-cache-publish script')
}

const tests = [
  testPublishRuntimeExistsAndIsLowPriority,
  testPublishUsesLockTmpAndSharedIndex,
  testRenderPathPublishesAfterLocalWrite,
  testPackageScriptAndVersion,
]

for (const test of tests) test()
console.log(`preview cache publish checks passed (${tests.length})`)
