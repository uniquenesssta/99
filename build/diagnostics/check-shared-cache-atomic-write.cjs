#!/usr/bin/env node
/**
 * Regression checks for shared cache write safety.
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

function testSharedWriteDoesNotBlockFrontendRender() {
  const text = readText('src/main/preview/previewRuntime.ts')
  const localIndex = text.indexOf('await writePreviewCacheIndex(previewCache, key')
  const publishIndex = text.indexOf('previewCachePublishRuntime.enqueuePreviewCachePublish(previewCache')
  const completeIndex = text.indexOf("await completeBackgroundTask(taskKey, '预览缓存已生成')")
  assert(localIndex >= 0 && publishIndex > localIndex, 'shared publish is not queued after local cache index write')
  assert(completeIndex > publishIndex, 'background task completion ordering changed unexpectedly')
}

function testSharedWriteHasLeaseAndDeadline() {
  const text = readText('src/main/preview/runtime/previewCachePublishRuntime.ts')
  assert(text.includes('acquirePublishLock'), 'shared publish missing lease lock helper')
  assert(text.includes('expiresAt'), 'shared publish lock has no expiry')
  assert(text.includes('withIoDeadlineResult'), 'shared publish missing I/O deadline')
  assert(text.includes('if (await pathExists(sharedOutputPath)) return'), 'shared publish does not skip existing complete files')
}

function testPackageScriptAndVersion() {
  const pkg = readJson('package.json')
  assert(pkg.version === '3.0.0', 'package.json version changed')
  assert(pkg.scripts && pkg.scripts['diagnostics:shared-cache-atomic-write'] === 'node build/diagnostics/check-shared-cache-atomic-write.cjs', 'missing diagnostics:shared-cache-atomic-write script')
}

const tests = [
  testSharedWriteDoesNotBlockFrontendRender,
  testSharedWriteHasLeaseAndDeadline,
  testPackageScriptAndVersion,
]

for (const test of tests) test()
console.log(`shared cache atomic write checks passed (${tests.length})`)
