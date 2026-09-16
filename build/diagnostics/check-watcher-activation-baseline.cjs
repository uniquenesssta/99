#!/usr/bin/env node
// W-01: execute production functions; substitute only controlled external boundaries.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const crypto = require('node:crypto')
const ts = require('typescript')
const root = path.resolve(__dirname, '../..')
const watcherFile = 'src/main/watcher/folderWatcherRuntime.ts'
const actionFile = 'src/renderer/src/runtime/system/actions/fontActivationActionRuntime.ts'
const sessionFile = 'src/main/activation/runtime/fontActivationSessionRuntime.ts'
const backgroundFile = 'src/main/watcher/manual-refresh/manualFolderRefreshBackgroundRuntime.ts'
const fixtureFile = path.join(__dirname, 'fixtures/watcher-activation-baseline.fixture.json')
const plain = x => JSON.parse(JSON.stringify(x))
const read = file => fs.readFileSync(path.join(root, file), 'utf8')
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }
const drain = async () => { for (let i = 0; i < 20; i++) await Promise.resolve() }
function load(file, mocks = {}, globals = {}, transform = x => x) {
  const output = ts.transpileModule(transform(read(file)), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText
  const exports = {}
  vm.runInNewContext(output, { exports, console, process, ...globals, require(id) {
    if (Object.hasOwn(mocks, id)) return mocks[id]
    if (id === 'node:path') return path
    if (id.startsWith('.')) return load(path.relative(root, path.resolve(root, path.dirname(file), id + '.ts')), mocks, globals)
    throw Error(`Unexpected external dependency ${file}: ${id}`)
  } }, { filename: file })
  return exports
}
const noProcess = { execFileSync() { throw Error('Native process forbidden in baseline') } }
function watcherHarness({ availability = async () => true, stat = async () => ({ isDirectory: () => true }), watchError = () => null, onWatch = () => {}, transform = x => x } = {}) {
  let now = 10000, scan = false, closes = 0
  const timers = new Map(), handles = [], applied = [], sent = [], order = [], probes = [], logs = []
  class Clock extends Date { static now() { return now } }
  const cache = load('src/main/cache/cachePaths.ts', { 'node:child_process': noProcess })
  const options = { appendStartupLog: s => logs.push(s), verboseLogs: false, startupGraceMs: 100, flushDebounceMs: 10,
    isIgnoredWatcherPath: file => cache.isIgnoredWatcherPathWithExtensions(file, new Set(['.ttf', '.otf', '.ttc'])),
    closeRuntimeDatabases() { closes++ }, isScanActive: () => scan,
    watcherChangeBatchLooksUnchanged: async () => false,
    applyWatchedFolderChangesToIndex: async changes => { order.push('apply'); applied.push(plain(changes)); return { upserts: [{ id: 'a' }], deletes: [] } },
    syncMergedIndexForRootIncremental: async () => { order.push('sync') }
  }
  const runtime = load(watcherFile, {
    electron: { BrowserWindow: { getAllWindows: () => [{ isDestroyed: () => false, webContents: { send: (channel, payload) => { order.push('send'); sent.push({ channel, payload: plain(payload) }) } } }] } },
    'node:fs': { promises: { stat }, watch(folder, config, callback) { const error = watchError(folder); if (error) throw error; const events = new Map(); const h = { folder, config, callback, closed: 0, on(name, fn) { events.set(name, fn); return h }, emit(name, error) { events.get(name)?.(error) }, close() { h.closed++ } }; handles.push(h); onWatch(h); return h } },
    'node:child_process': noProcess,
    '../path/startupPathAvailabilityRuntime': { ensureStartupPathRootAvailable: async folder => { probes.push(folder); return availability(folder) } }
  }, { Date: Clock, setTimeout(fn, ms) { const token = { unref() {} }; timers.set(token, { fn, ms }); return token }, clearTimeout: token => timers.delete(token) }, transform).createFolderWatcherRuntime(options)
  return { runtime, options, handles, applied, sent, order, probes, logs, timers, closes: () => closes, advance: ms => { now += ms }, scanning: value => { scan = value },
    tick() { const [token, timer] = timers.entries().next().value; timers.delete(token); timer.fn(); return timer.ms }, live: () => handles.filter(h => !h.closed).map(h => h.folder) }
}
async function watcherHealthy(transform = x => x) {
  const h = watcherHarness({ transform }), folder = path.resolve('/fonts')
  assert.equal(await h.runtime.startWatchingFolders([folder, folder]), true)
  assert.equal(h.handles.length, 1)
  assert.equal(h.handles[0].config.recursive, process.platform === 'win32')
  h.handles[0].callback('rename', 'startup.ttf'); assert.equal(h.timers.size, 1)
  assert.equal([...h.timers.values()][0].ms, 100)
  h.advance(101)
  for (const file of ['cache.sqlite', 'note.txt', 'font.tmp']) h.handles[0].callback('change', file)
  assert.equal(h.timers.size, 1)
  h.handles[0].callback('rename', 'a.ttf'); h.handles[0].callback('rename', 'a.ttf')
  h.handles[0].callback('change', undefined)
  assert.equal(h.timers.size, 1)
  h.scanning(true); h.tick(); await drain(); assert.equal(h.applied.length, 0)
  assert.equal([...h.timers.values()][0].ms, 2500)
  h.scanning(false); h.tick(); await drain()
  assert.deepEqual(h.applied[0].map(x => [x.eventType, x.fileName]), [['rename', 'startup.ttf'], ['rename', 'a.ttf'], ['rescan', '.']])
  assert.deepEqual(h.order, ['apply', 'sync', 'send'])
  await h.runtime.startWatchingFolders([folder]); assert.equal(h.handles.length, 1)
  h.handles[0].callback('change', 'b.otf'); h.runtime.stopFolderWatchers()
  assert.equal(h.timers.size, 0); assert.equal(h.handles[0].closed, 1)
  await h.runtime.flushPendingFolderChanges(); assert.equal(h.applied.length, 1)
  await h.runtime.startWatchingFolders([folder]); assert.equal(h.handles.length, 2)
  await h.runtime.startWatchingFolders([]); assert.deepEqual(h.live(), [])
  assert.equal(h.handles[1].closed, 1)
}
async function watcherRecovery(transform = x => x) {
  const a = path.resolve('/A'), b = path.resolve('/B')
  // Availability and stat are separate suspension boundaries.
  for (const stage of ['availability', 'stat']) {
    for (const stop of [false, true]) {
      const gate = deferred()
      const h = watcherHarness({ transform, [stage]: folder => folder === a ? gate.promise : Promise.resolve(stage === 'stat' ? { isDirectory: () => true } : true) })
      const first = h.runtime.startWatchingFolders([a]); await drain()
      if (stop) h.runtime.stopFolderWatchers()
      else await h.runtime.startWatchingFolders([b])
      gate.resolve(stage === 'stat' ? { isDirectory: () => true } : true); await first
      assert.deepEqual(h.live(), stop ? [] : [b], `${stage}: obsolete start registered`)
      assert.equal(h.handles.length, stop ? 0 : 1, `${stage}: obsolete start reached fs.watch`)
      h.runtime.stopFolderWatchers()
    }
  }
  const registering = watcherHarness({ transform, onWatch: () => registering.runtime.stopFolderWatchers() })
  await registering.runtime.startWatchingFolders([a])
  assert.deepEqual(registering.live(), []); assert.equal(registering.handles[0].closed, 1)
  registering.advance(101); registering.handles[0].callback('rename', 'late.ttf')
  assert.equal(registering.timers.size, 0)
  // Repeated identical requests during startup leave only one live handle.
  const gates = [deferred(), deferred()]; let probes = 0
  const repeated = watcherHarness({ transform, availability: () => gates[probes++].promise })
  const first = repeated.runtime.startWatchingFolders([a]); await drain()
  const second = repeated.runtime.startWatchingFolders([a]); await drain()
  gates[1].resolve(true); gates[0].resolve(true); await Promise.all([first, second])
  assert.deepEqual(repeated.live(), [a]); repeated.runtime.stopFolderWatchers()
  // Partial failure, all unavailable, stat failure and watch registration failure retry on the same request.
  for (const mode of ['partial', 'offline', 'stat', 'watch']) {
    let recovered = false
    const h = watcherHarness({ transform,
      availability: async folder => recovered || (mode !== 'offline' && (mode !== 'partial' || folder === a)),
      stat: async () => { if (!recovered && mode === 'stat') throw Error('EACCES'); return { isDirectory: () => true } },
      watchError: () => !recovered && mode === 'watch' ? Error('watch refused') : null })
    await h.runtime.startWatchingFolders([a, b])
    assert.equal(h.live().length, mode === 'partial' ? 1 : 0)
    const old = [...h.handles]; recovered = true
    await h.runtime.startWatchingFolders([a, b]); assert.deepEqual(h.live(), [a, b])
    for (const handle of old) assert.equal(handle.closed, 1)
    const count = h.handles.length
    await h.runtime.startWatchingFolders([b, a]); assert.equal(h.handles.length, count)
    h.runtime.stopFolderWatchers(); assert(h.handles.every(x => x.closed === 1))
  }
  const h = watcherHarness({ transform })
  await h.runtime.startWatchingFolders([a]); h.advance(101)
  const old = h.handles[0]; old.emit('error', Error('lost root'))
  assert.equal(old.closed, 1)
  old.callback('rename', 'stale.ttf'); assert.equal(h.timers.size, 0)
  await h.runtime.startWatchingFolders([a]); assert.deepEqual(h.live(), [a]); h.advance(101)
  old.callback('rename', 'stale.ttf'); assert.equal(h.timers.size, 0)
  h.handles[1].callback('rename', 'fresh.ttf'); h.tick(); await drain()
  assert.deepEqual(h.applied[0].map(x => x.fileName), ['fresh.ttf'])
  const current = h.handles[1]; h.runtime.stopFolderWatchers()
  current.callback('rename', 'after-stop.ttf'); assert.equal(h.timers.size, 0)
  assert(h.handles.every(x => x.closed === 1))
}
async function observeW1() {
  const gate = deferred(), a = path.resolve('/A'), b = path.resolve('/B')
  const h = watcherHarness({ availability: folder => folder === a ? gate.promise : Promise.resolve(true) })
  const first = h.runtime.startWatchingFolders([a]); await drain()
  const second = await h.runtime.startWatchingFolders([b]); assert.deepEqual(h.live(), [b])
  gate.resolve(true); const firstResult = await first
  const result = { expected: [b], actual: h.live(), returns: [firstResult, second], handles: h.handles.map(x => ({ folder: x.folder, closed: x.closed })) }
  h.runtime.stopFolderWatchers(); return result
}
async function observeW2() {
  let available = false
  const h = watcherHarness({ availability: async () => available }), folder = path.resolve('/offline')
  const first = await h.runtime.startWatchingFolders([folder]); assert.equal(h.live().length, 0)
  available = true; const second = await h.runtime.startWatchingFolders([folder])
  const result = { expected: { handles: 1, probes: 2 }, actual: { handles: h.live().length, probes: h.probes.length }, returns: [first, second] }
  h.runtime.stopFolderWatchers(); return result
}
const font = { id: 'a', path: '/a.ttf', fileName: 'a.ttf', active: true, activeSince: '2026-01-01', managedInstallPath: '/managed/a.ttf', managedRegistryName: 'A', favorite: true, localTagNames: ['L'], tagNames: ['S'], deleteProtected: true }
function actionHarness(deactivateFont, transform = x => x, refresh = () => {}) {
  let refreshCount = 0
  let library = { fonts: { a: { ...font } } }, metrics = { activeCount: 1, favoriteCount: 1 }
  const messages = [], busy = new Set()
  const display = load('src/renderer/src/fontDisplay.ts')
  const options = { get library() { return library }, hfm: { deactivateFont }, activeOperationFontIds: { current: busy }, setStatus: s => messages.push(s),
    refreshDatabaseDerivedState: () => { refreshCount++; refresh() },
    setLibrary: update => { library = update(library) }, setDatabaseFontMetrics: update => { metrics = update(metrics) } }
  const state = load('src/renderer/src/runtime/system/actions/fontSystemStateRuntime.ts').createFontSystemStateRuntime(options)
  const runtime = load(actionFile, { '../../../appRuntime': display }, {}, transform).createFontActivationActionRuntime(options, state)
  return { runtime, busy, messages, refreshes: () => refreshCount, setMetrics: value => { metrics = value }, snapshot: () => plain({ font: library.fonts.a, metrics }) }
}
function sessionHarness(remove, config = {}, transform = x => x) {
  let saved = null
  const statuses = [], tails = []
  let records = config.records || [{ fontId: 'a', sourcePath: '/a.ttf', installPath: '/managed/a.ttf', registryName: 'A' }]
  const runtime = load(sessionFile, {}, {}, transform).createFontActivationSessionRuntime({ ensureWindows() {}, loadTemporaryActiveFonts: async () => ({ version: 1, records }), saveTemporaryActiveFonts: async state => { if (config.failSave) throw Error("save failed"); saved = plain(state); records = state.records }, scheduleBackgroundFontRefreshTail: (...args) => tails.push(args) },
    { saveActivationInstallStatus: async (...args) => statuses.push(plain(args)) }, { removeTemporaryActiveRecord: remove }, {})
  return { runtime, snapshot: () => ({ saved, statuses, tails }) }
}
async function mainDeactivationCheck(transform = x => x) {
  const a = { fontId: 'a', sourcePath: '/a.ttf', installPath: '/managed/one.ttf', registryName: 'one' }
  const b = { ...a, installPath: '/managed/two.ttf', registryName: 'two' }
  const other = { fontId: 'b', sourcePath: '/b.ttf', installPath: '/managed/b.ttf', registryName: 'B' }
  for (const mode of ['success', 'false', 'reject', 'partial']) {
    const attempts = []
    const h = sessionHarness(async record => { attempts.push(record.registryName); if (mode === 'reject') throw Error('cleanup rejected'); return mode === 'success' || (mode === 'partial' && record === a) }, { records: [a, b, other] }, transform)
    if (mode === 'reject') {
      await assert.rejects(() => h.runtime.deactivateFontSession(font), /cleanup rejected/)
      assert.equal(h.snapshot().saved, null); assert.equal(h.snapshot().statuses.length, 0)
      assert.deepEqual(attempts, ['one']); continue
    }
    const result = await h.runtime.deactivateFontSession(font)
    assert.equal(result.ok, mode === 'success', mode)
    assert.deepEqual(attempts, ['one', 'two'])
    assert.deepEqual(h.snapshot().saved.records.map(r => r.registryName), mode === 'success' ? ['B'] : mode === 'partial' ? ['two', 'B'] : ['one', 'two', 'B'])
    assert.equal(h.snapshot().statuses.length, mode === 'success' ? 1 : 0, 'must not clear status while a matching record remains')
    const again = await h.runtime.deactivateFontSession(font)
    assert.equal(again.ok, mode === 'success')
    if (mode === 'success') assert.equal(attempts.length, 2, 'idempotent no-record call')
  }
  const empty = sessionHarness(async () => { throw Error('must not clean unrelated records') }, { records: [other] }, transform)
  assert.equal((await empty.runtime.deactivateFontSession(font)).ok, true)
  assert.equal(empty.snapshot().saved, null); assert.equal(empty.snapshot().statuses.length, 0)
  const fail = sessionHarness(async () => true, { failSave: true }, transform)
  await assert.rejects(() => fail.runtime.deactivateFontSession(font), /save failed/)
  assert.equal(fail.snapshot().statuses.length, 0)
}
async function observeA1() {
  const gate = deferred(), h = actionHarness(() => gate.promise)
  const task = h.runtime.deactivateFontByCard(font)
  assert.equal(h.snapshot().metrics.activeCount, 0); assert(h.busy.has('a'))
  const response = { ok: false, message: 'injected cleanup refusal' }
  gate.resolve(response); await task
  return { expected: { active: true, activeCount: 1 }, actual: { active: h.snapshot().font.active, activeCount: h.snapshot().metrics.activeCount }, response, ui: h.snapshot(), busy: h.busy.size }
}
async function observeA2() {
  const gate = deferred(), session = sessionHarness(() => gate.promise)
  let response
  // Real IPC handler and main session -> controlled transport -> renderer action/state.
  const handlers = new Map()
  load('src/main/ipc/handlers/fontSystemIpcHandlers.ts').registerFontSystemIpcHandlers((name, handler) => handlers.set(name, handler), session.runtime)
  const h = actionHarness(async item => { response = await handlers.get('fonts:deactivateFont')({}, item); return response })
  const task = h.runtime.deactivateFontByCard(font); await drain(); assert.equal(session.snapshot().saved, null)
  gate.resolve(false); await task
  assert.equal(session.snapshot().saved.records.length, 1)
  return { expected: false, actual: response.ok, response, persistence: session.snapshot(), ui: h.snapshot() }
}
async function activationHealthy(transform = x => x) {
  const gate = deferred(), h = actionHarness(() => gate.promise, transform)
  const task = h.runtime.deactivateFontByCard(font)
  await h.runtime.deactivateFontByCard(font) // busy guard prevents another decrement
  assert.equal(h.snapshot().metrics.activeCount, 0)
  gate.reject(Error('injected')); await task
  assert.deepEqual(h.snapshot(), { font, metrics: { activeCount: 1, favoriteCount: 1 } })
  assert.equal(h.busy.size, 0)
  const session = sessionHarness(async () => true), success = actionHarness(item => session.runtime.deactivateFontSession(item))
  await success.runtime.deactivateFontByCard(font)
  assert.equal(session.snapshot().saved.records.length, 0)
  assert.equal(session.snapshot().statuses.length, 1)
  assert.equal(success.snapshot().font.active, false); assert.equal(success.snapshot().metrics.activeCount, 0)
  assert.equal(success.refreshes(), 1)
  for (const key of ['favorite', 'localTagNames', 'tagNames', 'deleteProtected']) assert.deepEqual(success.snapshot().font[key], font[key])
  const display = load('src/renderer/src/fontDisplay.ts')
  assert.equal(display.installLabel({ ...font, active: false, systemInstalled: true }), '系统已安装')
  assert.equal(display.installLabel(font), '已激活')
  const route = load('src/main/library/fontQueryWorkerRouteRuntime.ts')
  assert.equal(route.shouldUseMergedIndexWorkerForPage({ activeFilter: { kind: 'active' } }), false)
  assert.equal(route.shouldUseMergedIndexWorkerForPage({ activeFilter: { kind: 'all' } }), true)
}
async function rendererDeactivationCheck(transform = x => x) {
  for (const rejected of [false, true]) {
    let calls = 0
    const gate = deferred(), h = actionHarness(() => { calls++; return gate.promise }, transform)
    const task = h.runtime.deactivateFontByCard(font)
    await h.runtime.deactivateFontByCard(font)
    assert.equal(calls, 1); assert.equal(h.snapshot().metrics.activeCount, 0)
    if (rejected) gate.reject(Error('rejected'))
    else gate.resolve({ ok: false, message: 'not removed' })
    await task
    assert.deepEqual(h.snapshot(), { font, metrics: { activeCount: 1, favoriteCount: 1 } })
    assert.equal(h.busy.size, 0); assert.equal(h.refreshes(), 1)
  }
  const partial = sessionHarness(async record => record.registryName === 'one', { records: [
    { fontId: 'a', sourcePath: '/a.ttf', registryName: 'one' }, { fontId: 'a', sourcePath: '/a.ttf', registryName: 'two' }
  ] })
  const handlers = new Map()
  load('src/main/ipc/handlers/fontSystemIpcHandlers.ts').registerFontSystemIpcHandlers((name, fn) => handlers.set(name, fn), partial.runtime)
  const h = actionHarness(item => handlers.get('fonts:deactivateFont')({}, item), transform)
  await h.runtime.deactivateFontByCard(font)
  assert.deepEqual(h.snapshot(), { font, metrics: { activeCount: 1, favoriteCount: 1 } })
  assert.equal(partial.snapshot().saved.records.length, 1); assert.equal(partial.snapshot().statuses.length, 0)
}
async function metricsResponseOrderCheck(transform = x => x) {
  // Capture and run the actual metrics effect; remaining page hooks are outside this test.
  for (const oldFirst of [false, true]) {
    const seq = { current: 0 }, pageSeq = { current: 0 }, gate = deferred()
    let effects = [], timers = [], refreshToken = 0
    const stop = {}
    const hooks = { useState: () => [0, () => {}], useEffect: fn => effects.push(fn), useMemo: () => { throw stop } }
    const page = load('src/renderer/src/runtime/database/useRendererDatabasePageRuntime.ts', {
      react: hooks,
      '../../appRuntime': { normalizeFontMetricsResult: x => x, METRICS_IDLE_DELAY_MS: 0 },
      '../../fontViewRuntime': {}, './rendererDatabasePageWindowRuntime': {}
    }, { window: { setTimeout: fn => { timers.push(fn); return timers.length }, clearTimeout() {} }, performance: { now: () => 0 } })
    const derived = load('src/renderer/src/databaseDerivedStateRuntime.ts')
    const h = actionHarness(() => gate.promise, transform, () => derived.refreshDatabaseDerivedStateRuntime({
      timerRef: { current: null }, clearTimeout() {}, setDatabasePageResult() {}, setDatabaseQueryResult() {},
      setDatabaseFontMetrics: value => h.setMetrics(value), setDatabaseRefreshToken: fn => { refreshToken = fn(refreshToken) },
      databasePageRequestSeqRef: pageSeq, fontMetricsRequestSeqRef: seq
    }))
    function request(response) {
      effects = []; timers = []
      try { page.useRendererDatabasePageRuntime({ virtualViewport: { width: 800, height: 600, scrollTop: 0 }, viewLayout: { rowHeight: 80, minCardWidth: 160 }, library: { folders: ['/fonts'] }, hfm: { getFontMetrics: () => response.promise },
        fontMetricsRequestSeqRef: seq, rendererUserActive: () => false, reportTrace() {}, setDatabaseFontMetrics: value => h.setMetrics(value) }) }
      catch (error) { assert.equal(error, stop) }
      assert.equal(effects.length, 1); effects[0](); assert.equal(timers.length, 1); timers[0]()
    }
    const old = deferred(); request(old)
    const action = h.runtime.deactivateFontByCard(font)
    if (oldFirst) { old.resolve({ activeCount: 7 }); await drain(); assert.equal(h.snapshot().metrics.activeCount, 7) }
    gate.resolve({ ok: false, message: 'keep active' }); await action
    assert.equal(h.snapshot().metrics.activeCount, oldFirst ? 8 : 1, 'refresh retains the settled snapshot until a newer result'); assert.equal(refreshToken, 1); assert.equal(pageSeq.current, 1)
    assert.equal(h.snapshot().font.active, true)
    const fresh = deferred(); request(fresh); fresh.resolve({ activeCount: 1 }); await drain()
    if (!oldFirst) { old.resolve({ activeCount: 0 }); await drain() }
    assert.equal(h.snapshot().metrics.activeCount, 1, 'old metric result overwrote settled state')
    assert.equal(h.refreshes(), 1)
  }
}
async function manualBackgroundHealthy(transform = x => x) {
  const logs = [], r = load(backgroundFile, {}, {}, transform).createManualFolderRefreshBackgroundRuntime({ appendStartupLog: s => logs.push(s) })
  const gate = deferred(); let runs = 0
  const first = r.scheduleRefresh('root', 'job1', async () => { runs++; await gate.promise })
  const second = r.scheduleRefresh('root', 'job2', async () => { runs++ })
  await drain(); assert.equal(runs, 1); assert.equal(first.scheduled, true); assert.equal(second.scheduled, false)
  assert.equal(second.jobId, 'job1')
  assert.equal(r.backgroundResult({ folder: '/fonts', rootPath: '/fonts', jobId: 'job1', elapsedMs: 0, message: 'pending' }).mode, 'background')
  gate.reject(Error('injected')); await drain(); assert.equal(r.activeRefresh('root'), null); assert.equal(logs.length, 1)
  r.scheduleRefresh('root', 'job3', async () => { runs++ }); await drain(); assert.equal(runs, 2)
}
function snapshot(file, source = read(file)) {
  source = source.replace(/\r\n/g, '\n')
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
  const exports = [], functions = []
  function visit(n) {
    if (ts.isFunctionDeclaration(n) && n.name) functions.push(n.name.text)
    if (n.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword) && n.name) exports.push(n.name.getText(ast))
    ts.forEachChild(n, visit)
  }
  visit(ast)
  return { exports, functions, sha256: crypto.createHash('sha256').update(source).digest('hex') }
}
function contracts() {
  for (const [file, expected] of Object.entries(JSON.parse(fs.readFileSync(fixtureFile)).files)) {
    assert.deepEqual(snapshot(file), expected, `W-01 baseline drift: ${file}; migrate evidence explicitly`)
    assert.deepEqual(snapshot(file, read(file).replace(/\r?\n/g, '\r\n')), expected)
  }
}
function mutate(source, before, after) { assert(source.includes(before), `mutation target missing: ${before}`); return source.replace(before, after) }
async function main() {
  if (process.argv.includes('--observe') || process.argv.includes('--probe')) {
    const cases = { 'F-A1': observeA1, 'F-A2': observeA2 }
    const selected = process.argv.find(x => x.startsWith('--case='))?.slice(7)
    if (selected) assert(cases[selected], `Unknown case ${selected}`)
    for (const [id, run] of Object.entries(cases)) {
      if (selected && selected !== id) continue
      const result = await run(); console.log(id, JSON.stringify(result))
      if (process.argv.includes('--probe')) assert.deepEqual(result.actual, result.expected, id)
      else assert.deepEqual(result.actual, result.expected, `${id} repaired correctness regression`)
    }
    return
  }
  await rendererDeactivationCheck()
  await assert.rejects(() => rendererDeactivationCheck(s => mutate(s, "if (!result.ok) throw new Error(result.message || '临时激活记录未能完成清理。')", '')), assert.AssertionError)
  await assert.rejects(() => metricsResponseOrderCheck(s => mutate(s, 'options.activeOperationFontIds.current.delete(font.id)\n      options.refreshDatabaseDerivedState()', 'options.activeOperationFontIds.current.delete(font.id)')), assert.AssertionError)
  await metricsResponseOrderCheck()
  const a1 = await observeA1(); assert.deepEqual(a1.actual, a1.expected, "F-A1")
  await mainDeactivationCheck()
  await assert.rejects(() => mainDeactivationCheck(s => mutate(s, 'ok: cleaned === targets.length,', 'ok: true,')), assert.AssertionError)
  await assert.rejects(() => mainDeactivationCheck(s => mutate(s, 'if (cleaned === targets.length) {', 'if (cleaned > 0) {')), assert.AssertionError)
  const a2 = await observeA2(); assert.equal(a2.actual, a2.expected, "F-A2")
  assert.equal(a2.ui.font.active, true); assert.equal(a2.ui.metrics.activeCount, 1)
  const w1 = await observeW1(), w2 = await observeW2()
  assert.deepEqual(w1.actual, w1.expected, 'F-W1')
  assert.deepEqual(w2.actual, w2.expected, 'F-W2')
  await watcherRecovery()
  await assert.rejects(() => watcherRecovery(s => mutate(s, 'if (nextSignature === currentFolderWatchSignature && folderWatchersHealthy)', 'if (nextSignature === currentFolderWatchSignature)')), assert.AssertionError)
  await assert.rejects(() => watcherRecovery(s => s.replaceAll('if (generation !== watcherGeneration) return true;', '')), assert.AssertionError)
  await assert.rejects(() => watcherRecovery(s => s.replaceAll('if (generation !== watcherGeneration || !listening) return;', '')), assert.AssertionError)
  contracts(); await watcherHealthy(); await activationHealthy(); await manualBackgroundHealthy()
  await assert.rejects(() => watcherHealthy(s => mutate(s, 'if (options.isScanActive?.()) {', 'if (false) {')), assert.AssertionError)
  await assert.rejects(() => activationHealthy(s => mutate(s, 'stateRuntime.adjustDatabaseActiveCount(1)\n      }\n      options.setStatus(`取消激活失败', 'stateRuntime.adjustDatabaseActiveCount(0)\n      }\n      options.setStatus(`取消激活失败')), assert.AssertionError)
  await assert.rejects(() => manualBackgroundHealthy(s => mutate(s, 'if (active) return active;', 'if (false) return active;')), assert.AssertionError)
  console.log('[diagnostics:watcher-activation-baseline] LF/CRLF contracts, watcher filtering/grace/dedup/scan pause/resume/stop, activation success/reject rollback, manual refresh coalescing/recovery; W-02 startup generations, same-root recovery, stale callbacks; 10 mutations rejected; A-01 main/renderer correctness and metrics ordering')
}
main().catch(e => { console.error(e); process.exitCode = 1 })
