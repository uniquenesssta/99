const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), cp = require('node:child_process')
const { promisify } = require('node:util')
const { DatabaseSync } = require('node:sqlite')
const { loader } = require('../check-operation-chain.cjs')
const { createHarness, root, entry } = require('../helpers/mainCompositionHarness.cjs')
const execFile = promisify(cp.execFile)
// A controlled fixture is one application lifetime, even when its cache DBs
// and preview-memory owners are reopened between cold/disk/memory cohorts.
function createControlledPreviewTransportOwner({ load, observer, appendLog }) {
  const transport = load('src/main/rust-core/rustCoreWorkerTransportRuntime.ts').createRustCoreWorkerTransportRuntime({ enabled: true, required: true, appendStartupLog: appendLog })
  const pool = load('src/main/path/sharedIoProcessRuntime.ts').applicationSharedIoProcessRuntime()
  let closing
  const assertOpen = () => assert(!closing && !pool.status().closed, 'cache phase terminally stopped the fixture transport')
  async function waitForChildren(exempt = new Set()) {
    const outstanding = () => [...observer.children].filter(child => !exempt.has(child))
    const end = Date.now() + 5000
    while (outstanding().length && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal(outstanding().length, 0, 'preview transport child leaked')
  }
  async function drain() {
    assertOpen()
    await pool.whenIdle()
    // The JS pending map can empty before cancelled native work actually ends.
    // Demand a new native status object after polling, including every live
    // lane/write-barrier counter, before exempting a resident daemon from reap.
    const previousState = transport.rustCoreDaemonStatus().rustState
    const end = Date.now() + 5000
    let exempt = new Set()
    while (true) {
      const status = transport.rustCoreDaemonStatus(), state = status.rustState
      if (!status.running && status.pending === 0) break
      const idle = state && state !== previousState && state.queued === 0
        && (state.running === null || (Array.isArray(state.running) && state.running.length === 0))
        && Array.isArray(state.queuedJobs) && state.queuedJobs.length === 0
        && Array.isArray(state.lanes) && state.lanes.every(lane => lane.queued === 0 && lane.running === 0)
        && state.writeBarrier?.queuedWrites === 0 && state.writeBarrier?.runningWrites === 0
      if (status.pending === 0 && idle) {
        const worker = transport.rustCoreWorkerStatus()?.path
        const daemonChildren = [...observer.children].filter(child => typeof worker === 'string'
          && child.spawnargs?.length === 2 && child.spawnargs[1] === '--core-daemon'
          && path.win32.normalize(child.spawnargs[0]).toLowerCase() === path.win32.normalize(worker).toLowerCase())
        assert(daemonChildren.length <= 1, 'multiple selected-worker daemons remain at phase close')
        if (daemonChildren.length === 1) { exempt = new Set(daemonChildren); break }
      }
      assert(Date.now() < end, 'fresh native daemon idle receipt missing at cache-phase close')
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    await waitForChildren(exempt)
    assertOpen()
  }
  function close() {
    if (!closing) closing = (async () => {
      transport.stopRustCoreDaemon()
      await pool.whenIdle()
      await waitForChildren()
      assert.equal(pool.status().closed, true, 'terminal fixture close did not stop the pool')
      const processes = observer.counts.processes
      // F14 can finish application shutdown before releasing this owner. The
      // selected source's shutdown guard precedes the transport-stopped guard.
      // Observe that exact guard; never turn an arbitrary rejection into proof.
      let shutdownBlocker
      try { load('src/main/app/shutdownCoordinatorRuntime.ts').assertLocalShutdownWorkAllowed() }
      catch (error) { shutdownBlocker = error }
      await assert.rejects(transport.runRustCoreScheduledCommand(transport.rustCoreWorkerStatus()?.path || process.execPath, ['--preview-render-image'], { timeout: 1000 }), error => shutdownBlocker
        ? error?.name === shutdownBlocker.name && error?.message === shutdownBlocker.message
        : error?.reason === 'stopping' && error?.outcome === 'not-started')
      assert.equal(observer.counts.processes, processes, 'stopped fixture transport spawned new work')
      assert.equal(observer.children.size, 0)
    })()
    return closing
  }
  return { transport, assertOpen, drain, close }
}
function createPreviewPhaseCloser({ transportOwner, borrowed, closeDatabases }) {
  let closing
  return () => {
    if (!closing) closing = (async () => {
      try {
        if (transportOwner) {
          if (!borrowed) await transportOwner.close()
          else await transportOwner.drain()
        }
      } finally { closeDatabases() }
    })()
    return closing
  }
}
async function createRuntime({ directory, baseline, appendLog, electron, traceContext, sourceRoot = root, controlled = false, observer, fixture, transportOwner }) {
  const root = path.resolve(sourceRoot)
  fs.mkdirSync(directory, { recursive: true })
  const helperPath = path.join(root, 'src/main/preview/native-renderer/directwrite/directWritePreviewHelperPathRuntime.ts')
  const transforms = { [helperPath]: source => source.replaceAll('import.meta.url', JSON.stringify(require('node:url').pathToFileURL(helperPath).href)) }
  const load = fixture?.load || loader({ ...(traceContext ? { [path.join(root, 'src/main/logging/operationTraceContext.ts')]: traceContext } : {}), electron, '../security/ipcSenderValidation': { assertTrustedIpcSender() {} } }, {setImmediate,clearImmediate}, transforms, root)
  const raw = new DatabaseSync(path.join(directory, 'preview.sqlite'))
  const db = { prepare: sql => raw.prepare(sql), exec: sql => raw.exec(sql), transaction: fn => () => {
    raw.exec('BEGIN'); try { const result = fn(); raw.exec('COMMIT'); return result } catch (e) { raw.exec('ROLLBACK'); throw e }
  } }
  const cache = load('src/main/preview/previewCacheRuntime.ts')
  cache.initializePreviewDbSchema(db, { schemaVersion: 1, ensureSqliteColumn() {}, setSqliteMeta() {} })
  const config = new DatabaseSync(':memory:')
  config.exec('CREATE TABLE app_state(key TEXT,value TEXT); CREATE TABLE folders(path TEXT,sort_order INTEGER); CREATE TABLE folder_nodes(json TEXT,sort_order INTEGER); CREATE TABLE collections(json TEXT,sort_order INTEGER); CREATE TABLE tags(name TEXT,sort_order INTEGER)')
  // A registered shared root affects library totals even for unrelated local fonts.
  if (!controlled) config.prepare('INSERT INTO folders VALUES (?,0)').run('\\\\fixture-unavailable\\fonts')
  const persistence = load('src/main/library/runtime/libraryPersistenceRuntime.ts')
  let counts = 0, native = 0
  const library = load('src/main/library/runtime/libraryLoadRuntime.ts').createLibraryLoadRuntime({
    openLibraryDb: async () => config, countSharedFontsForFolders: async () => { if(controlled)throw Error('F13 cannot execute synthetic historical counter'); counts++; await new Promise(resolve => setTimeout(resolve, 400)); return 4068 }, appendStartupLog: appendLog,
  })
  const file = path.join(root, 'src/main/bootstrap/mainDataCompositionRuntime.ts')
  const source = fs.readFileSync(file, 'utf8'), anchor = 'loadLibraryShell: async () => loadLibraryShellFromSqlite(await openLibraryDb()),'
  assert(source.includes(anchor))
  const h = createHarness(baseline ? new Map([[file, source.replace(anchor, 'loadLibraryShell,')]]) : undefined, root)
  const module = h.load(path.join(root, 'src/main/library/libraryRuntime.ts')), original = module.createLibraryRuntime
  module.createLibraryRuntime = options => Object.assign(original(options), { openLibraryDb: async () => config,
    loadLibraryShell: library.loadLibraryShell, loadLibraryShellFromSqlite: persistence.loadLibraryShellFromSqlite })
  h.load(path.join(root, 'src/main/index.ts'))
  const sha1 = value => crypto.createHash('sha1').update(value).digest('hex'), noop = async () => {}
  const options = { ...h.options('createPreviewRuntime'), appendStartupLog: appendLog,
    localPreviewImageDir: () => path.join(directory, 'images'), previewSqlitePath: () => path.join(directory, 'preview.sqlite'), openPreviewDb: async () => db,
    sha1, cacheKeyForPath: value => value.toLowerCase(), normalizePathForCacheCompare: value => value.toLowerCase(),
    normalizePreviewCacheIndexStatus: cache.normalizePreviewCacheIndexStatus, upsertPreviewCacheRows: cache.upsertPreviewCacheRows,
    ensureWindows() { assert.equal(process.platform, 'win32') }, withGlobalIo: (_label, fn) => fn(),
    resolveExistingFontFilePath: async value => { await fs.promises.access(value); return value },
    completeBackgroundTask: noop, upsertBackgroundTask: noop, startBackgroundTask: noop, heartbeatBackgroundTask: noop, failBackgroundTask: noop,
    previewTaskKey: value => value, execFileAsync: execFile,
    runRustPreviewRenderImage: async request => {
      native++
      const input = request.outputPath + '.native.json'
      // This manual adapter returns a file; byte-return intent belongs only to
      // the production transport's capability-gated owned-stage command.
      const { foregroundBytes: _foregroundBytes, ...nativeInput } = request
      fs.writeFileSync(input, JSON.stringify(nativeInput))
      try {
        await execFile(path.join(root, 'native-src/hfm-core-worker/target/release/hfm-core-worker.exe'), ['--preview-render-image', '--input', input], { timeout: 15000 })
        return { ok: true, engine: 'rust-directwrite', outputPath: request.outputPath }
      } finally { fs.unlinkSync(input) }
    },
  }
  const borrowedTransport = !!transportOwner
  assert(!borrowedTransport || controlled, 'only controlled cache phases may borrow a fixture transport')
  let transport
  if (controlled) {
    assert.equal(baseline, false, 'F13 never uses the historical transformed before')
    assert(fixture && observer, 'controlled mode needs the same selected-source fixture owner')
    options.withGlobalIo = fixture.withGlobalIo
    transportOwner ||= createControlledPreviewTransportOwner({ load, observer, appendLog })
    transportOwner.assertOpen()
    transport = transportOwner.transport
    const rawReceipts = new Map()
    const clientTransport = fixture.observeNative ? { ...transport, runRustCoreScheduledCommand: async (...args) => {
      const result = await transport.runRustCoreScheduledCommand(...args)
      if (args[1]?.[0] === '--preview-render-image') {
        const receipt = JSON.parse(result.stdout.split(/\r?\n/).map(line=>line.trim()).find(Boolean))
        rawReceipts.set(receipt.outputPath, receipt)
      }
      return result
    } } : transport
    const client = load('src/main/rust-core/clients/rustPreviewClientRuntime.ts').createRustPreviewClientRuntime({ ...clientTransport,appendStartupLog:appendLog })
    await transport.diagnoseRustCoreWorker()
    options.runRustPreviewRenderImage = async request => { native++;observer.counts.nativeRenders++;const result=await client.runRustPreviewRenderImage(request);fixture.observeNative?.(request,result,rawReceipts.get(request.outputPath));rawReceipts.delete(request.outputPath);return result }
    options.authorizeFontRead = load('src/main/path/fontPathAuthorizationRuntime.ts').createFontPathAuthorizationRuntime({fontExtensions:new Set(['.ttf','.otf','.ttc','.otc']),readRoots:()=>Object.values(fixture.folders),watchedRoots:()=>Object.values(fixture.folders),appOwnedRoots:()=>[]}).authorizeFontRead
  }
  const runtime = load('src/main/preview/previewRuntime.ts').createPreviewRuntime(options)
  return { runtime, load, counts: () => counts, native: () => native,
    close: createPreviewPhaseCloser({ transportOwner, borrowed: borrowedTransport, closeDatabases() { raw.close(); config.close() } }) }
}
module.exports = { createRuntime, createControlledPreviewTransportOwner, createPreviewPhaseCloser }
