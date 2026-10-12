'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const electron = require('electron')
const { app, BrowserWindow, ipcMain } = electron
const { loader } = require('../check-operation-chain.cjs')
const [directory, html, indexPreload, runtimePreload] = process.argv.slice(2)
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(test, message) {
  const end = Date.now() + 10000
  while (!await test()) { assert(Date.now() < end, message); await pause(5) }
}
const request = { sidebarPage: 'library', activeFilter: { kind: 'all' }, limit: 1, offset: 0 }
const page = { queryKey: 'current', items: [{ id: 'current' }], total: 1, offset: 0, limit: 1, engine: 'sql', elapsedMs: 0 }
const metrics = { total: 1, installedCount: 1, notInstalledCount: 0 }
const report = { passed: false, platform: process.platform, versions: process.versions, bridges: [],
  scope: 'Real Electron invoke, production IPC registrar, consumer/task/cache owners and shipped preloads; controlled read/admission/physical-close gates, fixture renderer; no NAS or full App claim' }
const originalConsoleError = console.error
const electronErrors = []
console.error = (...args) => {
  if (String(args[0]).startsWith('Error occurred in handler for')) electronErrors.push(String(args[0]))
  else originalConsoleError(...args)
}
let win
const watchdog = setTimeout(() => { originalConsoleError('Font query Electron acceptance watchdog'); app.exit(1) }, 110000)

