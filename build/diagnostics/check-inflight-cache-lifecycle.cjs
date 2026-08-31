#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')

const root = path.resolve(__dirname, '..', '..')
function read(rel) { return fs.readFileSync(path.join(root, rel), 'utf8') }
function assert(condition, message) {
  if (!condition) throw new Error(message)
}
function transpile(rel) {
  return ts.transpileModule(read(rel), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  }).outputText
}
function loadTypeScriptModule(rel, localRequire = require) {
  const module = { exports: {} }
  new Function('exports', 'require', 'module', transpile(rel))(module.exports, localRequire, module)
  return module.exports
}
function deferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

async function testEvictedPreviewPromiseCannotDeleteReplacement() {
  const { createCachedPreviewReadCoalescerRuntime } = loadTypeScriptModule(
    'src/main/preview/runtime/cachedPreviewReadCoalescerRuntime.ts',
    (id) => {
      if (id === './cachedPreviewBatchPolicyRuntime') {
        return { CACHED_PREVIEW_READ_BATCH_LIMIT: 20, CACHED_PREVIEW_READ_COALESCE_DELAY_MS: 0 }
      }
      return require(id)
    },
  )
  const runtime = createCachedPreviewReadCoalescerRuntime()
  const gates = []
  let calls = 0
  const item = (index) => ({
    id: `font-${index}`,
    path: `D:/Fonts/font-${index}.ttf`,
    fileSize: index + 1,
    modifiedAt: index + 10,
  })
  const start = (index) => {
    const gate = deferred()
    gates.push(gate)
    return runtime.readSingle(item(index), 'Preview', 34, 520, 150, () => {
      calls += 1
      return gate.promise
    })
  }

  const old = start(0)
  const pending = []
  for (let index = 1; index <= 160; index += 1) pending.push(start(index))
  const replacementGate = deferred()
  const replacement = runtime.readSingle(item(0), 'Preview', 34, 520, 150, () => {
    calls += 1
    return replacementGate.promise
  })
  assert(calls === 162, 'preview in-flight limit did not evict the oldest request as expected')

  gates[0].resolve('old')
  await old
  const joined = runtime.readSingle(item(0), 'Preview', 34, 520, 150, async () => {
    calls += 1
    return 'unexpected-third-task'
  })
  assert(joined === replacement, 'an evicted old preview promise deleted its replacement when it completed')
  assert(calls === 162, 'same-key preview request started a third task after stale cleanup')

  replacementGate.resolve('new')
  for (let index = 1; index < gates.length; index += 1) gates[index].resolve(`value-${index}`)
  await Promise.all([...pending, replacement, joined])
}

async function testMetricsClearDetachesOldGeneration() {
  const { createMetricsInstallStatusReconcileCacheRuntime } = loadTypeScriptModule(
    'src/main/library/fontMetricsInstallStatusReconcileRuntime.ts',
  )
  const runtime = createMetricsInstallStatusReconcileCacheRuntime(60_000)
  const primary = {
    total: 100,
    installedCount: 0,
    notInstalledCount: 80,
    installStatusKnownCount: 80,
    installStatusMissingCount: 20,
    installStatusReady: false,
  }
  const fallback = (installedCount) => ({
    total: 100,
    installedCount,
    notInstalledCount: 100 - installedCount,
    installStatusKnownCount: 100,
    installStatusMissingCount: 0,
    installStatusReady: true,
  })
  const oldGate = deferred()
  const oldTask = runtime.reconcileWithFallback({
    primary,
    source: 'merged-index',
    appendLog: () => undefined,
    loadFallback: () => oldGate.promise,
  })
  runtime.clear()
  const fresh = await runtime.reconcileWithFallback({
    primary,
    source: 'merged-index',
    appendLog: () => undefined,
    loadFallback: async () => fallback(22),
  })
  assert(fresh.installedCount === 22, 'fresh metrics reconcile did not use the post-clear fallback')
  oldGate.resolve(fallback(7))
  await oldTask
  let fallbackCalls = 0
  const cached = await runtime.reconcileWithFallback({
    primary,
    source: 'merged-index',
    appendLog: () => undefined,
    loadFallback: async () => {
      fallbackCalls += 1
      return fallback(99)
    },
  })
  assert(fallbackCalls === 0 && cached.installedCount === 22, 'an old metrics task repopulated cache after clear')
}

function testStaticGenerationAndWiring() {
  const coalescer = read('src/main/preview/runtime/cachedPreviewReadCoalescerRuntime.ts')
  assert(coalescer.includes('if (map.get(key) === promise) map.delete(key)'), 'preview coalescer cleanup is not identity-safe')

  const storage = read('src/main/preview/runtime/previewCacheStorageRuntime.ts')
  assert(storage.includes('readStatusGeneration'), 'preview index status cache is missing generation tracking')
  assert(storage.includes('if (readStatusInFlight.get(statusCacheKey) === readTask)'), 'preview status cleanup is not identity-safe')
  assert(storage.includes('invalidateLibraryShellCache'), 'preview storage is missing library-shell invalidation')
  assert(storage.includes('libraryShellGeneration'), 'preview library-shell cache is missing generation protection')
  assert(storage.includes('if (libraryShellCachePromise === task)'), 'preview library-shell cleanup is not identity-safe')

  const rootAvailability = read('src/main/preview/runtime/previewCacheRootAvailabilityRuntime.ts')
  assert(rootAvailability.includes('probeToken?: object'), 'shared preview root probe is missing a lifecycle token')
  assert(rootAvailability.includes('entries.get(key)?.probeToken !== probeToken'), 'stale shared-root probe can still overwrite a newer availability decision')

  const main = read('src/main/index.ts')
  assert(main.includes('notifyPreviewLibraryShellChanged = invalidatePreviewLibraryShellCache'), 'library save is not wired to preview shell invalidation')
  assert(main.includes('if (saved) notifyPreviewLibraryShellChanged()'), 'successful library save does not invalidate preview routing cache')

  const signature = read('src/main/indexing/shared-metadata/sharedMetadataSignatureRuntime.ts')
  assert(signature.includes('if (signatureInFlight.get(dbPath) === task)'), 'shared metadata signature cleanup is not identity-safe')

  const metrics = read('src/main/library/fontMetricsInstallStatusReconcileRuntime.ts')
  assert(metrics.includes('taskGeneration === generation'), 'metrics reconcile cache is missing generation protection')
  assert(metrics.includes('generation += 1'), 'metrics reconcile clear does not advance generation')
}

async function run() {
  testStaticGenerationAndWiring()
  await testEvictedPreviewPromiseCannotDeleteReplacement()
  await testMetricsClearDetachesOldGeneration()
  console.log('[diagnostics:inflight-cache-lifecycle] ok')
}

run().catch((error) => {
  console.error(`[diagnostics:inflight-cache-lifecycle] ${error instanceof Error ? error.stack || error.message : String(error)}`)
  process.exit(1)
})
