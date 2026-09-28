const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), cp = require('node:child_process')
const { promisify } = require('node:util')
const { DatabaseSync } = require('node:sqlite')
const { loader } = require('../check-operation-chain.cjs')
const { createHarness, root, entry } = require('../helpers/mainCompositionHarness.cjs')
const execFile = promisify(cp.execFile)
async function createRuntime({ directory, baseline, appendLog, electron, traceContext }) {
  fs.mkdirSync(directory, { recursive: true })
  const load = loader({ ...(traceContext ? { [path.join(root, 'src/main/logging/operationTraceContext.ts')]: traceContext } : {}), electron, '../security/ipcSenderValidation': { assertTrustedIpcSender() {} } })
  const raw = new DatabaseSync(path.join(directory, 'preview.sqlite'))
  const db = { prepare: sql => raw.prepare(sql), exec: sql => raw.exec(sql), transaction: fn => () => {
    raw.exec('BEGIN'); try { const result = fn(); raw.exec('COMMIT'); return result } catch (e) { raw.exec('ROLLBACK'); throw e }
  } }
  const cache = load('src/main/preview/previewCacheRuntime.ts')
  cache.initializePreviewDbSchema(db, { schemaVersion: 1, ensureSqliteColumn() {}, setSqliteMeta() {} })
  const config = new DatabaseSync(':memory:')
  config.exec('CREATE TABLE app_state(key TEXT,value TEXT); CREATE TABLE folders(path TEXT,sort_order INTEGER); CREATE TABLE folder_nodes(json TEXT,sort_order INTEGER); CREATE TABLE collections(json TEXT,sort_order INTEGER); CREATE TABLE tags(name TEXT,sort_order INTEGER)')
  // A registered shared root affects library totals even for unrelated local fonts.
  config.prepare('INSERT INTO folders VALUES (?,0)').run('\\\\fixture-unavailable\\fonts')
  const persistence = load('src/main/library/runtime/libraryPersistenceRuntime.ts')
  let counts = 0, native = 0
  const library = load('src/main/library/runtime/libraryLoadRuntime.ts').createLibraryLoadRuntime({
    openLibraryDb: async () => config, countSharedFontsForFolders: async () => { counts++; await new Promise(resolve => setTimeout(resolve, 400)); return 4068 }, appendStartupLog: appendLog,
  })
  const file = path.join(root, 'src/main/bootstrap/mainDataCompositionRuntime.ts')
  const source = fs.readFileSync(file, 'utf8'), anchor = 'loadLibraryShell: async () => loadLibraryShellFromSqlite(await openLibraryDb()),'
  assert(source.includes(anchor))
  const h = createHarness(baseline ? new Map([[file, source.replace(anchor, 'loadLibraryShell,')]]) : undefined)
  const module = h.load(path.join(root, 'src/main/library/libraryRuntime.ts')), original = module.createLibraryRuntime
  module.createLibraryRuntime = options => Object.assign(original(options), { openLibraryDb: async () => config,
    loadLibraryShell: library.loadLibraryShell, loadLibraryShellFromSqlite: persistence.loadLibraryShellFromSqlite })
  h.load(entry)
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
  const runtime = load('src/main/preview/previewRuntime.ts').createPreviewRuntime(options)
  return { runtime, load, counts: () => counts, native: () => native, close() { raw.close(); config.close() } }
}
module.exports = { createRuntime }
