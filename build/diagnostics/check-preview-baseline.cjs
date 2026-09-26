#!/usr/bin/env node
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')
const root = path.resolve(__dirname, '../..')
function loader(mocks = {}, transforms = {}) {
  const cache = new Map()
  function load(file) {
    file = path.resolve(root, file)
    if (Object.hasOwn(mocks, file)) return mocks[file]
    if (cache.has(file)) return cache.get(file).exports
    const module = { exports: {} }; cache.set(file, module)
    const source = fs.readFileSync(file, 'utf8')
    const code = ts.transpileModule(transforms[file]?.(source) ?? source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText
    const localRequire = id => Object.hasOwn(mocks, id) ? mocks[id] : id.startsWith('.') ? load(path.resolve(path.dirname(file), `${id}.ts`)) : require(id)
    vm.runInNewContext(code, { module, exports: module.exports, require: localRequire, process, performance, console, Buffer, setTimeout, clearTimeout }, { filename: file })
    return module.exports
  }
  return load
}
async function exercise(transforms = {}) {
  const handlers = new Map(), events = []
  const load = loader({
    electron: { ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) } },
    [path.join(root, 'src/main/security/ipcSenderValidation.ts')]: { assertTrustedIpcSender() {} },
    [path.join(root, 'src/main/rust-core/rustCoreWorkerTransportRuntime.ts')]: { hasCapability: () => true, parseJsonLine: JSON.parse },
    [path.join(root, 'src/main/path/sharedIoProcessRuntime.ts')]: { rethrowSharedIoProcessError: error => { if (error.sharedIo) throw error } },
    [path.join(root, 'src/main/rust-core/rustCoreDaemonWriteBoundaryRuntime.ts')]: { rethrowRustCoreDaemonSubmittedJob() {}, markRustCoreDaemonSubmittedError: e => e }
  }, transforms)
  const append = line => { if (line.startsWith('operation-chain: ')) events.push(JSON.parse(line.slice(17))) }
  const trace = load('src/main/logging/previewBaselineTrace.ts')
  const scheduler = load('src/main/performance/ioScheduler.ts').createIoScheduler({
    idleConcurrency: 1, indexingConcurrency: 1, networkConcurrency: 1, hddConcurrency: 1,
    ssdConcurrency: 1, nvmeConcurrency: 1, removableConcurrency: 1, sqliteWriteConcurrency: 1,
    localScanWorkers: 1, isIndexingActive: () => false, storageProfileForPath: () => ({ type: 'network' })
  })
  const ipc = load('src/main/ipc/ipcTraceRuntime.ts')
  let transport = { daemon: true }, disposed = 0, calls = 0, failure
  const client = load('src/main/rust-core/clients/rustPreviewClientRuntime.ts').createRustPreviewClientRuntime({
    diagnoseRustCoreWorker: async () => ({ available: true, path: 'worker' }),
    createTemporaryJsonFile: () => ({ path: 'temp', writeJson: async () => {}, dispose: async () => { disposed++ } }),
    runRustCoreScheduledCommand: async () => { calls++; await new Promise(resolve => setTimeout(resolve, 2)); if (failure) throw failure; return { ...transport, stdout: JSON.stringify({ ok: true, outputPath: 'image', engine: 'rust-private-gdi', elapsedMs: 0 }) } },
    appendStartupLog: append, appendPreviewCacheFailureLog() {}
  })
  ipc.registerTracedIpcHandler({ appendLog: append }, 'fonts:renderPreviewImage', async (_event, ...args) => {
    assert.equal(args.length, 5, 'diagnostics changed business arguments')
    return scheduler.withGlobalIo('preview:render', trace.bindPreviewBaseline(async () => {
      trace.previewBaselineEvent('preview-cache', { reason: 'memory-miss' })
      return client.runRustPreviewRenderImage({ outputPath: 'image' })
    }, append), { storagePath: 'network' })
  })
  const invoke = () => handlers.get('fonts:renderPreviewImage')({ sender: { id: 1 } }, {}, '', 44, 720, 260)
  delete process.env.HFM_PREVIEW_BASELINE
  process.env.HFM_LOG_DETAIL = 'debug'
  const originalPromise = Promise.resolve('unchanged')
  assert.equal(trace.measurePreviewBaseline('preview-request', () => originalPromise), originalPromise, 'off mode wrapped promise')
  const off = await invoke()
  assert.equal(off.engine, 'rust-directwrite', 'baseline must preserve existing result alias')
  assert(!events.some(e => e.trace?.domain === 'preview-baseline'), 'default enabled')
  process.env.HFM_PREVIEW_BASELINE = '1'
  await Promise.all([invoke(), invoke()])
  const starts = events.filter(e => e.stage === 'preview-request-start')
  assert.equal(starts.length, 2)
  assert.notEqual(starts[0].trace.operationId, starts[1].trace.operationId)
  for (const start of starts) {
    const chain = events.filter(e => e.trace?.operationId === start.trace.operationId)
    assert.equal(chain.filter(e => e.stage === 'preview-request-result').length, 1)
    const native = chain.find(e => e.stage === 'preview-native-result')
    assert.equal(native.backend, 'rust-private-gdi', 'actual engine must come from worker receipt')
    assert.equal(native.transport, 'daemon')
    assert.equal(native.elapsedMs, 0, 'zero worker timing is valid')
    assert(chain.some(e => e.stage === 'preview-cache'))
    assert(chain.find(e => e.stage === 'preview-request-result').elapsedMs >= 0)
  }
  transport = { sharedIo: true, daemon: false }
  await invoke()
  assert.equal(events.filter(e => e.stage === 'preview-native-result').at(-1).transport, 'shared-one-shot')
  failure = Object.assign(new Error('private-font-path'), { sharedIo: true })
  await assert.rejects(invoke, e => e === failure)
  assert.equal(events.filter(e => e.stage === 'preview-request-result').at(-1).outcome, 'rejected')
  assert(!JSON.stringify(events).includes('private-font-path'), 'raw error leaked into trace')
  assert.equal(disposed, calls)
  assert.equal(trace.createPreviewBaselineTrace('fonts:activateFonts'), undefined)
  // Logging failures cannot change success/failure or cause replay.
  failure = undefined
  ipc.registerTracedIpcHandler({ appendLog() { throw Error('disk-full') } }, 'fonts:getCachedPreviewImage', async () => 'cached')
  assert.equal(await handlers.get('fonts:getCachedPreviewImage')({ sender: { id: 1 } }), 'cached')
  const { summarize } = require('../performance/preview-baseline-report.cjs')
  const recording = events.map(e => `operation-chain: ${JSON.stringify(e)}`).join('\n')
  const report = summarize(recording)
  assert.equal(report.requests, 4)
  assert.equal(report.usableMainRecording, true)
  assert.equal(report.endToEndAccepted, false)
  assert.equal(report.groups.reduce((n,g) => n + g.rejected, 0), 1)
  assert(report.groups.every(g => !g.minimum100Requests))
  assert.equal(summarize('').usableMainRecording, false)
  assert.equal(summarize(recording + '\noperation-chain: {"dropped":1}').usableMainRecording, false)
  assert.equal(summarize(recording + '\noperation-chain: broken').usableMainRecording, false)
  assert.equal(summarize(recording + `\noperation-chain: ${JSON.stringify(starts[0])}`).incomplete, 1)
}
async function main() {
  const saved = { HFM_PREVIEW_BASELINE: process.env.HFM_PREVIEW_BASELINE, HFM_LOG_DETAIL: process.env.HFM_LOG_DETAIL }
  try {
    await exercise()
    const file = path.join(root, 'src/main/rust-core/clients/rustPreviewClientRuntime.ts')
    await assert.rejects(() => exercise({ [file]: s => s.replace("payload.engine === 'rust-private-gdi' ? 'rust-private-gdi' : 'unknown'", "'rust-directwrite'") }), /actual engine/, 'engine-label mutant survived')
    const traceFile = path.join(root, 'src/main/logging/previewBaselineTrace.ts')
    await assert.rejects(() => exercise({ [traceFile]: s => s.replace('() => withOperationTrace(trace, append, run)', 'run') }), undefined, 'queue-scope mutant survived')
    console.log('[preview-baseline] real IPC/scheduler/client correlation; default-off, errors, log failure, report quality, engine and queue-scope mutants passed')
  } finally {
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
