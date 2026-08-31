#!/usr/bin/env node
/**
 * Regression checks for preview request scheduling.
 * First-screen font cards must not create an unbounded fonts:getCachedPreviewImages
 * IPC storm; the main process now coalesces, limits, deadlines, and drops late results.
 */
const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')

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


function loadTypeScriptModule(relativePath, localRequire = require) {
  const output = ts.transpileModule(readText(relativePath), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true
    }
  }).outputText
  const module = { exports: {} }
  new Function('exports', 'require', 'module', output)(module.exports, localRequire, module)
  return module.exports
}

function assertIncludes(relativePath, needle) {
  const text = readText(relativePath)
  assert(text.includes(needle), `${relativePath} missing ${needle}`)
}

function testFixtureDescribesPreviewStorm() {
  const data = readJson('build/diagnostics/fixtures/preview-request-scheduler.fixture.json')
  assert(data.name === 'preview-request-scheduler-fixture', 'unexpected fixture name')
  assert(data.symptoms.slowChannel === 'fonts:getCachedPreviewImages', 'fixture slow channel changed')
  assert(data.symptoms.slowCallCount >= 200, 'fixture no longer represents the 200+ IPC preview storm')
  assert(data.expectedPolicy.batchLimit === 100, 'fixture expected batch limit changed')
}

function testSchedulerRuntimeExistsAndIsPolicyDriven() {
  assertIncludes('src/main/preview/runtime/previewRequestSchedulerRuntime.ts', 'createPreviewRequestSchedulerRuntime')
  assertIncludes('src/main/preview/runtime/previewRequestSchedulerRuntime.ts', 'DEFAULT_PREVIEW_SCHEDULER_BATCH_LIMIT = 100')
  assertIncludes('src/main/preview/runtime/previewRequestSchedulerRuntime.ts', 'DEFAULT_PREVIEW_SCHEDULER_MAX_IN_FLIGHT = 1')
  assertIncludes('src/main/preview/runtime/previewRequestSchedulerRuntime.ts', 'DEFAULT_PREVIEW_SCHEDULER_REQUEST_TIMEOUT_MS = 2000')
  assertIncludes('src/main/preview/runtime/previewRequestSchedulerRuntime.ts', 'HFM_PREVIEW_SCHEDULER_BATCH_LIMIT')
  assertIncludes('src/main/preview/runtime/previewRequestSchedulerRuntime.ts', 'HFM_PREVIEW_SCHEDULER_MAX_IN_FLIGHT')
  assertIncludes('src/main/preview/runtime/previewRequestSchedulerRuntime.ts', 'HFM_PREVIEW_SCHEDULER_REQUEST_TIMEOUT_MS')
}

function testSchedulerCoalescesAndSplitsBatches() {
  const text = readText('src/main/preview/runtime/previewRequestSchedulerRuntime.ts')
  assert(text.includes('pendingGroups'), 'scheduler missing coalesced pending groups')
  assert(text.includes('itemsBySignature'), 'scheduler missing duplicate item merge')
  assert(text.includes('flushPendingGroup'), 'scheduler missing flush step')
  assert(text.includes('for (let index = 0; index < items.length; index += batchLimit)'), 'scheduler does not split batches by batch limit')
  assert(text.includes('filterResultForItems'), 'scheduler does not filter shared batch results per caller')
  assert(text.includes('remainingBatches'), 'scheduler does not track multi-chunk completion per caller')
  assert(text.includes('completeCallerBatch'), 'scheduler does not aggregate split batch results')
}

function testSchedulerLimitsInFlightAndDropsLateResults() {
  const text = readText('src/main/preview/runtime/previewRequestSchedulerRuntime.ts')
  assert(text.includes('while (active < maxInFlight && queue.length)'), 'scheduler does not enforce in-flight limit')
  assert(text.includes('withIoDeadlineResult('), 'scheduler missing deadline wrapper')
  assert(text.includes('expireCaller'), 'scheduler missing caller expiration')
  assert(text.includes('resolveCaller(caller, {})'), 'scheduler does not return deterministic empty results on timeout/drop')
  assert(text.includes('trimQueue'), 'scheduler missing bounded queue backpressure')
}


