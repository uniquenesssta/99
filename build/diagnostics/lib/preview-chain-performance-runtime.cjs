const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), cp = require('node:child_process')
const { promisify } = require('node:util')
const { DatabaseSync } = require('node:sqlite')
const { loader } = require('../check-operation-chain.cjs')
const { createHarness, root, entry } = require('../helpers/mainCompositionHarness.cjs')
const execFile = promisify(cp.execFile)
async function createRuntime({ directory, baseline, appendLog, electron, traceContext, sourceRoot = root, controlled = false, observer, fixture }) {
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
      fs.writeFileSync(input, JSON.stringify(request))
      try {
        await execFile(path.join(root, 'native-src/hfm-core-worker/target/release/hfm-core-worker.exe'), ['--preview-render-image', '--input', input], { timeout: 15000 })
        return { ok: true, engine: 'rust-directwrite', outputPath: request.outputPath }
      } finally { fs.unlinkSync(input) }
    },
  }
  let transport
  if (controlled) {
    assert.equal(baseline, false, 'F13 never uses the historical transformed before')
    assert(fixture && observer, 'controlled mode needs the same selected-source fixture owner')
    options.withGlobalIo = fixture.withGlobalIo
    transport = load('src/main/rust-core/rustCoreWorkerTransportRuntime.ts').createRustCoreWorkerTransportRuntime({ enabled:true,required:true,appendStartupLog:appendLog })
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
  return { runtime, load, counts: () => counts, native: () => native, async close() { transport?.stopRustCoreDaemon(); if (controlled) { await load('src/main/path/sharedIoProcessRuntime.ts').applicationSharedIoProcessRuntime().whenIdle(); const end=Date.now()+5000; while(observer.children.size && Date.now()<end) await new Promise(resolve=>setTimeout(resolve,10));assert.equal(observer.children.size,0,'preview transport child leaked') } raw.close(); config.close() } }
}
module.exports = { createRuntime }
