#!/usr/bin/env node
// Windows-only acceptance: production route owner, budget, transport and pool;
// Controlled lifetime cases plus real native missing-family -> private-copy
// fallback. The immutable CI Arial source is only read and verified unchanged.
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const cp = require('node:child_process')
const fs = require('node:fs'), fsp = fs.promises, path = require('node:path'), os = require('node:os')
const { createHash, randomUUID } = require('node:crypto')
const { fixture, font } = require('./check-preview-optional-cache.cjs')
const png = require('./fixtures/preview-png.cjs')
const lifetimePath = 'src/main/preview/runtime/previewRenderLifetimeRuntime.ts'
// Discovery is imported from both the renderer and its request module using
// different relative spellings. Mock the one module, not one import spelling.
const helperPathModule = path.resolve(__dirname, '../../src/main/preview/native-renderer/directwrite/directWritePreviewHelperPathRuntime.ts')
// Both transport fixtures supply the worker explicitly. Eager Electron imports
// for discovery/autobuild are peripheral here; invoking either is a test error.
const transportDiscoveryPorts = {
  [path.resolve(__dirname, '../../src/main/rust-core/rustCoreWorkerAutoBuildRuntime.ts')]: {
    tryBuildRustCoreWorkerForDevelopment: () => { throw Error('preview fixture must not auto-build a worker') },
  },
  [path.resolve(__dirname, '../../src/main/rust-core/rustCoreWorkerPathRuntime.ts')]: {
    resolveRustCoreWorkerPathWithDiagnostics: () => { throw Error('preview fixture must use its explicit worker path') },
  },
}
const installed = { ...font, systemInstalled: true, family: 'CONTROLLED_PRIVATE_FAMILY' }
const gate = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
const tick = () => new Promise(resolve => setImmediate(resolve))
const render = h => h.runtime.ensureFontPreviewImageFile(installed, 'controlled', 44, 720, 260, false, false, true)

async function boundedWork(promise, label, timeoutMs = 5000) {
  let timer
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error(label)), timeoutMs) })]) }
  finally { clearTimeout(timer) }
}

function observe(promise) {
  const state = { status: 'pending' }
  promise.then(value => { state.status = 'fulfilled'; state.value = value }, error => { state.status = 'rejected'; state.error = error })
  return state
}

