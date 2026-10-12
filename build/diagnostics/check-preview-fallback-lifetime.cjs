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
const installed = { ...font, systemInstalled: true, family: 'CONTROLLED_PRIVATE_FAMILY' }
const gate = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
const tick = () => new Promise(resolve => setImmediate(resolve))
const render = h => h.runtime.ensureFontPreviewImageFile(installed, 'controlled', 44, 720, 260, false, false, true)

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
      './directwrite/directWritePreviewHelperPathRuntime': { findDirectWritePreviewHelperPath: () => null },
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
      './directwrite/directWritePreviewHelperPathRuntime': { findDirectWritePreviewHelperPath: () => 'controlled-helper' },
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
  const children = [], requests = []
  const spawn = (_file, args) => {
    const child = new EventEmitter(); child.pid = 100 + children.length
    child.stdin = Object.assign(new EventEmitter(), { end() {} })
    child.stdout = Object.assign(new EventEmitter(), { setEncoding() {} })
    child.stderr = Object.assign(new EventEmitter(), { setEncoding() {} })
    child.stdio = [child.stdin, child.stdout, child.stderr, new EventEmitter()]
    child.kill = () => { child.killed = true; return true }
    child.finish = (code = 0) => { child.stdout.emit('data', '{}'); child.emit('close', code, null) }
    child.args = args; children.push(child); return child
  }
  const h = fixture({ mocks: { 'node:child_process': { ...cp, spawn } } })
  const transport = h.load('src/main/rust-core/rustCoreWorkerTransportRuntime.ts').createRustCoreWorkerTransportRuntime({ enabled: false, required: false, appendStartupLog() {} })
  const pool = h.load('src/main/path/sharedIoProcessRuntime.ts').applicationSharedIoProcessRuntime(), run = pool.run
  pool.run = request => { requests.push(request); return run(request) }
  const global = h.load('src/main/performance/globalIoRuntime.ts').createGlobalIoRuntime({ env: {}, localScanWorkers: 1, appendLog() {}, isIndexingActive: () => false, isUserActive: () => false, storageProfileForPath: () => ({ type: 'unknown' }) })
  h.options.withGlobalIo = global.withGlobalIo
  h.runtime = h.load('src/main/preview/previewRuntime.ts').createPreviewRuntime(h.options)
  const client = h.load('src/main/rust-core/clients/rustPreviewClientRuntime.ts').createRustPreviewClientRuntime({ ...transport, appendStartupLog() {}, diagnoseRustCoreWorker: async () => ({ available: true, path: process.execPath, capabilities: ['preview-render-image'] }) })
  h.state.render = request => client.runRustPreviewRenderImage(request)
  const until = async condition => { for (let n = 0; n < 200 && !condition(); n++) await tick(); assert(condition(), 'controlled transport did not reach expected state') }
  try {
    const blocker = pool.run({ file: process.execPath, args: ['controlled-blocker'], roots: ['configured-root:blocker'], write: true, priority: 'background', timeoutMs: 30000 })
    assert.equal(transport.hasRustCoreInteractiveWork(), false)
    const cancellation = new AbortController()
    const pending = h.filesystemPort.withSharedIoSignal(cancellation.signal, () => h.runtime.renderFontPreviewImage(installed, 'controlled')).catch(error => error)
    await until(() => pool.status().queued === 1)
    assert.equal(transport.hasRustCoreInteractiveWork(), true, 'real global→system-preview priority was lost while queued')
    const request = requests.find(value => value.label === 'preview-render-image')
    assert.equal(request.priority, 'foreground'); assert.equal(request.lane, 'default')
    assert(request.write && !request.accesses && request.roots.includes('configured-root:preview-output-unverified'), 'unknown alias writer barrier changed')
    children[0].finish(); await blocker; await until(() => children.length === 2)
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
        const attempt = transport.runRustCoreScheduledCommand(process.execPath, ['--preview-render-image', '--input', file.path], { timeout: 30000, sharedIo: { paths: ['', 'C:/controlled/preview.png'], write: true, preview: true } }).catch(error => error)
        await until(() => requests.length === 3)
        assert.equal(requests.at(-1).queueTimeoutMs, 600)
        const child = children.at(-1); child.stdout.emit('data', '{"ok":true}'); child.emit('close', 0, null)
        assert.equal(JSON.parse((await attempt).stdout).ok, true)
      })
      const outside = transport.runRustCoreScheduledCommand(process.execPath, ['--preview-render-image', '--input', file.path], { timeout: 30000, sharedIo: { paths: ['', 'C:/controlled/preview.png'], write: true, preview: true } })
      await until(() => requests.length === 4)
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
        const attempt = api.withPreviewRenderLifetime(() => transport.runRustCoreScheduledCommand(process.execPath, [sample.command || '--preview-render-image', '--input', input.path], {
          timeout: 30000, signal: abort.signal, sharedIo: { paths: ['\\\\controlled\\share'], write: true },
        })).catch(error => error)
        await until(() => children.length === previous + 1)
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
  } finally { transport.stopRustCoreDaemon(); for (const child of children) if (child.killed) child.emit('close', 1, null); await pool.whenIdle() }
}

async function main() {
  assert.equal(process.platform, 'win32', 'Preview fallback acceptance is Windows-only')
  await routeCases(); await compatibleChildCases(); await sharedProofBudgetCase(); await composedTransportCases(); await nativeMissingFamilyCase()
  console.log('PASS bounded preview fallback, shared owner retirement, closed-receipt rejection, reduced queue admission, alias barrier and composed foreground busy lifetime')
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
    const h = fixture({ cacheDirectory, mocks: {
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
      './directwrite/directWritePreviewHelperPathRuntime': { findDirectWritePreviewHelperPath: () => null },
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
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1 })
module.exports = { main }
