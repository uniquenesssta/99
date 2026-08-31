#!/usr/bin/env node
const fs = require('fs')
const path = require('path')

const root = path.resolve(__dirname, '../..')
function read(rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8')
}
function assert(condition, message) {
  if (!condition) {
    console.error(`[preview-render-concurrency] FAIL: ${message}`)
    process.exit(1)
  }
}
function assertIncludes(rel, text, message = `${rel} missing ${text}`) {
  assert(read(rel).includes(text), message)
}

const fixture = JSON.parse(read('build/diagnostics/fixtures/preview-render-concurrency.fixture.json'))
assert(fixture.before.rustPreviewRenderMaxConcurrency === 1, 'fixture must capture old render concurrency=1')
assert(fixture.after.rustPreviewRenderMaxConcurrency === 5, 'fixture must capture new render concurrency=5')

assertIncludes('src/main/rust-core/rustPreviewRenderConcurrencyRuntime.ts', 'DEFAULT_PREVIEW_RENDER_CONCURRENCY = 5', 'default render concurrency must be 5')
assertIncludes('src/main/rust-core/rustPreviewRenderConcurrencyRuntime.ts', 'HFM_PREVIEW_RENDER_CONCURRENCY', 'render concurrency must be environment configurable')
assertIncludes('src/main/rust-core/rustPreviewRenderConcurrencyRuntime.ts', 'DEFAULT_PREVIEW_RENDER_GLOBAL_MAX = 6', 'global scheduler floor must allow 5 preview renders plus one reserve')
assertIncludes('src/main/rust-core/rustCoreSchedulerRuntime.ts', "maxConcurrency: previewRenderConcurrency()", 'preview render profile must use runtime concurrency')
assertIncludes('src/main/rust-core/rustCoreSchedulerRuntime.ts', 'normalizePreviewRenderConcurrency(command', 'worker-loaded scheduler profile must not reset preview render concurrency to 1')
assertIncludes('src/main/rust-core/rustCoreSchedulerRuntime.ts', 'startedAny', 'scheduler drain must be able to fill same-lane concurrency in one drain cycle')
assertIncludes('src/renderer/src/constants/previewConstants.ts', 'MAX_CONCURRENT_PREVIEW_LOADS = 5', 'renderer visible preview load concurrency must be 5')
assertIncludes('src/main/preview/runtime/previewRequestSchedulerRuntime.ts', 'DEFAULT_PREVIEW_SCHEDULER_MAX_IN_FLIGHT = 1', 'preview cache query scheduler must remain serialized')

console.log('[preview-render-concurrency] OK: 8 checks passed')