async function run() {
  assert.equal(process.platform, 'win32')
  process.env.ELECTRON_RENDERER_URL = pathToFileURL(html).href
  process.env.HFM_LOG_DETAIL = 'debug'
  await app.whenReady()
  const logs = [], traces = []
  const load = loader({ electron }, { Error })
  const io = load('src/main/path/sharedFileSystemRuntime.ts')
  const tasks = load('src/main/library/fontQueryTaskRuntime.ts')
  const failure = load('src/shared/fontQueryFailure.ts')
  const { SharedIoProcessError } = load('src/main/path/sharedIoProcessRuntime.ts')
  let read = async kind => kind === 'page' ? page : metrics
  let availability = async () => ({ roots: [], tags: [], unattributedTags: [] })
  const runtime = new Proxy({ appendLog: line => logs.push(line), getSharedAvailability: () => availability(),
    queryFontPageInLibrary: () => read('page'), getFontMetricsFromLibrary: () => read('metrics'),
    queryFontsInLibrary: () => read('ids'),
    loadLibrary: () => { throw Object.assign(Error('unrelated library failure'), { reason: 'query-superseded' }) },
    assertFeatureForChannel() {}, reportPerformanceEvent: payload => { traces.push(payload); return true },
  }, { get: (value, key) => key in value ? value[key] : () => undefined })
  load('src/main/ipc/ipcHandlers.ts').registerIpcHandlers(runtime)
  // Capture renderer receipts without changing any query handler or reply.
  ipcMain.removeHandler('performance:rendererTrace')
  ipcMain.handle('performance:rendererTrace', (_event, payload) => { traces.push(payload); return true })
  const call = (kind, token) => kind === 'page'
    ? `window.hfm.queryFontPage(${JSON.stringify(request)}, ${JSON.stringify(token)})`
    : `window.hfm.getFontMetrics(${JSON.stringify(token)})`
  const script = source => win.webContents.executeJavaScript(source)
  const observe = expression => `(${expression}).then(value => ({status:'ok',total:value.total}),error => ({status:'rejected',message:String(error.message)}))`
  const start = async (kind, token, slot) => script(`window[${JSON.stringify(slot)}]={status:'pending'}; ${observe(call(kind, token))}.then(value=>{window[${JSON.stringify(slot)}]=value}); true`)
  const result = async slot => { await until(() => script(`window[${JSON.stringify(slot)}]?.status !== 'pending'`), 'Renderer request did not settle'); return script(`window[${JSON.stringify(slot)}]`) }
  const cancelled = value => { assert.equal(value.status, 'rejected'); assert(value.message.includes(failure.FONT_QUERY_SUPERSEDED), 'Renderer lost cancellation marker') }
  async function flush() { await script('window.hfm.reportPerformanceEvent({kind:"diagnostic-flush"})') }
  function activeOwner(kind) {
    const entered = deferred(), closed = deferred()
    const state = { reads: 0, aborted: false, released: false }
    const physicalRead = async () => {
      state.reads++
      if (state.reads > 1) { assert(state.released, 'New physical read preceded old close'); return kind === 'page' ? page : metrics }
      const pending = deferred(), signal = io.currentSharedIoSignal()
      assert(signal, 'Read lost physical task cancellation context')
      signal.addEventListener('abort', () => {
        state.aborted = true
        const error = new SharedIoProcessError('controlled active child cancellation', 'unknown', 'cancelled')
        error.closed = closed.promise; pending.reject(error)
      }, { once: true })
      entered.resolve(); return pending.promise
    }
    const owner = kind === 'page'
      ? load('src/main/library/fontPageQueryCacheRuntime.ts').createFontPageQueryCacheRuntime({ pageCacheMax: 3, pageCacheTtlMs: 1000, appendStartupLog: line => logs.push(line), queryUncached: physicalRead })
      : load('src/main/library/fontMetricsRequestCoalescerRuntime.ts').createFontMetricsRequestCoalescerRuntime(1000)
    read = () => kind === 'page' ? owner.queryFontPageInLibrary(request) : owner.run({ key: 'fixture', load: physicalRead, appendLog: line => logs.push(line) })
    return { state, entered, release: () => { state.released = true; closed.resolve() } }
  }

  for (const [bridge, preload] of [['index', indexPreload], ['runtime', runtimePreload]]) {
    win = new BrowserWindow({ show: false, webPreferences: { preload, nodeIntegration: false, contextIsolation: true, sandbox: false, backgroundThrottling: false } })
    await win.loadFile(html)
    assert.equal(await script('typeof window.hfm?.queryFontPage'), 'function', 'Shipped preload did not expose hfm')
    const row = { bridge, cases: [] }; report.bridges.push(row)
    for (const kind of ['page', 'metrics']) {
      logs.length = 0; traces.length = 0
      const errorCount = electronErrors.length
      let admissions = 0, reads = 0
      const entered = deferred(), gate = deferred()
      availability = () => { if (++admissions === 1) { entered.resolve(); return gate.promise }; return Promise.resolve({ roots: [], tags: [], unattributedTags: [] }) }
      read = async () => {
        // Metrics has no shared-root admission. Hold its read before physical
        // work instead, within the real consumer signal owned by the registrar.
        if (kind === 'metrics' && ++admissions === 1) { entered.resolve(); await gate.promise; tasks.assertFontQueryActive() }
        reads++; return kind === 'page' ? page : metrics
      }
      await start(kind, 'before-start', 'old')
      await entered.promise
      assert.equal((await script(observe(call(kind, 'replacement')))).status, 'ok')
      gate.resolve({ roots: [], tags: [], unattributedTags: [] })
      cancelled(await result('old')); assert.equal(reads, 1, 'Retired admission started physical work')
      await flush()
      assert.equal(traces.filter(value => value.kind === 'ipc-renderer-cancelled').length, 1)
      assert.equal(electronErrors.length, errorCount, 'Expected cancellation reached Electron error logger')
      row.cases.push(kind + (kind === 'page' ? ':before-admission-overlap' : ':before-physical-overlap'))
      availability = async () => ({ roots: [], tags: [], unattributedTags: [] })

      traces.length = 0; logs.length = 0
      const active = activeOwner(kind)
      await start(kind, 'active', 'old'); await active.entered.promise
      await script('window.hfm.cancelFontQuery("active")')
      cancelled(await result('old')); assert(active.state.aborted); assert(!active.state.released)
      await start(kind, 'after-active', 'next')
      await until(() => logs.some(line => line.includes('joined in-flight')), 'Replacement did not join the retiring physical owner')
      assert.equal(active.state.reads, 1); assert.equal(await script('window.next.status'), 'pending')
      active.release()
      assert.equal((await result('next')).status, 'ok'); assert.equal(active.state.reads, 2)
      await flush()
      assert.equal(traces.filter(value => value.kind === 'ipc-renderer-cancelled').length, 1)
      assert.equal(electronErrors.length, errorCount)
      row.cases.push(kind + ':active-close-owner')

      logs.length = 0
      const navigation = activeOwner(kind)
      await start(kind, 'navigation', 'old'); await navigation.entered.promise
      await win.loadFile(html)
      await until(() => navigation.state.aborted && logs.some(line => line.includes('status=cancelled')), 'Real navigation did not retire old consumer')
      navigation.release()
      assert.equal((await script(observe(call(kind, 'after-navigation')))).status, 'ok')
      assert.equal(navigation.state.reads, 2); assert.equal(electronErrors.length, errorCount)
      row.cases.push(kind + ':real-navigation')

      for (const message of ['ordinary database failure', 'database query cancelled while parsing a stored value', 'database value contains ' + failure.FONT_QUERY_SUPERSEDED]) {
        logs.length = 0
        const before = electronErrors.length
        read = async () => { throw Error(message) }
        const value = await script(observe(call(kind, 'failure')))
        assert.equal(value.status, 'rejected'); assert(value.message.includes(message))
        assert.equal(electronErrors.length, before + 1, 'Genuine handler error lost Electron error log')
        assert(logs.some(line => line.includes('severity=error, status=failed')))
        assert(!logs.some(line => line.includes('status=cancelled')))
      }
      row.cases.push(kind + ':genuine-and-false-positive-errors')
    }
    const idsBefore = electronErrors.length
    read = async () => { throw Object.assign(Error('ID query generation superseded'), { reason: 'query-superseded' }) }
    cancelled(await script(observe('window.hfm.queryFonts({})')))
    assert.equal(electronErrors.length, idsBefore, 'Expected ID query cancellation reached Electron error logger')
    read = async () => { throw Error('ordinary ID query failure') }
    const idsError = await script(observe('window.hfm.queryFonts({})'))
    assert.equal(idsError.status, 'rejected'); assert(idsError.message.includes('ordinary ID query failure'))
    assert.equal(electronErrors.length, idsBefore + 1)
    row.cases.push('ids:cancelled-and-genuine-error')
    const before = electronErrors.length
    assert.equal((await script(observe('window.hfm.loadLibrary()'))).status, 'rejected')
    assert.equal(electronErrors.length, before + 1, 'Unrelated channel cancellation was transported as a success')
    row.cases.push('unrelated-channel-rejection')
    win.destroy(); win = undefined
  }
  report.passed = true
}

run().catch(error => { report.error = String(error.message || error); originalConsoleError(error); process.exitCode = 1 })
  .finally(() => {
    win?.destroy(); console.error = originalConsoleError; clearTimeout(watchdog)
    fs.writeFileSync(path.join(directory, 'report.json'), JSON.stringify(report, null, 2))
    app.exit(report.passed ? 0 : 1)
  })
