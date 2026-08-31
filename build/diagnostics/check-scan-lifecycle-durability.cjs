#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')

const root = path.resolve(__dirname, '..', '..')
function read(rel) { return fs.readFileSync(path.join(root, rel), 'utf8') }
function assert(condition, message) {
  if (!condition) {
    console.error(`[diagnostics:scan-lifecycle-durability] ${message}`)
    process.exit(1)
  }
}
function loadTypeScriptModule(rel, localRequire = require) {
  const output = ts.transpileModule(read(rel), {
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
function immediate() { return new Promise((resolve) => setImmediate(resolve)) }

const activeSource = read('src/main/indexing/scan-orchestrator/fontScanActiveJobRuntime.ts')
for (const needle of [
  'let managedScanTail: Promise<void> = Promise.resolve()',
  'requestId !== latestManagedRequestId',
  'abortActiveFontScan(\'新的索引扫描已开始，旧扫描已自动取消。\')',
  'activeFontScanJob = { jobId, folders: normalizedFolders, controller, startedAt, completion }',
  'managedScanTail = request.then(',
  'pendingManagedRequests = Math.max(0, pendingManagedRequests - 1)'
]) assert(activeSource.includes(needle), `managed scan lifecycle missing ${needle}`)

const incrementalSource = read('src/main/indexing/scan-orchestrator/fontScanIncrementalChangeRuntime.ts')
for (const needle of [
  'signal?: AbortSignal',
  'dispose: () => void',
  "options.signal?.addEventListener('abort', dispose, { once: true })",
  'pendingByRoot.clear()',
  'flushTimer.unref?.()'
]) assert(incrementalSource.includes(needle), `incremental scan stream cancellation missing ${needle}`)

const orchestratorSource = read('src/main/indexing/scanOrchestrator.ts')
assert(orchestratorSource.includes('signal,\n      sendFontIndexChanged'), 'scan stream must receive the active scan AbortSignal')
assert((orchestratorSource.match(/incrementalChanges\.dispose\(\)/g) || []).length >= 2, 'scan stream must be disposed on both skipped and completed/failed paths')

const workerSource = read('src/main/indexing/fontScanWorkers.ts')
for (const needle of [
  '索引列表 Worker 在返回完成结果前退出',
  'failed: boolean',
  'if (settled || state.failed) return',
  'handleWorkerFailure(worker, state',
  'Worker 返回的批量结果不完整。',
  'const receivedByJobId = new Map'
]) assert(workerSource.includes(needle), `scan worker lifecycle hardening missing ${needle}`)

async function runManagedScanBehavior() {
  const cancellationModule = {
    isOperationCancelledError(error) {
      return error && (error.name === 'OperationCancelledError' || error.name === 'AbortError')
    }
  }
  let nextJob = 0
  const { createFontScanActiveJobRuntime } = loadTypeScriptModule(
    'src/main/indexing/scan-orchestrator/fontScanActiveJobRuntime.ts',
    (id) => {
      if (id === '../../path/fontPathPolicy') return { normalizeWatchedFontFolders: (folders) => folders.slice() }
      if (id === '../../performance/ioQueue') return cancellationModule
      if (id === './scanOrchestratorUtils') return { createFontScanJobId: () => `job-${++nextJob}` }
      return require(id)
    }
  )

  const calls = []
  let active = 0
  let maxActive = 0
  const scanFolders = (folders, _knownFonts, options) => new Promise((resolve, reject) => {
    const call = { folders, options, resolve, reject, settled: false }
    calls.push(call)
    active += 1
    maxActive = Math.max(maxActive, active)
    const finish = (fn, value) => {
      if (call.settled) return
      call.settled = true
      active -= 1
      fn(value)
    }
    call.resolveResult = (value) => finish(resolve, value)
    options.signal.addEventListener('abort', () => {
      const error = new Error(String(options.signal.reason || 'cancelled'))
      error.name = 'OperationCancelledError'
      finish(reject, error)
    }, { once: true })
  })

  const runtime = createFontScanActiveJobRuntime({
    appendStartupLog() {},
    emitFontIndexProgress() {},
    recheckGlobalIoQueues() {},
    globalIoSnapshot() { return { active: 0, pending: 0, concurrency: 1 } }
  }, scanFolders)

  const first = runtime.scanFoldersManaged(['D:/First'], [])
  await immediate()
  assert(calls.length === 1, 'first managed scan did not start')

  const second = runtime.scanFoldersManaged(['D:/Second'], [])
  const third = runtime.scanFoldersManaged(['D:/Third'], [])
  assert(calls[0].options.signal.aborted, 'the active scan was not aborted by a newer request')
  assert((await first).stats.cancelled === true, 'the replaced scan did not resolve as cancelled')
  assert((await second).stats.cancelled === true, 'an intermediate queued scan was not superseded')

  await immediate()
  assert(calls.length === 2 && calls[1].folders[0] === 'D:/Third', 'the latest queued scan did not start after the old scan settled')
  assert(maxActive === 1, 'managed scans overlapped before the old scan released its resources')
  calls[1].resolveResult({ folders: ['D:/Third'], fonts: [], errors: [], stats: { totalFiles: 0, parsed: 0, fromCache: 0, skippedBad: 0, errors: 0, durationMs: 1 } })
  await third
}

async function runIncrementalAbortBehavior() {
  const { createFontScanIncrementalChangeRuntime } = loadTypeScriptModule(
    'src/main/indexing/scan-orchestrator/fontScanIncrementalChangeRuntime.ts'
  )
  const controller = new AbortController()
  const payloads = []
  const runtime = createFontScanIncrementalChangeRuntime({
    jobId: 'job-1',
    batchSizes: [1],
    minIntervalMs: 100,
    signal: controller.signal,
    sendFontIndexChanged(payload) { payloads.push(payload) },
    appendStartupLog() {}
  })
  const font = (id) => ({ id, path: `D:/Fonts/${id}.ttf` })
  runtime.enqueueUpsert('D:/Fonts', font('first'))
  runtime.enqueueUpsert('D:/Fonts', font('stale'))
  controller.abort('cancelled')
  await new Promise((resolve) => setTimeout(resolve, 140))
  assert(payloads.length === 1 && payloads[0].upserts[0].id === 'first', 'a cancelled scan emitted a delayed stale font batch')
}

Promise.all([runManagedScanBehavior(), runIncrementalAbortBehavior()])
  .then(() => console.log('[diagnostics:scan-lifecycle-durability] ok'))
  .catch((error) => {
    console.error(`[diagnostics:scan-lifecycle-durability] ${error instanceof Error ? error.stack || error.message : String(error)}`)
    process.exit(1)
  })