async function readyWhen(condition, state, label) {
  const deadline = Date.now() + 2000
  while (!condition()) {
    if (state.status === 'rejected') throw state.error
    assert.equal(state.status, 'pending', label + ': operation settled before readiness')
    assert(Date.now() < deadline, label + ': readiness expired')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

function controlledSpawn(children) {
  return (_file, args) => {
    const child = new EventEmitter(); child.pid = 100 + children.length
    child.stdin = Object.assign(new EventEmitter(), { end() {} })
    child.stdout = Object.assign(new EventEmitter(), { setEncoding() {} })
    child.stderr = Object.assign(new EventEmitter(), { setEncoding() {} })
    child.stdio = [child.stdin, child.stdout, child.stderr, new EventEmitter()]
    child.kill = () => { child.killed = true; return true }
    child.once('close', () => { child.closed = true })
    child.finish = (code = 0, stdout = '{}') => { if (child.closed) return; if (stdout !== null) child.stdout.emit('data', stdout); child.emit('close', code, null) }
    child.args = args; children.push(child); return child
  }
}

async function cancelFailedQuit(load) {
  const shutdown = load('src/main/app/shutdownCoordinatorRuntime.ts'), before = shutdown.applicationWorkEpoch()
  let prompts = 0, restored = 0
  const forbidden = () => { throw Error('cancelled renderer save continued shutdown') }
  const coordinator = shutdown.createShutdownCoordinator({
    log() {}, freeze() {}, restore: () => { restored++ },
    closeRenderers: async () => { throw Error('controlled renderer save failure') },
    confirmLoss: async () => { prompts++; return false }, cleanup: forbidden, save: forbidden, drainLogs: forbidden, terminate: forbidden,
  })
  await boundedWork(coordinator.request(), 'failed renderer save did not restore the application')
  assert.equal(prompts, 1); assert.equal(restored, 1)
  assert.equal(shutdown.isApplicationClosing(), false); assert.equal(shutdown.applicationWorkEpoch(), before + 2)
}

function observeTaskOwners(h) {
  const module = h.load('src/main/preview/runtime/previewRenderTaskRuntime.ts'), create = module.createPreviewRenderTaskRuntime, owners = []
  module.createPreviewRenderTaskRuntime = () => { const owner = create(); owners.push(owner); return owner }
  return owners
}

function backgroundEntry(h, entry, label) {
  if (entry === 'cache') return () => h.runtime.ensureFontPreviewCache(installed, label)
  const runner = h.load('src/main/tasks/backgroundTaskRunnersRuntime.ts').createBackgroundTaskRunnersRuntime({
    ...h.options, normalizePathForCacheCompare: value => value,
    findFontItemInRootIndexes: async (id, sourcePath) => { assert.equal(id, installed.id); assert.equal(sourcePath, installed.path); return installed },
    ensureFontPreviewImageFile: h.runtime.ensureFontPreviewImageFile,
  })
  const task = { task_key: 'preview_cache:' + label, payload_json: JSON.stringify({ fontId: installed.id, path: installed.path, text: label, fontSize: 34, width: 520, height: 150 }) }
  return () => runner.runPreviewCacheTask(task)
}

const ownersIdle = owners => Promise.all(owners.map(owner => owner.whenIdle()))

async function routeCases() {
  for (const reason of ['queue-timeout', 'queue-full', 'cancelled', 'stale-generation', 'stopping', 'closing', 'timeout', 'invalid-receipt', 'process-exit']) {
    const h = fixture(), ErrorType = h.load('src/main/path/sharedIoProcessRuntime.ts').SharedIoProcessError
    h.state.render = async () => { throw new ErrorType('controlled terminal failure', 'not-started', reason) }
    await assert.rejects(render(h), error => error.reason === reason)
    assert.equal(h.state.requests.length, 1, reason + ' submitted a fallback render')
    assert.equal(h.state.stats, 0, reason + ' resolved the fallback source')
    assert.equal(h.state.rows.length, 0); assert.equal(h.state.publications.length, 0)
    const decisions = h.state.logs.filter(line => line.startsWith('preview route decision:'))
    assert(decisions.length <= 1 && decisions.every(line => !line.includes(installed.family) && !line.includes(installed.path)))
  }
  for (const rejectClose of [false, true]) {
    const h = fixture(), closed = gate(), entered = gate()
    const ErrorType = h.load('src/main/path/sharedIoProcessRuntime.ts').SharedIoProcessError
    const failure = new ErrorType('controlled cancelled child', 'unknown', 'cancelled'); failure.closed = closed.promise
    h.state.render = async () => { entered.resolve(); throw failure }
    const first = render(h).catch(error => error); await entered.promise
    const second = render(h).catch(error => error); await tick()
    assert.equal(h.state.requests.length, 1); assert.equal(h.state.unlinks.length, 0, 'lease released before child close')
    if (rejectClose) closed.reject(Error('controlled receipt failure')); else closed.resolve()
    const errors = await Promise.all([first, second])
    assert(errors.every(error => error.reason === 'cancelled' && /HFM_PREVIEW:cancelled/.test(error.message)))
    assert.equal(h.state.requests.length, 1); assert(h.state.cleanupSignals.every(signal => !signal))
    h.state.render = async request => ({ ok: true, bytes: png, transient: true, outputPath: request.outputPath, engine: 'test' })
    assert((await render(h)).transient, 'later independent attempt inherited retired cancellation')
  }
  {
    const h = fixture(), entered = gate(), release = gate(), owners = []
    h.state.render = async request => {
      const owner = h.load(lifetimePath).currentPreviewRenderLifetime(); owners.push(owner)
      if (request.preferSystemFont) { owner.recordQueueWait(1100); entered.resolve(); await release.promise; throw Error('family unavailable') }
      assert.equal(owner.queueTimeoutMs(), 1900)
      return { ok: true, bytes: png, transient: true, outputPath: request.outputPath, engine: 'test' }
    }
    const first = render(h); await entered.promise
    const second = render(h); await tick(); assert.equal(h.state.requests.length, 1)
    release.resolve(); assert((await Promise.all([first, second])).every(value => value.transient))
    assert.equal(h.state.requests.length, 2); assert.equal(h.state.stats, 1)
    assert.equal(owners[0], owners[1], 'fallback minted a new native owner')
  }
  {
    const h = fixture()
    h.state.render = async () => { h.load(lifetimePath).currentPreviewRenderLifetime().recordQueueWait(3000); throw Error('family unavailable') }
    await assert.rejects(render(h), error => error.reason === 'queue-timeout')
    assert.equal(h.state.requests.length, 1); assert.equal(h.state.stats, 0)
  }
  {
    let now = 0
    const h = fixture({ mocks: { 'node:perf_hooks': { performance: { now: () => now } } } })
    h.state.render = async request => { now = 40000; return { ok: true, bytes: png, transient: true, outputPath: request.outputPath, engine: 'test' } }
    await assert.rejects(render(h), error => error.reason === 'timeout')
    assert.equal(h.state.requests.length, 1); assert.equal(h.state.rows.length, 0); assert.equal(h.state.publications.length, 0)
  }
  {
    const h = fixture(), owner = new AbortController(), subscriber = new AbortController(), entered = gate(), release = gate()
    h.state.render = async request => { entered.resolve(); await release.promise; return { ok: true, bytes: png, transient: true, outputPath: request.outputPath, engine: 'test' } }
    const first = h.filesystemPort.withSharedIoSignal(owner.signal, () => render(h)); await entered.promise
    const second = h.filesystemPort.withSharedIoSignal(subscriber.signal, () => render(h)).catch(error => error)
    await tick(); subscriber.abort(); release.resolve()
    assert((await first).transient); assert.match((await second).message, /HFM_PREVIEW:cancelled/)
    assert.equal(h.state.requests.length, 1, 'cancelled joiner restarted or killed native work')
  }
  {
    const h = fixture(), subscriber = new AbortController(), entered = gate(), release = gate()
    h.state.render = async request => { entered.resolve(); await release.promise; return { ok: true, bytes: png, transient: true, outputPath: request.outputPath, engine: 'test' } }
    const first = h.runtime.renderFontPreviewImage(installed, 'same-request'); await entered.promise
    const second = h.filesystemPort.withSharedIoSignal(subscriber.signal, () => h.runtime.renderFontPreviewImage(installed, 'same-request')).catch(error => error)
    await tick(); subscriber.abort(); release.resolve()
    assert((await first).startsWith('data:image/png')); assert.match((await second).message, /HFM_PREVIEW:cancelled/)
    assert((await h.runtime.renderFontPreviewImage(installed, 'same-request')).startsWith('data:image/png'))
    assert.equal(h.state.requests.length, 1, 'memory-key joiner aborted or retired the shared owner')
  }
}

async function compatibleChildCases() {
  for (const reason of ['queue-timeout', 'cancelled', 'stale-generation']) {
    let fallbacks = 0
    const failure = Object.assign(Error('controlled output admission failure'), { sharedIo: true, reason, closed: Promise.resolve() })
    const h = fixture({ mocks: {
      '../../path/sharedFileSystemRuntime': { sharedFileSystem: { writeFile: async () => {}, access: async () => { throw failure } } },
      [helperPathModule]: { findDirectWritePreviewHelperPath: () => null },
      './powershell/powerShellPreviewRendererRuntime': { renderWithPowerShellPreview: async () => { fallbacks++; return { ok: false } } },
    } })
    const renderer = h.load('src/main/preview/native-renderer/previewNativeRendererRuntime.ts').createPreviewNativeRenderer({ appendStartupLog() {}, execFileAsync: async () => { fallbacks++; throw Error('unexpected fallback') }, runRustPreviewRenderImage: async request => ({ ok: true, engine: 'rust-directwrite', outputPath: request.outputPath }) })
    await assert.rejects(renderer.renderNativePreview({ fontPath: 'C:/controlled.ttf', text: 'controlled', fontSize: 44, width: 720, height: 260, outputPath: 'C:/controlled.png' }, 'C:/controlled.json'), error => error === failure)
    assert.equal(fallbacks, 0, 'output-access rejection was converted to renderer fallback')
  }
  for (const expiresBeforeClose of [false, true]) {
    let now = 0, calls = 0
    const entered = gate(), child = new EventEmitter()
    const h = fixture({ mocks: {
      'node:perf_hooks': { performance: { now: () => now } },
      '../../path/sharedFileSystemRuntime': { sharedFileSystem: { writeFile: async () => {}, access: async () => {} }, currentSharedIoSignal: () => undefined, withSharedIoSignal: (_signal, run) => run(), withoutSharedIoSignal: run => run() },
      '../../rust-core/rustSharedIoCommandRuntime': { sharedIoResourceKeys: async () => [] },
      [helperPathModule]: { findDirectWritePreviewHelperPath: () => 'controlled-helper' },
      './directwrite/directWritePreviewRequestRuntime': { renderWithDirectWritePreviewHelper: async (_request, _input, exec) => { await exec('controlled-helper') } },
      './powershell/powerShellPreviewRendererRuntime': { renderWithPowerShellPreview: async (request, _input, exec) => { await exec('controlled-fallback'); return { ok: true, engine: 'powershell-gdi', outputPath: request.outputPath } } },
      '../../rust-core/nodeBridgeFallbackCompatibilityRuntime': { nodeBridgeFallbackCompatibilityAllowed: () => true, logNodeBridgeFallbackUsed() {} },
    } })
    const renderer = h.load('src/main/preview/native-renderer/previewNativeRendererRuntime.ts').createPreviewNativeRenderer({ appendStartupLog() {}, execFileAsync: () => {
      calls++
      if (calls > 1) return Promise.resolve({ stdout: '', stderr: '' })
      entered.resolve()
      return Object.assign(Promise.reject(Error('controlled compatible render failure')), { child })
    } })
    const pending = h.load(lifetimePath).withPreviewRenderLifetime(() => renderer.renderNativePreview({ fontPath: 'C:/controlled.ttf', text: 'controlled', fontSize: 44, width: 720, height: 260, outputPath: 'C:/controlled.png' }, 'C:/controlled.json')).catch(error => error)
    await entered.promise; await tick(); assert.equal(calls, 1, 'fallback started before failed local child close')
    if (expiresBeforeClose) now = 40000
    child.emit('close', 1)
    const result = await pending
    if (expiresBeforeClose) { assert.equal(result.reason, 'timeout'); assert.equal(calls, 1) }
    else { assert.equal(result.ok, true); assert.equal(calls, 2) }
  }
}

async function sharedProofBudgetCase() {
  const proof = gate(), admitted = gate(), timers = new Map(), calls = []
  let now = 0, serial = 0
  const h = fixture({ mocks: {
    'node:perf_hooks': { performance: { now: () => now } },
    'node:os': { tmpdir: () => 'C:\\Temp' },
    'node:fs': { promises: { mkdtemp: async prefix => prefix + (++serial), realpath: async value => value, rm: async () => {} } },
    '../path/sharedPathProbeRuntime': { probeStartupDirectory: async (...args) => { calls.push(args); admitted.resolve(); return proof.promise } },
  }, globals: {
    process: { ...process, platform: 'win32', env: { ...process.env, SystemDrive: 'C:' } },
    setTimeout: (fn, ms) => { const id = {}; timers.set(id, { fn, ms }); return id }, clearTimeout: id => timers.delete(id),
  } })
  const api = h.load(lifetimePath)
  const stages = h.load('src/main/rust-core/ownedPreviewStageRuntime.ts').createOwnedPreviewStageRuntime(async paths => paths.includes('Z:\\controlled.ttf') ? ['shared-root'] : [])
  let firstDone = false
  const first = api.withPreviewRenderLifetime(async lifetime => { lifetime.recordQueueWait(700); return stages.allocate('Z:\\controlled.ttf', lifetime.signal) }).then(value => { firstDone = true; return value })
  await admitted.promise
  assert.equal(calls[0][3].queueTimeoutMs, 2300)
  assert.equal(calls[0][3].signal, undefined, 'shared proof inherited one subscriber cancellation')
  const second = api.withPreviewRenderLifetime(async lifetime => { lifetime.recordQueueWait(2800); return stages.allocate('Z:\\controlled.ttf', lifetime.signal) }).catch(error => error)
  await tick()
  const timer = [...timers].find(([, value]) => value.ms === 200)
  assert(timer, 'late subscriber minted a full proof queue budget')
  timers.delete(timer[0]); timer[1].fn()
  assert.equal((await second).reason, 'queue-timeout'); assert.equal(firstDone, false); assert.equal(calls.length, 1)
  now = 100; proof.resolve({ directory: true, physicalPath: 'C:\\Temp', queuedMs: 100, executionMs: 0 })
  const stage = await first; assert(stage); await stage.dispose(); assert.equal(timers.size, 0)
}

async function composedTransportCases() {
  const children = [], requests = [], owned = new Map(), alarms = new Map()
  const READY_TIMEOUT_MS = 2000, CLEANUP_TIMEOUT_MS = 5000
  const own = promise => {
    if (!owned.has(promise)) {
      const state = { status: 'pending' }; owned.set(promise, state)
      // Observe immediately, while preserving the original promise/rejection
      // for causal assertions and final physical-owner retirement.
      promise.then(value => { state.status = 'fulfilled'; state.value = value }, error => { state.status = 'rejected'; state.error = error })
    }
    return promise
  }
  const bounded = async (promise, timeoutMs, label) => {
    let timer
    try {
      return await Promise.race([promise, new Promise((_, reject) => {
        // Deliberately referenced: missing settlement must fail the gate, not
        // let Node exit successfully with only an unresolved promise.
        timer = setTimeout(() => reject(Error(label)), timeoutMs)
      })])
    } finally { clearTimeout(timer) }
  }
  const spawn = controlledSpawn(children)
  const h = fixture({ globals: {
    queueMicrotask,
    setTimeout: (fn, ms) => {
      const id = setTimeout(() => { alarms.delete(id); fn() }, ms)
      alarms.set(id, { fn, ms }); return id
    },
    clearTimeout: id => { alarms.delete(id); clearTimeout(id) },
  }, mocks: { ...transportDiscoveryPorts, 'node:child_process': { ...cp, spawn } } })
  const transport = h.load('src/main/rust-core/rustCoreWorkerTransportRuntime.ts').createRustCoreWorkerTransportRuntime({ enabled: false, required: false, appendStartupLog() {} })
  const pool = h.load('src/main/path/sharedIoProcessRuntime.ts').applicationSharedIoProcessRuntime(), run = pool.run
  pool.run = request => { requests.push(request); return own(run(request)) }
  const global = h.load('src/main/performance/globalIoRuntime.ts').createGlobalIoRuntime({ env: {}, localScanWorkers: 1, appendLog() {}, isIndexingActive: () => false, isUserActive: () => false, storageProfileForPath: () => ({ type: 'unknown' }) })
  let globalAdmissions = 0
  h.options.withGlobalIo = (...args) => { globalAdmissions++; return global.withGlobalIo(...args) }
  const taskOwners = observeTaskOwners(h)
  h.runtime = h.load('src/main/preview/previewRuntime.ts').createPreviewRuntime(h.options)
  const client = h.load('src/main/rust-core/clients/rustPreviewClientRuntime.ts').createRustPreviewClientRuntime({ ...transport, appendStartupLog() {}, diagnoseRustCoreWorker: async () => ({ available: true, path: process.execPath, capabilities: ['preview-render-image'] }) })
  h.state.render = request => client.runRustPreviewRenderImage(request)
  const until = async (condition, operation, phase) => {
    const deadline = Date.now() + READY_TIMEOUT_MS
    while (!condition()) {
      const state = owned.get(operation)
      if (state?.status === 'rejected') throw state.error
      assert(state?.status !== 'fulfilled', phase + ': operation settled before expected state')
      const status = pool.status()
      assert(Date.now() < deadline, `${phase}: readiness expired; requests=${requests.length}, queued=${status.queued}, active=${status.active}, children=${children.length}, operation=${state?.status || 'untracked'}`)
      await new Promise(resolve => setTimeout(resolve, 10))
    }
  }
  try {
    const blocker = pool.run({ file: process.execPath, args: ['controlled-blocker'], roots: ['configured-root:blocker'], write: true, priority: 'background', timeoutMs: 30000 })
    assert.equal(transport.hasRustCoreInteractiveWork(), false)
    const cancellation = new AbortController()
    const previewWork = own(h.filesystemPort.withSharedIoSignal(cancellation.signal, () => h.runtime.renderFontPreviewImage(installed, 'controlled')))
    const pending = previewWork.catch(error => error)
    await until(() => pool.status().queued === 1, previewWork, 'system-preview admission')
    assert.equal(transport.hasRustCoreInteractiveWork(), true, 'real global→system-preview priority was lost while queued')
    const request = requests.find(value => value.label === 'preview-render-image')
    assert.equal(request.priority, 'foreground'); assert.equal(request.lane, 'default')
    assert(request.write && !request.accesses && request.roots.includes('configured-root:preview-output-unverified'), 'unknown alias writer barrier changed')
    children[0].finish(); await blocker; await until(() => children.length === 2, previewWork, 'system-preview execution')
    assert.equal(transport.hasRustCoreInteractiveWork(), true)
    cancellation.abort(); await tick()
    assert.equal(transport.hasRustCoreInteractiveWork(), true, 'busy owner released on abort before child close')
    assert.equal(h.state.requests.length, 1); assert.equal(h.state.unlinks.length, 0)
    children[1].finish(1); assert.match((await pending).message, /HFM_PREVIEW:cancelled/)
    await pool.whenIdle(); assert.equal(transport.hasRustCoreInteractiveWork(), false)

    // Real direct submission consumes the existing logical ledger once; all
    // unrelated submissions still retain the original three-second allowance.
    const api = h.load(lifetimePath), file = transport.createTemporaryJsonFile('hfm-controlled-budget')
    await file.writeJson({ fontPath: '', outputPath: 'C:/controlled/preview.png' })
    try {
      await api.withPreviewRenderLifetime(async lifetime => {
        lifetime.recordQueueWait(2400)
        const work = own(transport.runRustCoreScheduledCommand(process.execPath, ['--preview-render-image', '--input', file.path], { timeout: 30000, sharedIo: { paths: ['', 'C:/controlled/preview.png'], write: true, preview: true } }))
        const attempt = work.catch(error => error)
        await until(() => requests.length === 3, work, 'remaining-budget admission')
        assert.equal(requests.at(-1).queueTimeoutMs, 600)
        const child = children.at(-1); child.stdout.emit('data', '{"ok":true}'); child.emit('close', 0, null)
        assert.equal(JSON.parse((await attempt).stdout).ok, true)
      })
      const outside = own(transport.runRustCoreScheduledCommand(process.execPath, ['--preview-render-image', '--input', file.path], { timeout: 30000, sharedIo: { paths: ['', 'C:/controlled/preview.png'], write: true, preview: true } }))
      await until(() => requests.length === 4, outside, 'independent-budget admission')
      assert.equal(requests.at(-1).queueTimeoutMs, 3000, 'preview budget leaked into an independent submission')
      children.at(-1).stdout.emit('data', '{"ok":true}'); children.at(-1).emit('close', 0, null)
      assert.equal(JSON.parse((await outside).stdout).ok, true)
    } finally { await file.dispose() }

    const domainReceipt = '{"ok":false,"failureKind":"system-family-unavailable","message":"installed font family unavailable"}'
    for (const sample of [
      { compatible: true }, { code: 1 }, { signal: 'SIGTERM' }, { command: '--not-preview' },
      { stdout: domainReceipt + '\n' + domainReceipt }, { stdout: domainReceipt.slice(0, -1) },
      { stdout: domainReceipt.replace('false', 'true') }, { stdout: domainReceipt.replace('system-family-unavailable', 'unknown') },
      { stdout: domainReceipt.replace('installed font family unavailable', 'output write failed') },
      { stdout: domainReceipt.replace('{', '{"extra":1,') }, { stdout: domainReceipt.replace('{', '{"ok":true,') },
      { input: { fontPath: 'C:/controlled.ttf' } }, { input: { preferSystemFont: false } }, { input: { systemFontFamilyCandidates: [] } },
      { cancelled: true },
    ]) {
      const input = transport.createTemporaryJsonFile('hfm-domain-receipt'), abort = new AbortController()
      await input.writeJson({ fontPath: '', preferSystemFont: true, systemFontFamilyCandidates: ['controlled-absent-family'], outputPath: 'C:/controlled/domain.png', ...sample.input })
      try {
        const previous = children.length
        const work = own(api.withPreviewRenderLifetime(() => transport.runRustCoreScheduledCommand(process.execPath, [sample.command || '--preview-render-image', '--input', input.path], {
          timeout: 30000, signal: abort.signal, sharedIo: { paths: ['\\\\controlled\\share'], write: true },
        })))
        const attempt = work.catch(error => error)
        await until(() => children.length === previous + 1, work, 'domain-receipt execution')
        const child = children.at(-1)
        child.stdout.emit('data', sample.stdout ?? domainReceipt)
        if (sample.cancelled) abort.abort()
        let settled = false; attempt.then(() => { settled = true }); await tick()
        assert.equal(settled, false, 'domain fallback escaped before physical close')
        child.emit('close', sample.code ?? 2, sample.signal ?? null)
        const error = await attempt
        if (sample.compatible) {
          assert(error instanceof api.PreviewRenderDomainError)
          assert.equal(error.cause.reason, 'process-exit'); assert.equal(typeof error.cause.queuedMs, 'number')
        } else {
          assert.equal(error.sharedIo, true, 'unknown/invalid native receipt became compatible')
          assert.equal(error.reason, sample.cancelled ? 'cancelled' : 'process-exit')
        }
      } finally { await input.dispose() }
    }

    // Exercise both coalescing layers through real shutdown epochs and the
    // real transport/pool. A cancelled child still owns its slot and output.
    for (const entry of ['memory', 'native']) for (const quitCount of [1, 2]) {
      const label = `epoch-${entry}-${quitCount}`, item = { ...installed, id: label }
      const invoke = () => entry === 'memory'
        ? h.runtime.renderFontPreviewImage(item, label)
        : h.runtime.ensureFontPreviewImageFile(item, label, 44, 720, 260, false, false, true)
      const valid = result => entry === 'memory' ? result.startsWith('data:image/png;base64,') : result.transient && result.bytes.equals(png)
      h.state.render = async request => {
        await client.runRustPreviewRenderImage(request)
        return { ok: true, bytes: png, transient: true, outputPath: request.outputPath, engine: 'controlled-child' }
      }
      const firstChild = children.length, firstRequest = h.state.requests.length, firstCleanup = h.state.unlinks.length, firstGlobal = globalAdmissions
      const old = own(invoke()), oldResult = old.catch(error => error)
      await until(() => children.length === firstChild + 1, old, label + ' old owner')
      const oldChild = children.at(-1)
      const idle = own(taskOwners[0].whenIdle())
      await cancelFailedQuit(h.load)
      assert(oldChild.killed && !oldChild.closed)

      const retired = []
      if (quitCount === 2) {
        retired.push(own(invoke()), own(invoke()), own(invoke()))
        await tick(); await cancelFailedQuit(h.load)
      }
      const leaderSignal = new AbortController(), waitingSignal = new AbortController()
      const successors = [own(h.filesystemPort.withSharedIoSignal(leaderSignal.signal, invoke)), own(invoke()), own(invoke())]
      const abandoned = own(h.filesystemPort.withSharedIoSignal(waitingSignal.signal, invoke))
      const abandonedResult = abandoned.catch(error => error)
      waitingSignal.abort(); await tick()
      assert.equal(children.length, firstChild + 1, label + ': successor started before old close')
      assert.equal(h.state.requests.length, firstRequest + 1, label + ': retired owner lost native ownership')
      assert.equal(h.state.unlinks.length, firstCleanup, label + ': old lease released before close')
      assert.equal(globalAdmissions, firstGlobal + (entry === 'memory' ? 1 : 0), label + ': successor consumed a global slot before old physical close')
      assert.equal(pool.status().active, 1); assert.equal(pool.status().queued, 0)
      assert.equal(transport.hasRustCoreInteractiveWork(), true)
      assert.equal(owned.get(idle).status, 'pending', label + ': owner idle ignored a held child')
      assert(successors.every(work => owned.get(work).status === 'pending'), label + ': successor inherited old cancellation')
      assert.equal(h.state.rows.length, 0); assert.equal(h.state.publications.length, 0)

      // Even an apparently successful late receipt belongs to the retired epoch.
      oldChild.finish(0, JSON.stringify({ ok: true, engine: 'stale-child', outputPath: h.state.requests[firstRequest].outputPath }))
      assert.match((await boundedWork(oldResult, label + ': old owner did not retire')).message, /HFM_PREVIEW:cancelled/)
      for (const work of retired) {
        assert.match((await boundedWork(work.catch(error => error), label + ': intermediate epoch did not retire')).message, /HFM_PREVIEW:cancelled/)
      }
      assert.match((await boundedWork(abandonedResult, label + ': cancelled waiter did not retire')).message, /HFM_PREVIEW:cancelled/)
      await until(() => children.length === firstChild + 2, successors[1], label + ' successor')
      const successorChild = children.at(-1)
      assert(oldChild.closed && !successorChild.closed)
      assert.equal(owned.get(idle).status, 'pending', label + ': owner idle ignored the current successor')
      assert.equal(h.state.requests.length, firstRequest + 2, label + ': multiple successors rendered')

      // A different memory key still shares this physical output owner. Also
      // retain three late same-key consumers across the old owner's finally.
      const differentKey = own(h.runtime.renderFontPreviewImage({ ...item, id: label + '-alias' }, label))
      const late = [own(invoke()), own(invoke()), own(invoke())]
      await tick(); leaderSignal.abort(); await tick()
      assert.equal(children.length, firstChild + 2); assert.equal(pool.status().active, 1)
      assert.equal(successorChild.killed, undefined, label + ': cancelling one consumer killed shared native work')
      const leaderResult = successors[0].catch(error => error)
      successorChild.finish(0, JSON.stringify({ ok: true, engine: 'current-child', outputPath: h.state.requests.at(-1).outputPath }))
      assert.match((await boundedWork(leaderResult, label + ': cancelled leader did not settle')).message, /HFM_PREVIEW:cancelled/)
      const values = await boundedWork(Promise.all([...successors.slice(1), ...late]), label + ': current epoch did not render')
      assert(values.every(valid)); assert((await boundedWork(differentKey, label + ': distinct memory key did not share native output')).startsWith('data:image/png;base64,'))
      assert.equal(h.state.requests.length, firstRequest + 2)
      assert.equal(h.state.rows.length, 0); assert.equal(h.state.publications.length, 0)
      if (entry === 'memory') { assert(valid(await invoke())); assert.equal(h.state.requests.length, firstRequest + 2, 'current image was not remembered') }
      await boundedWork(pool.whenIdle(), label + ': physical owners did not close')
      await boundedWork(idle, label + ': preview owners did not become idle')
      assert.equal(transport.hasRustCoreInteractiveWork(), false)
    }

    // The intermediate successor can exhaust its own budget while an even
    // older child is still held. Its logical rejection cannot erase that
    // ancestor's physical barrier from the map used by the next successor.
    {
      const label = 'expired-middle-successor', item = { ...installed, id: label }
      const invoke = () => h.runtime.renderFontPreviewImage(item, label)
      const firstChild = children.length, firstRequest = h.state.requests.length, firstGlobal = globalAdmissions
      const old = own(invoke()), oldResult = old.catch(error => error)
      await until(() => children.length === firstChild + 1, old, label + ': ancestor')
      const oldChild = children.at(-1), idle = own(taskOwners[0].whenIdle())
      await cancelFailedQuit(h.load)
      const priorAlarms = new Set(alarms.keys())
      const middle = [own(invoke()), own(invoke()), own(invoke())]
      await tick()
      const middleAlarms = [...alarms].filter(([id]) => !priorAlarms.has(id))
      assert.equal(middleAlarms.length, 1, 'coalesced middle successor minted duplicate lifetime alarms')
      const [alarmId, alarm] = middleAlarms[0]
      assert(alarm.ms >= 5000 && alarm.ms <= 33000, 'middle successor has no bounded logical budget')
      alarms.delete(alarmId); clearTimeout(alarmId); alarm.fn()
      for (const work of middle) assert.match((await boundedWork(work.catch(error => error), 'middle successor did not time out')).message, /HFM_PREVIEW:timeout/)
      assert.equal(owned.get(idle).status, 'pending', 'timed-out successor retired an open ancestor')
      assert.equal(children.length, firstChild + 1); assert.equal(pool.status().active, 1)
      const current = [own(invoke()), own(invoke()), own(invoke())]
      await tick()
      assert(current.every(work => owned.get(work).status === 'pending'), 'third generation inherited the expired result')
      assert.equal(globalAdmissions, firstGlobal + 1, 'third generation entered global I/O before ancestor close')
      assert.equal(h.state.requests.length, firstRequest + 1); assert.equal(children.length, firstChild + 1)
      assert.equal(pool.status().queued, 0); assert.equal(owned.get(idle).status, 'pending')
      oldChild.finish(0, JSON.stringify({ ok: true, engine: 'expired-ancestor', outputPath: h.state.requests[firstRequest].outputPath }))
      assert.match((await boundedWork(oldResult, 'ancestor did not retire after close')).message, /HFM_PREVIEW:cancelled/)
      await until(() => children.length === firstChild + 2, current[0], label + ': current owner')
      assert.equal(globalAdmissions, firstGlobal + 2); assert.equal(h.state.requests.length, firstRequest + 2)
      assert.equal(owned.get(idle).status, 'pending')
      children.at(-1).finish(0, JSON.stringify({ ok: true, engine: 'current-after-expiry', outputPath: h.state.requests.at(-1).outputPath }))
      assert((await boundedWork(Promise.all(current), 'third generation did not render after ancestor close')).every(value => value.startsWith('data:image/png;base64,')))
      await boundedWork(idle, 'expired ancestor chain did not become idle')
      await boundedWork(pool.whenIdle(), 'expired ancestor process did not retire')
      assert.equal(h.state.requests.length, firstRequest + 2); assert.equal(h.state.rows.length, 0); assert.equal(h.state.publications.length, 0)
      assert((await invoke()).startsWith('data:image/png;base64,')); assert.equal(h.state.requests.length, firstRequest + 2)
    }

    // This API returns a plain cache receipt, so it must not discard a cancelled
    // joiner's close receipt and report completion while its child still runs.
    for (const entry of ['cache', 'persisted']) {
      const label = 'held-background-' + entry, cancellation = new AbortController()
      h.state.files.clear(); h.state.index.clear()
      const firstChild = children.length, firstRequest = h.state.requests.length, firstCleanup = h.state.unlinks.length
      const firstRows = h.state.rows.length, firstPublications = h.state.publications.length
      h.state.render = async request => {
        await client.runRustPreviewRenderImage(request)
        h.state.files.set(request.outputPath, png)
        return { ok: true, outputPath: request.outputPath, engine: 'controlled-cache-child' }
      }
      const invoke = backgroundEntry(h, entry, label)
      const old = own(h.filesystemPort.withSharedIoSignal(cancellation.signal, invoke))
      const oldResult = old.catch(error => error)
      await until(() => children.length === firstChild + 1, old, label + ': initial child')
      const child = children.at(-1), idle = own(ownersIdle(taskOwners))
      cancellation.abort(); await tick()
      assert(child.killed && !child.closed); assert.equal(pool.status().active, 1)
      assert.equal(owned.get(old).status, 'pending', 'plain cache receipt discarded a live physical owner')
      assert.equal(owned.get(idle).status, 'pending'); assert.equal(h.state.unlinks.length, firstCleanup)
      assert.equal(h.state.rows.length, firstRows); assert.equal(h.state.publications.length, firstPublications)
      child.finish(0, JSON.stringify({ ok: true, engine: 'cancelled-cache-child', outputPath: h.state.requests[firstRequest].outputPath }))
      const cancelled = await boundedWork(oldResult, label + ': cancellation did not retire after close')
      if (entry === 'cache') { assert.equal(cancelled.ok, false); assert.equal(cancelled.message, h.load('src/shared/previewFailure.ts').previewFailureMessage('cancelled')) }
      else assert.match(cancelled.message, /HFM_PREVIEW:cancelled/)
      await boundedWork(idle, label + ': old owner cleanup')
      assert.equal(h.state.rows.length, firstRows); assert.equal(h.state.publications.length, firstPublications)
      const current = own(invoke())
      await until(() => children.length === firstChild + 2, current, label + ': current child')
      assert.equal(h.state.requests.length, firstRequest + 2)
      children.at(-1).finish(0, JSON.stringify({ ok: true, engine: 'current-cache-child', outputPath: h.state.requests.at(-1).outputPath }))
      const result = await boundedWork(current, label + ': current cache did not finish')
      if (entry === 'cache') assert.equal(result.ok, true); else assert.equal(result, undefined)
      await boundedWork(ownersIdle(taskOwners), label + ': current owner cleanup')
      assert.equal(h.state.rows.length, firstRows + 1); assert.equal(h.state.rows.at(-1).status, 'ok')
      assert.equal(h.state.publications.length, firstPublications + 1)
    }
  } finally {
    transport.stopRustCoreDaemon()
    for (const child of children) if (!child.closed) child.finish(1, null)
    await bounded(Promise.allSettled([...owned.keys()]), CLEANUP_TIMEOUT_MS, 'controlled transport cleanup did not settle owned work')
    await bounded(pool.whenIdle(), CLEANUP_TIMEOUT_MS, 'controlled transport cleanup did not physically close')
    pool.run = run
    assert.equal(alarms.size, 0, 'controlled transport retained a lifetime or process alarm')
  }
}

async function activeSourceCases() {
  for (const sourcePath of ['\\\\controlled-nas\\fonts\\active.ttf', 'Z:\\active.ttf']) {
    for (const fault of ['success', 'ENOENT', 'ENOTDIR', 'EACCES', 'stale-generation', 'timeout', 'cancelled', ...(sourcePath.startsWith('Z:') ? ['identity-unavailable'] : [])]) {
      const label = `active ${sourcePath.startsWith('Z:') ? 'mapped' : 'UNC'} ${fault}`
      const children = [], timers = new Map(), requests = [], raw = [], works = [], sourceErrors = [], processErrors = []
      let protocol, transport, pool
      const execFile = () => { throw Error('unexpected raw child API') }
      execFile[require('node:util').promisify.custom] = async (_file, args) => {
        if (args[0] === '--handshake') return { stdout: JSON.stringify({ ok: true, version: protocol.EXPECTED_RUST_CORE_WORKER_VERSION, protocolVersion: protocol.EXPECTED_RUST_CORE_PROTOCOL_VERSION, capabilities: [...protocol.REQUIRED_RUST_CORE_CAPABILITIES] }), stderr: '' }
        if (args[0] === '--core-scheduler-profile') return { stdout: '{"ok":true,"schedulerVersion":"controlled","profiles":[]}', stderr: '' }
        throw Error('unexpected non-isolated source command: ' + args[0])
      }
      const localFs = new Proxy(fsp, { get(target, property) {
        const member = Reflect.get(target, property)
        return typeof member !== 'function' ? member : (...args) => {
          if (args[0] === sourcePath) { raw.push(String(property)); throw Error('network source reached raw filesystem') }
          return member.apply(target, args)
        }
      } })
      const h = fixture({ globals: {
        queueMicrotask,
        process: { ...process, env: { ...process.env, SystemDrive: 'C:' } },
        setTimeout: (fn, ms) => { const id = { unref() {} }; timers.set(id, { fn, ms }); return id }, clearTimeout: id => timers.delete(id),
      }, mocks: {
        ...transportDiscoveryPorts,
        [path.resolve(__dirname, '../../src/main/rust-core/rustCoreWorkerPathRuntime.ts')]: { resolveRustCoreWorkerPathWithDiagnostics: () => ({ path: process.execPath, candidates: [] }) },
        'node:child_process': { ...cp, spawn: controlledSpawn(children), execFile },
        'node:fs': { ...fs, promises: localFs },
      } })
      // Keep cache files controlled, but use the production shared-source
      // adapter and executor, including its real queue, timers and input leases.
      const cacheFs = h.filesystemPort.sharedFileSystem
      const sourceFs = h.load('src/main/path/sharedFileSystemRuntime.ts')
      Object.assign(h.filesystemPort, sourceFs)
      h.filesystemPort.configureSharedFileExecutor = executor => sourceFs.configureSharedFileExecutor((...args) => {
        const work = executor(...args); works.push(work); observe(work); return work
      })
      h.filesystemPort.sharedFileSystem = new Proxy(cacheFs, { get(target, property) {
        const member = Reflect.get(target, property)
        return typeof member !== 'function' ? member : (...args) => {
          if (args[0] !== sourcePath) return member.apply(target, args)
          return sourceFs.sharedFileSystem[property](...args).catch(error => {
            if (property === 'stat') sourceErrors.push(error)
            throw error
          })
        }
      } })
      const paths = h.load('src/main/path/pathCanonicalizer.ts')
      paths.mappedDriveTableAsync = async () => fault === 'identity-unavailable' ? null : new Map([['Z:', '\\\\controlled-nas\\fonts']])
      paths.mappedDriveTableSnapshot = () => fault === 'identity-unavailable' ? null : new Map([['Z:', '\\\\controlled-nas\\fonts']])
      protocol = h.load('src/main/rust-core/rustCoreProtocolRuntime.ts')
      h.options.resolveExistingFontFilePath = async () => { raw.push('resolver'); throw Error('active network source entered legacy resolver') }
      const taskOwners = observeTaskOwners(h)
      h.runtime = h.load('src/main/preview/previewRuntime.ts').createPreviewRuntime(h.options)
      const controller = new AbortController()
      try {
        transport = h.load('src/main/rust-core/rustCoreWorkerTransportRuntime.ts').createRustCoreWorkerTransportRuntime({ enabled: true, required: true, appendStartupLog() {} })
        pool = h.load('src/main/path/sharedIoProcessRuntime.ts').applicationSharedIoProcessRuntime()
        const run = pool.run
        pool.run = request => { requests.push(request); return run(request).catch(error => { processErrors.push(error); throw error }) }
        const item = { ...installed, id: label, path: sourcePath, active: true, systemInstalled: false }
        const work = h.filesystemPort.withSharedIoSignal(controller.signal, () => h.runtime.renderFontPreviewImage(item, label))
        works.push(work); const state = observe(work), result = work.catch(error => error)
        if (fault === 'identity-unavailable') {
          assert.equal((await boundedWork(result, label)).reason, fault)
          assert.equal(children.length, 0); assert.equal(h.state.requests.length, 0)
        } else {
          await readyWhen(() => children.length === 1, state, label)
          const child = children[0], request = requests[0]
          const idle = taskOwners[0].whenIdle(), idleState = observe(idle); works.push(idle)
          assert.equal(request.label, 'shared-file-io:stat'); assert.equal(request.timeoutMs, 500)
          assert(request.queueTimeoutMs > 0 && request.queueTimeoutMs <= 3000)
          assert.equal(request.lane, 'preview-read'); assert.equal(request.write, false)
          assert.equal(request.verifiedReadOnly, true); assert(request.roots.includes('\\\\controlled-nas\\fonts'))
          assert(request.signal && !request.signal.aborted)
          assert.equal(h.state.requests.length, 0, label + ': rendered before confirming the active source')
          const inputPath = child.args[child.args.indexOf('--input') + 1]
          const input = JSON.parse(await fsp.readFile(inputPath, 'utf8'))
          assert.equal(input.operation, 'stat'); assert.equal(input.path, sourcePath)
          if (fault === 'timeout' || fault === 'cancelled') {
            if (fault === 'timeout') {
              const timer = [...timers].find(([, value]) => value.ms === 500)
              assert(timer, label + ': no bounded source execution owner')
              timers.delete(timer[0]); timer[1].fn()
            } else controller.abort()
            await tick()
            assert(child.killed && !child.closed); assert.equal(pool.status().active, 1)
            assert.equal(idleState.status, 'pending', label + ': logical cancellation discarded the physical owner')
            assert.equal(h.state.requests.length, 0); assert.equal(h.state.unlinks.length, 0)
            assert(fs.existsSync(inputPath), label + ': source input deleted before physical close')
            if (fault === 'cancelled') {
              const error = await boundedWork(result, label + ': subscriber did not cancel')
              assert(error.closed && typeof error.closed.then === 'function', 'cancelled subscriber lost its physical-close receipt')
              const closing = observe(error.closed); await tick()
              assert.equal(closing.status, 'pending', 'cancelled subscriber falsely acknowledged physical close')
            }
            child.finish(0, JSON.stringify({ ok: true, operation: 'stat', value: { size: 100, mtimeMs: 1, isFile: true } }))
            const error = await boundedWork(result, label)
            assert.match(error.message, new RegExp('HFM_PREVIEW:' + fault))
            if (fault === 'timeout') {
              assert.equal(error.cause, sourceErrors[0]); assert.equal(error.closed, sourceErrors[0].closed)
            }
            assert.equal(h.state.requests.length, 0, label + ': terminal source failure reached system fallback')
          } else {
            if (fault === 'stale-generation') {
              h.load('src/main/path/startupPathAvailabilityRuntime.ts').markStartupPathRootUnavailable(input.availabilityRoot, Error('controlled generation change'))
              await tick(); assert.equal(idleState.status, 'pending'); assert.equal(pool.status().active, 1)
              assert.equal(h.state.requests.length, 0)
            }
            child.finish(0, JSON.stringify(fault === 'success' || fault === 'stale-generation'
              ? { ok: true, operation: 'stat', value: { size: 100, mtimeMs: 1, isFile: true } }
              : { ok: false, operation: 'stat', code: fault, message: 'controlled source ' + fault }))
            const value = await boundedWork(result, label)
            if (fault === 'EACCES' || fault === 'stale-generation') {
              assert.match(value.message, new RegExp('HFM_PREVIEW:' + (fault === 'EACCES' ? 'unavailable' : 'cancelled')))
              assert.equal(value.reason, fault); assert.equal(h.state.requests.length, 0)
              assert.equal(sourceErrors.length, 1); assert.equal(sourceErrors[0].sharedIo, true)
              assert.equal(value.cause, sourceErrors[0]); assert.equal(value.closed, sourceErrors[0].closed)
              assert(child.closed, 'post-receipt source error preceded physical close')
            } else {
              const missing = fault === 'ENOENT' || fault === 'ENOTDIR'
              assert(value.startsWith('data:image/png;base64,')); assert.equal(h.state.requests.length, 1)
              assert.equal(h.state.requests[0].fontPath, missing ? '' : sourcePath)
              assert.equal(!!h.state.requests[0].preferSystemFont, missing)
              if (missing) { assert.equal(sourceErrors.length, 1); assert.equal(sourceErrors[0].code, fault) }
            }
          }
          await boundedWork(Promise.allSettled(works), label + ': source executor did not finish cleanup')
          if (fault === 'timeout' || fault === 'cancelled') {
            assert.equal(processErrors.length, 1); assert.equal(sourceErrors.length, 1)
            assert.equal(sourceErrors[0], processErrors[0], label + ': original process failure was replaced')
            assert(sourceErrors[0].closed && typeof sourceErrors[0].closed.then === 'function')
            assert.equal(sourceErrors[0].closed, processErrors[0].closed)
            await boundedWork(sourceErrors[0].closed, label + ': original close receipt did not settle')
          }
          await boundedWork(pool.whenIdle(), label + ': source child did not retire')
          assert.equal(children.length, 1); assert(child.closed)
          assert.equal(fs.existsSync(inputPath), false, label + ': source input lease survived close')
        }
        assert.deepEqual(raw, [], label + ': raw network resolver/access was used')
        assert.equal(h.state.rows.length, 0); assert.equal(h.state.publications.length, 0)
      } finally {
        transport?.stopRustCoreDaemon()
        for (const child of children) child.finish(1, null)
        await boundedWork(Promise.allSettled(works), label + ': owned work did not settle')
        if (pool) await boundedWork(pool.whenIdle(), label + ': cleanup did not physically close')
        await boundedWork(taskOwners[0].whenIdle(), label + ': source owner did not become idle')
        await tick()
        assert.equal(timers.size, 0, label + ': lifetime alarm survived cleanup')
      }
    }
  }
}

async function globalQueueCases() {
  for (const fault of ['cancelled', 'quit', 'timeout', 'remaining-budget']) {
    let now = 0
    const timers = new Map(), release = gate(), works = [], h = fixture({
      mocks: { 'node:perf_hooks': { performance: { now: () => now } } },
      globals: {
        process: { ...process, env: { ...process.env, HFM_RUST_PREVIEW_RENDER_TIMEOUT_MS: '30000' } },
        setTimeout: (fn, ms) => { const id = { unref() {} }; timers.set(id, { fn, ms }); return id }, clearTimeout: id => timers.delete(id),
      },
    })
    const global = h.load('src/main/performance/globalIoRuntime.ts').createGlobalIoRuntime({ env: {}, localScanWorkers: 1, appendLog() {}, isIndexingActive: () => false, isUserActive: () => false, storageProfileForPath: () => ({ type: 'unknown' }) })
    h.options.withGlobalIo = global.withGlobalIo
    const taskOwners = observeTaskOwners(h)
    h.runtime = h.load('src/main/preview/previewRuntime.ts').createPreviewRuntime(h.options)
    let blockersEntered = 0
    const blockers = Array.from({ length: 10 }, () => global.withGlobalIo('preview:render', async () => { blockersEntered++; await release.promise }))
    works.push(...blockers)
    const leaderSignal = new AbortController(), label = 'global-queue-' + fault
    const invoke = () => h.runtime.renderFontPreviewImage({ ...installed, id: label }, label)
    h.state.render = async request => {
      if (fault === 'remaining-budget') {
        const lifetime = h.load(lifetimePath).currentPreviewRenderLifetime()
        assert.equal(lifetime.remainingMs(), 1000, 'global wait minted a fresh native lifetime')
        assert.equal(lifetime.queueTimeoutMs(), 1000, 'native admission exceeded the remaining logical deadline')
      }
      return { ok: true, bytes: png, transient: true, outputPath: request.outputPath, engine: 'queue-fixture' }
    }
    try {
      await readyWhen(() => blockersEntered === 10, { status: 'pending' }, label + ': real preview lane blockers')
      const old = h.filesystemPort.withSharedIoSignal(leaderSignal.signal, invoke), oldResult = old.catch(error => error)
      works.push(old); const state = observe(old)
      await readyWhen(() => global.globalIoSnapshot().lanes.preview.pending === 1, state, label + ': real preview queue')
      assert.equal(h.state.requests.length, 0); assert.equal(global.globalIoSnapshot().lanes.preview.active, 10)

      const current = []
      if (fault === 'remaining-budget') {
        current.push(invoke(), invoke(), invoke()); current.forEach(observe); works.push(...current)
        leaderSignal.abort(); now = 32000
        await tick(); assert.equal(global.globalIoSnapshot().lanes.preview.pending, 1, 'one cancelled subscriber removed shared queued work')
      } else {
        if (fault === 'quit') await cancelFailedQuit(h.load)
        else if (fault === 'cancelled') leaderSignal.abort()
        else {
          const alarm = [...timers].find(([, value]) => value.ms === 33000)
          assert(alarm, 'queued preview has no whole-action deadline')
          timers.delete(alarm[0]); alarm[1].fn()
        }
        const error = await boundedWork(oldResult, label + ': queued cancellation was not delivered')
        assert.match(error.message, new RegExp('HFM_PREVIEW:' + (fault === 'timeout' ? 'timeout' : 'cancelled')))
        await boundedWork(taskOwners[0].whenIdle(), label + ': cancelled queue owner did not retire')
        assert.equal(global.globalIoSnapshot().lanes.preview.pending, 0, 'cancelled preview remained in the real queue')
        assert.equal(h.state.requests.length, 0, 'cancelled global callback was executed')
        current.push(invoke(), invoke(), invoke()); current.forEach(observe); works.push(...current)
        await readyWhen(() => global.globalIoSnapshot().lanes.preview.pending === 1, observe(current[0]), label + ': restored queue')
      }
      assert.equal(global.globalIoSnapshot().lanes.preview.pending, 1, 'three consumers consumed duplicate global slots')
      release.resolve()
      assert.match((await boundedWork(oldResult, label + ': former leader did not settle')).message, new RegExp('HFM_PREVIEW:' + (fault === 'timeout' ? 'timeout' : 'cancelled')))
      const values = await boundedWork(Promise.all(current), label + ': current queue consumers did not render')
      assert(values.every(value => value.startsWith('data:image/png;base64,')))
      assert.equal(h.state.requests.length, 1)
      await boundedWork(taskOwners[0].whenIdle(), label + ': owner cleanup')
      await boundedWork(Promise.all(blockers), label + ': blocker cleanup')
      await tick()
      assert.equal(global.globalIoSnapshot().lanes.preview.pending, 0); assert.equal(global.globalIoSnapshot().lanes.preview.active, 0)
      assert.equal(h.state.rows.length, 0); assert.equal(h.state.publications.length, 0)
    } finally {
      release.resolve()
      await boundedWork(Promise.allSettled(works), label + ': real queue fixture cleanup')
      await boundedWork(taskOwners[0].whenIdle(), label + ': all preview owners did not retire')
      assert.equal(timers.size, 0, label + ': lifetime timer survived real queue retirement')
    }
  }
}

async function backgroundQueueCases() {
  for (const entry of ['cache', 'persisted']) for (const fault of ['quit', 'timeout', 'remaining-budget']) {
    let now = 0, blockerEntered = false
    const release = gate(), timers = new Map(), works = [], h = fixture({
      mocks: { 'node:perf_hooks': { performance: { now: () => now } } },
      globals: {
        process: { ...process, env: { ...process.env, HFM_RUST_PREVIEW_RENDER_TIMEOUT_MS: '30000' } },
        setTimeout: (fn, ms) => { const id = { unref() {} }; timers.set(id, { fn, ms }); return id }, clearTimeout: id => timers.delete(id),
      },
    })
    const global = h.load('src/main/performance/globalIoRuntime.ts').createGlobalIoRuntime({ env: { HFM_IO_WORKERS: '1' }, localScanWorkers: 1, appendLog() {}, isIndexingActive: () => false, isUserActive: () => false, storageProfileForPath: () => ({ type: 'unknown' }) })
    h.options.withGlobalIo = global.withGlobalIo
    const taskOwners = observeTaskOwners(h)
    h.runtime = h.load('src/main/preview/previewRuntime.ts').createPreviewRuntime(h.options)
    const originalRender = h.state.render
    h.state.render = request => {
      assert.equal(request.foregroundBytes, undefined, 'cache work changed to transient foreground rendering')
      if (fault === 'remaining-budget') assert.equal(h.load(lifetimePath).currentPreviewRenderLifetime().remainingMs(), 1000, 'background queue wait reset the native lifetime')
      return originalRender(request)
    }
    const blocker = global.withGlobalIo('background-queue-blocker', async () => { blockerEntered = true; await release.promise })
    works.push(blocker)
    const label = 'background-queue-' + entry + '-' + fault, invoke = backgroundEntry(h, entry, label)
    try {
      await readyWhen(() => blockerEntered, { status: 'pending' }, label + ': blocker')
      const old = invoke(), oldResult = old.catch(error => error); works.push(old)
      await readyWhen(() => global.globalIoSnapshot().lanes.global.pending === 1, observe(old), label + ': cache admission')
      assert.equal(h.state.requests.length, 0); assert.equal(h.state.tasks.length, 0); assert.equal(h.state.publications.length, 0)
      let current = old
      if (fault === 'remaining-budget') now = 32000
      else {
        if (fault === 'quit') await cancelFailedQuit(h.load)
        else {
          const alarm = [...timers].find(([, value]) => value.ms === 33000)
          assert(alarm, 'background queued work has no logical deadline')
          timers.delete(alarm[0]); alarm[1].fn()
        }
        const failed = await boundedWork(oldResult, label + ': old queued cache work did not retire')
        const kind = fault === 'timeout' ? 'timeout' : 'cancelled'
        if (entry === 'cache') { assert.equal(failed.ok, false); assert.equal(failed.message, h.load('src/shared/previewFailure.ts').previewFailureMessage(kind)) }
        else assert.match(failed.message, new RegExp('HFM_PREVIEW:' + kind))
        await boundedWork(ownersIdle(taskOwners), label + ': old cache owner cleanup')
        assert.equal(global.globalIoSnapshot().lanes.global.pending, 0)
        assert.equal(h.state.requests.length, 0); assert.equal(h.state.tasks.length, 0); assert.equal(h.state.publications.length, 0)
        current = invoke(); works.push(current)
        await readyWhen(() => global.globalIoSnapshot().lanes.global.pending === 1, observe(current), label + ': resumed cache admission')
      }
      release.resolve()
      const result = await boundedWork(current, label + ': current cache work did not render')
      if (entry === 'cache') assert.equal(result.ok, true); else assert.equal(result, undefined)
      await boundedWork(ownersIdle(taskOwners), label + ': current cache owner cleanup')
      assert.equal(h.state.requests.length, 1); assert.equal(h.state.rows.at(-1).status, 'ok'); assert.equal(h.state.publications.length, 1)
      assert(h.state.tasks.some(task => task.method === 'completeBackgroundTask'))
    } finally {
      release.resolve(); await boundedWork(Promise.allSettled(works), label + ': fixture cleanup')
      await boundedWork(ownersIdle(taskOwners), label + ': physical owner cleanup')
      await tick(); assert.equal(global.globalIoSnapshot().lanes.global.pending, 0); assert.equal(global.globalIoSnapshot().lanes.global.active, 0)
      assert.equal(timers.size, 0)
    }
  }
}

async function epochBoundaryCases() {
  {
    const h = fixture(), entered = gate(), release = gate()
    let queued = 0
    h.options.withGlobalIo = async (_label, work) => {
      if (++queued === 1) { entered.resolve(); await release.promise }
      return work()
    }
    const taskOwners = observeTaskOwners(h)
    h.runtime = h.load('src/main/preview/previewRuntime.ts').createPreviewRuntime(h.options)
    const old = h.runtime.renderFontPreviewImage(installed, 'held-global-callback'), oldResult = old.catch(error => error)
    const works = [old]
    try {
      await boundedWork(entered.promise, 'old global callback did not queue')
      await cancelFailedQuit(h.load)
      const current = h.runtime.renderFontPreviewImage(installed, 'held-global-callback'); works.push(current); observe(current)
      await tick(); assert.equal(queued, 1, 'successor claimed a second global slot before old work retired')
      assert.equal(h.state.requests.length, 0)
      release.resolve()
      assert.match((await boundedWork(oldResult, 'old global callback did not retire')).message, /HFM_PREVIEW:cancelled/)
      assert((await boundedWork(current, 'new epoch inherited a stale global callback')).startsWith('data:image/png;base64,'))
      assert.equal(queued, 2); assert.equal(h.state.requests.length, 1, 'old queued callback started rendering after restoration')
      assert((await h.runtime.renderFontPreviewImage(installed, 'held-global-callback')).startsWith('data:image/png;base64,'))
      assert.equal(h.state.requests.length, 1, 'current memory entry was lost to an old finally')
    } finally {
      release.resolve(); await boundedWork(Promise.allSettled(works), 'global callback fixture cleanup')
      await boundedWork(taskOwners[0].whenIdle(), 'global callback physical-owner cleanup')
    }
  }
  for (const expiry of [false, true]) {
    let now = 0
    const h = fixture({ mocks: { 'node:perf_hooks': { performance: { now: () => now } } } }), entered = gate(), closed = gate()
    const ErrorType = h.load('src/main/path/sharedIoProcessRuntime.ts').SharedIoProcessError
    const failure = new ErrorType('controlled old owner failure', 'unknown', 'cancelled'); failure.closed = closed.promise
    h.state.render = async request => {
      if (h.state.requests.length === 1) { entered.resolve(); throw failure }
      return { ok: true, bytes: png, transient: true, outputPath: request.outputPath, engine: 'current' }
    }
    const taskOwners = observeTaskOwners(h)
    h.runtime = h.load('src/main/preview/previewRuntime.ts').createPreviewRuntime(h.options)
    const old = h.runtime.renderFontPreviewImage(installed, 'rejected-close'), oldResult = old.catch(error => error), works = [old]
    try {
      await boundedWork(entered.promise, 'old receipt owner did not enter')
      await cancelFailedQuit(h.load)
      const current = h.runtime.renderFontPreviewImage(installed, 'rejected-close'); works.push(current)
      const state = observe(current), currentResult = current.catch(error => error)
      await tick(); assert.equal(state.status, 'pending'); assert.equal(h.state.requests.length, 1)
      if (expiry) now = 40000
      closed.reject(Error('controlled physical-close receipt failure'))
      assert.match((await boundedWork(oldResult, 'rejected close blocked old retirement')).message, /HFM_PREVIEW:cancelled/)
      const value = await boundedWork(currentResult, 'rejected close blocked successor retirement')
      if (expiry) {
        assert.match(value.message, /HFM_PREVIEW:timeout/)
        assert.equal(h.state.requests.length, 1, 'successor reset its lifetime after waiting for an old owner')
      } else {
        assert(value.startsWith('data:image/png;base64,')); assert.equal(h.state.requests.length, 2)
      }
    } finally {
      closed.resolve(); await boundedWork(Promise.allSettled(works), 'rejected-close fixture cleanup')
      await boundedWork(taskOwners[0].whenIdle(), 'rejected-close physical-owner cleanup')
    }
  }
}

async function main() {
  assert.equal(process.platform, 'win32', 'Preview fallback acceptance is Windows-only')
  await routeCases(); await compatibleChildCases(); await sharedProofBudgetCase(); await composedTransportCases(); await activeSourceCases(); await globalQueueCases(); await backgroundQueueCases(); await epochBoundaryCases(); await nativeMissingFamilyCase()
  console.log('PASS bounded preview fallback, shared owner retirement, closed-receipt rejection, reduced queue admission, alias barrier, composed foreground busy lifetime, isolated active sources and cancelled-quit epoch successors')
}

async function nativeMissingFamilyCase() {
  const worker = path.resolve(__dirname, '../../build/native/hfm-core-worker.exe')
  assert(fs.existsSync(worker), 'Build the Windows native worker before this acceptance gate')
  const original = path.join(process.env.WINDIR, 'Fonts', 'arial.ttf')
  assert(fs.existsSync(original), 'Immutable CI Arial fixture source is required')
  const digest = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex')
  const before = digest(original), directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'hfm-preview-domain-'))
  const absentFamily = 'HFM_ABSENT_' + randomUUID().replace(/-/g, '')
  const privateFont = path.join(directory, absentFamily + '.ttf'), cacheDirectory = path.join(directory, 'cache')
  const jobs = [], live = new Set(), owners = []
  let transport, pool
  try {
    await fsp.copyFile(original, privateFont); await fsp.mkdir(cacheDirectory)
    assert.equal(digest(privateFont), before)
    const h = fixture({ cacheDirectory, globals: { queueMicrotask }, mocks: {
      ...transportDiscoveryPorts,
      'node:child_process': { ...cp, spawn: (file, args, options) => {
        const render = args[0] === '--preview-render-image'
        const prior = jobs.at(-1)
        if (render && prior) assert(prior.closed, 'file fallback started before system child close')
        const child = cp.spawn(file, args, options), job = { args, closed: false, code: null, stdout: '' }
        live.add(child); if (render) jobs.push(job)
        child.stdout.on('data', chunk => { if (render) job.stdout += chunk.toString() })
        child.once('close', code => { job.closed = true; job.code = code; live.delete(child) })
        return child
      } },
      [helperPathModule]: { findDirectWritePreviewHelperPath: () => null },
    } })
    // Only this fixture's source/output files use real filesystem ports.
    Object.assign(h.filesystemPort.sharedFileSystem, fsp)
    h.options.resolveExistingFontFilePath = async () => privateFont
    h.runtime = h.load('src/main/preview/previewRuntime.ts').createPreviewRuntime(h.options)
    transport = h.load('src/main/rust-core/rustCoreWorkerTransportRuntime.ts').createRustCoreWorkerTransportRuntime({ enabled: false, required: false, appendStartupLog() {} })
    pool = h.load('src/main/path/sharedIoProcessRuntime.ts').applicationSharedIoProcessRuntime()
    const client = h.load('src/main/rust-core/clients/rustPreviewClientRuntime.ts').createRustPreviewClientRuntime({ ...transport, appendStartupLog() {}, diagnoseRustCoreWorker: async () => ({ available: true, path: worker, capabilities: ['preview-render-image'] }) })
    const native = h.load('src/main/preview/native-renderer/previewNativeRendererRuntime.ts').createPreviewNativeRenderer({ appendStartupLog() {}, execFileAsync: async () => { throw Error('unexpected compatibility backend') }, runRustPreviewRenderImage: client.runRustPreviewRenderImage })
    h.state.render = request => {
      owners.push(h.load(lifetimePath).currentPreviewRenderLifetime())
      return native.renderNativePreview(request, request.outputPath + '.json')
    }
    const stat = await fsp.stat(privateFont)
    const item = { ...installed, id: 'native-domain-fixture', path: privateFont, fileSize: stat.size, modifiedAt: stat.mtimeMs, family: absentFamily }
    const result = await h.runtime.ensureFontPreviewImageFile(item, 'Ag', 44, 720, 260, false, true, false)
    assert(result && h.load('src/main/preview/runtime/previewImageValidationRuntime.ts').isCompletePreviewPng(result.bytes))
    assert.equal(jobs.length, 2); assert.equal(jobs[0].code, 2); assert.equal(jobs[1].code, 0)
    assert.equal(JSON.parse(jobs[0].stdout).failureKind, 'system-family-unavailable')
    assert.equal(owners[0], owners[1], 'native fallback replaced logical budget owner')
    assert.equal(h.state.requests[0].fontPath, ''); assert.equal(h.state.requests[1].fontPath, privateFont)
    assert(jobs.every(job => job.closed)); assert.equal(live.size, 0)
    assert.equal(digest(privateFont), before)
    // Real native input validation and output I/O failures are not the typed
    // selection-exhaustion receipt, even though they also exit with code 2.
    for (const request of [
      { fontPath: '', preferSystemFont: true, systemFontFamilyCandidates: [], outputPath: path.join(directory, 'invalid.png') },
      { fontPath: privateFont, outputPath: directory },
    ]) {
      await assert.rejects(client.runRustPreviewRenderImage({ text: 'Ag', fontSize: 44, width: 720, height: 260, ...request }), error => error.sharedIo === true && error.reason === 'process-exit' && !error.previewRenderFailure)
    }
  } finally {
    transport?.stopRustCoreDaemon()
    for (const child of live) child.kill()
    if (pool) await pool.whenIdle()
    assert.equal(digest(original), before, 'immutable CI font source was modified')
    await fsp.rm(directory, { recursive: true, force: true })
  }
}
if (require.main === module) {
  // Keep a hung controlled case alive long enough to fail instead of exiting 0.
  const watchdog = setTimeout(() => { console.error('Preview fallback diagnostic did not settle within 120s'); process.exit(1) }, 120000)
  main().catch(error => { console.error(error); process.exitCode = 1 }).finally(() => clearTimeout(watchdog))
}
module.exports = { main }