async function testSplitBatchResultsAreAggregated() {
  const previous = {
    batch: process.env.HFM_PREVIEW_SCHEDULER_BATCH_LIMIT,
    inflight: process.env.HFM_PREVIEW_SCHEDULER_MAX_IN_FLIGHT,
    delay: process.env.HFM_PREVIEW_SCHEDULER_COALESCE_DELAY_MS,
    timeout: process.env.HFM_PREVIEW_SCHEDULER_REQUEST_TIMEOUT_MS,
  }
  process.env.HFM_PREVIEW_SCHEDULER_BATCH_LIMIT = '20'
  process.env.HFM_PREVIEW_SCHEDULER_MAX_IN_FLIGHT = '2'
  process.env.HFM_PREVIEW_SCHEDULER_COALESCE_DELAY_MS = '0'
  process.env.HFM_PREVIEW_SCHEDULER_REQUEST_TIMEOUT_MS = '2000'
  try {
    const { createPreviewRequestSchedulerRuntime } = loadTypeScriptModule(
      'src/main/preview/runtime/previewRequestSchedulerRuntime.ts',
      (id) => {
        if (id === '../../path/ioDeadlineRuntime') {
          return {
            previewCacheQueryTimeoutMs: () => 2000,
            withIoDeadlineResult: async (_label, operation) => ({ ok: true, value: await operation() })
          }
        }
        return require(id)
      }
    )
    const items = Array.from({ length: 45 }, (_, index) => ({
      id: `font-${index}`,
      path: `D:/Fonts/font-${index}.ttf`,
      fileSize: index + 1,
      modifiedAt: index + 10,
    }))
    const batchSizes = []
    const runtime = createPreviewRequestSchedulerRuntime({
      async readCachedPreviewImages(batch) {
        batchSizes.push(batch.length)
        const result = {}
        for (const item of batch) result[item.id] = `data:${item.id}`
        return result
      }
    })
    const result = await runtime.readCachedPreviewImages(items, 'Preview', 34, 520, 150)
    assert(batchSizes.length === 3 && batchSizes.reduce((sum, value) => sum + value, 0) === 45, 'behavior: oversized preview request was not split correctly')
    assert(Object.keys(result).length === 45, 'behavior: split preview batch results were not fully aggregated for the caller')
    assert(result['font-0'] === 'data:font-0' && result['font-44'] === 'data:font-44', 'behavior: aggregated preview results lost the first or last chunk')
  } finally {
    if (previous.batch === undefined) delete process.env.HFM_PREVIEW_SCHEDULER_BATCH_LIMIT
    else process.env.HFM_PREVIEW_SCHEDULER_BATCH_LIMIT = previous.batch
    if (previous.inflight === undefined) delete process.env.HFM_PREVIEW_SCHEDULER_MAX_IN_FLIGHT
    else process.env.HFM_PREVIEW_SCHEDULER_MAX_IN_FLIGHT = previous.inflight
    if (previous.delay === undefined) delete process.env.HFM_PREVIEW_SCHEDULER_COALESCE_DELAY_MS
    else process.env.HFM_PREVIEW_SCHEDULER_COALESCE_DELAY_MS = previous.delay
    if (previous.timeout === undefined) delete process.env.HFM_PREVIEW_SCHEDULER_REQUEST_TIMEOUT_MS
    else process.env.HFM_PREVIEW_SCHEDULER_REQUEST_TIMEOUT_MS = previous.timeout
  }
}

function testIpcHandlerUsesScheduler() {
  const text = readText('src/main/ipc/handlers/previewAndFolderIpcHandlers.ts')
  assert(text.includes('createPreviewRequestSchedulerRuntime'), 'preview IPC handler missing scheduler import')
  assert(text.includes('const previewRequestScheduler = createPreviewRequestSchedulerRuntime'), 'preview IPC handler missing scheduler instance')
  assert(text.includes('previewRequestScheduler.readCachedPreviewImages(items, text, fontSize, width, height)'), 'fonts:getCachedPreviewImages is not routed through scheduler')
}

function testRendererBatchPolicyStillCapsVisiblePrefetch() {
  assertIncludes('src/renderer/src/runtime/preview/queue/fontPreviewBatchPolicyRuntime.ts', 'VISIBLE_PREVIEW_CACHE_BATCH_LIMIT = 100')
  assertIncludes('src/renderer/src/runtime/preview/queue/fontVisiblePreviewQueueRuntime.ts', 'cachedPreviewBatchInFlight')
  assertIncludes('src/renderer/src/runtime/preview/queue/fontVisiblePreviewQueueRuntime.ts', 'collectCachedPreviewBatchCandidates')
}

function testPackageScriptAndVersion() {
  const pkg = readJson('package.json')
  assert(pkg.version === '3.0.0', 'package.json version changed')
  assert(pkg.scripts && pkg.scripts['diagnostics:preview-scheduler'] === 'node build/diagnostics/check-preview-request-scheduler.cjs', 'missing diagnostics:preview-scheduler script')
}

const tests = [
  testFixtureDescribesPreviewStorm,
  testSchedulerRuntimeExistsAndIsPolicyDriven,
  testSchedulerCoalescesAndSplitsBatches,
  testSchedulerLimitsInFlightAndDropsLateResults,
  testIpcHandlerUsesScheduler,
  testRendererBatchPolicyStillCapsVisiblePrefetch,
  testPackageScriptAndVersion,
]

async function run() {
  for (const test of tests) test()
  await testSplitBatchResultsAreAggregated()
  console.log(`preview request scheduler checks passed (${tests.length + 1})`)
}

run().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error))
  process.exit(1)
})
