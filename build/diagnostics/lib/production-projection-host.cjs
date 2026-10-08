#!/usr/bin/env node
'use strict'
// Proposed Windows-only reusable production host. Static preparation only.
// This adapter never substitutes merged queries, metrics, projection, status
// migration or installation-state algorithms. Call close() once per host.
// Run hosts sequentially: native transport and environment are process-owned.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { createRequire } = require('node:module')
const { pathToFileURL } = require('node:url')
const { EventEmitter } = require('node:events')
const plain = value => JSON.parse(JSON.stringify(value))
const tick = () => new Promise(resolve => setImmediate(resolve))
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex')
const forbidden = name => (..._args) => { throw new Error(`Forbidden diagnostic port: ${name}`) }

// The immutable baseline predates the extracted production reader. Read its
// exact callback from that checkout, preserving its original all-or-nothing
// behavior. This is explicitly an AST-selected source adapter, not a fake read.
function exactLegacyReadBoundary({ sourceRoot, requireProject, dependencies }) {
  const ts = requireProject('typescript')
  const file = path.join(sourceRoot, 'src/main/bootstrap/mainDataStorageCompositionRuntime.ts')
  const source = fs.readFileSync(file, 'utf8')
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  assert.equal(tree.parseDiagnostics.length, 0, 'Cannot parse immutable storage boundary')
  const matches = []
  function visit(node) {
    if (ts.isPropertyAssignment(node) && node.name.getText(tree).replace(/^['"]|['"]$/g, '') === 'readInstallStatusIndexInWorker') matches.push(node.initializer)
    ts.forEachChild(node, visit)
  }
  visit(tree)
  assert.equal(matches.length, 1, 'Expected exactly one production installation-read callback')
  assert(ts.isArrowFunction(matches[0]) && matches[0].modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword),
    'Baseline adapter only accepts the original async arrow-function boundary')
  const expression = matches[0].getText(tree)
  assert(expression.includes('migrateInstallStatusIdentity') && expression.includes('runRustInstallStatusRead'),
    'Baseline callback lost migration or native read')
  const output = ts.transpileModule(`module.exports = (${expression});`, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText
  const module = { exports: {} }
  const names = Object.keys(dependencies)
  new Function('module', ...names, output)(module, ...names.map(name => dependencies[name]))
  assert.equal(typeof module.exports, 'function')
  return { read: module.exports, provenance: {
    mode: 'exact-baseline-async-callback-source-adapter', path: 'src/main/bootstrap/mainDataStorageCompositionRuntime.ts',
    moduleSha256: sha256(source), callbackSha256: sha256(expression),
  } }
}

// Read-only locks ensure this harness exercises the same central writer and
// ownership flag the application's actual composition exports and forwards.
function assertProductionWriterWiring(sourceRoot, requireProject) {
  const ts = requireProject('typescript')
  const records = []
  function source(relative) {
    const text = fs.readFileSync(path.join(sourceRoot, relative), 'utf8')
    const tree = ts.createSourceFile(relative, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    assert.equal(tree.parseDiagnostics.length, 0, `Cannot parse composition lock: ${relative}`)
    records.push({ path: relative, sha256: sha256(text) })
    return tree
  }
  function visit(tree, accept) {
    const result = []
    const walk = node => { if (accept(node)) result.push(node); ts.forEachChild(node, walk) }
    walk(tree)
    return result
  }
  const text = (node, tree) => node.getText(tree).replace(/\s+/g, '')
  function property(object, name) {
    return object.properties.find(node => node.name && node.name.getText().replace(/^['"]|['"]$/g, '') === name)
  }
  function value(object, name, tree) {
    const node = property(object, name)
    assert(node, `Missing production port: ${name}`)
    return ts.isShorthandPropertyAssignment(node) ? text(node.name, tree) : text(node.initializer, tree)
  }
  function call(tree, name) {
    const calls = visit(tree, node => ts.isCallExpression(node) && text(node.expression, tree) === name)
    assert.equal(calls.length, 1, `Expected one production call to ${name}`)
    assert(ts.isObjectLiteralExpression(calls[0].arguments[0]), `Expected explicit ${name} ports`)
    return calls[0].arguments[0]
  }
  const data = source('src/main/bootstrap/mainDataCompositionRuntime.ts')
  const owner = call(data, 'createInstallStatusProjectionWriteRuntime')
  assert.equal(value(owner, 'saveInstallStatusIndex', data), 'storage.saveInstallStatusIndex')
  assert.equal(value(owner, 'syncMergedIndexAfterInstallStatusRefresh', data), 'query.syncMergedIndexAfterInstallStatusRefresh')
  const exported = visit(data, node => ts.isPropertyAssignment(node) && node.name.getText(data) === 'storage'
    && ts.isObjectLiteralExpression(node.initializer) && property(node.initializer, 'installStatusProjectionOwnedByWriter'))
  assert.equal(exported.length, 1, 'Actual storage export must expose the central writer once')
  assert.equal(value(exported[0].initializer, 'saveInstallStatusIndex', data), 'installStatusWriter.saveInstallStatusIndex')
  assert.equal(value(exported[0].initializer, 'installStatusProjectionOwnedByWriter', data), 'installStatusWriter.installStatusProjectionOwnedByWriter')
  for (const [relative, name] of [
    ['src/main/bootstrap/mainOperationsCompositionRuntime.ts', 'createInstallStatusRefreshRuntime'],
    ['src/main/bootstrap/mainMutationCompositionRuntime.ts', 'createMainActivationInstallStatusSaveRuntime'],
  ]) {
    const tree = source(relative), ports = call(tree, name)
    assert.equal(value(ports, 'saveInstallStatusIndex', tree), 'saveInstallStatusIndex')
    assert.equal(value(ports, 'installStatusProjectionOwnedByWriter', tree), 'installStatusProjectionOwnedByWriter')
  }
  const activation = source('src/main/activation/mainActivationInstallStatusSaveRuntime.ts')
  const ports = call(activation, 'createActivationInstallStatusSaveQueue')
  assert.equal(value(ports, 'saveInstallStatusIndex', activation), 'options.saveInstallStatusIndex')
  assert.equal(value(ports, 'installStatusProjectionOwnedByWriter', activation), 'options.installStatusProjectionOwnedByWriter')
  return records
}

async function createHost(options) {
  assert.equal(process.platform, 'win32', 'Production host only executes on Windows')
  const sourceRoot = path.resolve(options.sourceRoot)
  const workerPath = path.resolve(options.workerPath)
  assert(fs.statSync(workerPath).isFile(), 'Build the version-matched Windows worker first')
  const requireProject = createRequire(path.join(sourceRoot, 'package.json'))
  const { DatabaseSync } = require('node:sqlite')
  const { loader } = require(path.join(sourceRoot, 'build/diagnostics/check-operation-chain.cjs'))
  const { createObserver } = require(path.join(sourceRoot, 'build/diagnostics/lib/operation-work-performance.cjs'))
  const directory = path.resolve(options.directory)
  const dataDirectory = path.join(directory, 'state')
  const fixtureDirectory = path.resolve(options.fixtureDirectory || directory)
  const roots = [...new Set((options.roots || options.fixture?.roots || options.fixture?.rootPaths || [path.join(fixtureDirectory, 'fonts')]).map(root => path.resolve(root)))]
  assert(roots.length > 0)
  for (const root of roots) {
    const rel = path.relative(fixtureDirectory, root)
    assert(rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel)), 'Font root escaped common private fixture')
    assert(fs.statSync(root).isDirectory(), 'Caller must materialize the fixed font roots before creating a host')
  }
  const fontRoot = roots[0]
  const rootDbByKey = new Map(roots.map(root => [path.resolve(root).toLowerCase(), path.join(directory, 'root-index', sha256(root.toLowerCase()).slice(0, 20) + '.sqlite')]))
  const rootDbForRoot = root => { const value = rootDbByKey.get(path.resolve(root).toLowerCase()); assert(value, 'Unknown fixture root'); return value }
  const rootCacheForRoot = root => path.dirname(rootDbForRoot(root))
  const rootCache = rootCacheForRoot(fontRoot)
  const rootDbPath = rootDbForRoot(fontRoot)
  const libraryPath = path.join(dataDirectory, 'library.sqlite')
  for (const value of [dataDirectory, ...[...rootDbByKey.values()].map(file => path.dirname(file))]) fs.mkdirSync(value, { recursive: true })
  const envKeys = ['HFM_RUST_CORE_WORKER', 'HFM_RUST_CORE_AUTOBUILD', 'HFM_NODE_DB_QUERY_FALLBACK', 'HFM_NODE_STATE_FALLBACK']
  const savedEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]))
  Object.assign(process.env, {
    HFM_RUST_CORE_WORKER: workerPath,
    HFM_RUST_CORE_AUTOBUILD: '0',
    HFM_NODE_DB_QUERY_FALLBACK: '0',
    HFM_NODE_STATE_FALLBACK: '0',
  })

  const observer = options.observe || options.observer || createObserver()
  const logs = []
  const appendStartupLog = message => { logs.push(String(message)); options.appendLog?.(String(message)) }
  const opened = new Set()
  const nativeReceipts = []
  let observationContextErrors = 0
  let observationSetupErrors = 0
  let observationReceiptErrors = 0
  const receiptDetail = read => { try { return read() } catch { observationReceiptErrors++; return undefined } }
  const observationContext = () => {
    try {
      const value = options.getObservationContext?.()
      return value ? { stage: String(value.stage || '').slice(0,32), lane: String(value.lane || '').slice(0,80),
        actionId: String(value.actionId || '').slice(0,160) } : undefined
    } catch { observationContextErrors++; return undefined }
  }
  const projectionEvents = []
  const sqlCounters = {
    projectionSelectCalls: 0, projectionExaminedRows: 0,
    projectionUpdateCalls: 0, projectionIndexedUpdateCalls: 0,
    projectionUpdatedRows: 0, projectionIdentityUdfCalls: 0, identityUdfCalls: 0,
  }
  let projectionUpdateDepth = 0
  let transport, watcher, queue, query, libraryDb, cleanupRenderer, snapshotRuntime, snapshotOwner, foregroundShutdown
  let closed = false
  let initialized = false
  let rootOnline = true
  let eventListener

  function insideTemporary(file) {
    const relative = path.relative(directory, path.resolve(file))
    assert(relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative)),
      'Diagnostic database escaped its private temporary directory')
  }
  // API adapter only: all statements and transactions execute against real SQLite.
  function openDb(file) {
    insideTemporary(file)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const raw = new DatabaseSync(file)
    raw.exec('PRAGMA busy_timeout=5000;')
    let closed = false
    const db = {
      exec: sql => raw.exec(sql),
      prepare: sql => {
        const statement = raw.prepare(sql)
        const normalized = String(sql).replace(/\s+/g, ' ').trim()
        const mapping = /^SELECT root_path\s*,\s*relative_path\s*,\s*file_size\s*,\s*modified_at FROM entries\b/i.test(normalized)
        const projectionUpdate = /^UPDATE entries SET installed\s*=/i.test(normalized)
        const where = normalized.match(/\bWHERE\b(.*)$/i)?.[1] || ''
        const indexed = /\broot_path\s*=\s*\?/i.test(where) && /\brelative_path\s*=\s*\?/i.test(where)
        return new Proxy(statement, { get(target, name) {
          const member = Reflect.get(target, name, target)
          if (typeof member !== 'function') return member
          if (mapping && (name === 'all' || name === 'get')) return (...args) => {
            sqlCounters.projectionSelectCalls++
            const value = member.apply(target, args)
            sqlCounters.projectionExaminedRows += Array.isArray(value) ? value.length : value ? 1 : 0
            return value
          }
          if (projectionUpdate && name === 'run') return (...args) => {
            sqlCounters.projectionUpdateCalls++
            if (indexed) sqlCounters.projectionIndexedUpdateCalls++
            projectionUpdateDepth++
            try {
              const result = member.apply(target, args)
              sqlCounters.projectionUpdatedRows += Number(result.changes || 0)
              return result
            } finally { projectionUpdateDepth-- }
          }
          return member.bind(target)
        } })
      },
      function: (...args) => {
        if (String(args[0]).toLowerCase() === 'hfm_file_font_id') {
          const at = args.length - 1, original = args[at]
          assert.equal(typeof original, 'function')
          const counted = function (...values) {
            sqlCounters.identityUdfCalls++
            if (projectionUpdateDepth) sqlCounters.projectionIdentityUdfCalls++
            return original(...values)
          }
          // node:sqlite derives SQL arity from function.length; instrumentation
          // must not turn the four-argument identity function into a zero-arg UDF.
          Object.defineProperty(counted, 'length', { value: original.length })
          args[at] = counted
        }
        return raw.function(...args)
      },
      transaction: fn => (...args) => {
        raw.exec('BEGIN IMMEDIATE')
        try { const result = fn(...args); raw.exec('COMMIT'); return result }
        catch (error) { raw.exec('ROLLBACK'); throw error }
      },
      close: () => { if (!closed) { closed = true; raw.close(); opened.delete(db) } },
      get open() { return !closed },
      get isOpen() { return !closed },
    }
    opened.add(db)
    return db
  }
  const exists = async file => {
    if (!rootOnline && [...rootDbByKey.values()].some(value => path.resolve(file) === path.resolve(value))) return false
    return fs.existsSync(file)
  }
  const dataPath = (...parts) => path.join(dataDirectory, ...parts)
  const closeSqliteDb = db => db.close()
  const ipcHandlers = new Map()
  const electron = {
    ipcMain: { handle: (channel, handler) => { assert(!ipcHandlers.has(channel), `Duplicate IPC registration: ${channel}`); ipcHandlers.set(channel, handler) } },
    app: { isPackaged: false, getAppPath: () => sourceRoot, getPath: name => name === 'temp' ? directory : dataDirectory },
    BrowserWindow: { getAllWindows: () => [{ isDestroyed: () => false, webContents: {
      send(channel, payload) {
        assert.equal(channel, 'font-index:changed')
        projectionEvents.push(plain(payload))
        eventListener?.(payload)
      },
    } }] },
  }
  const helper = path.join(sourceRoot, 'src/main/preview/native-renderer/directwrite/directWritePreviewHelperPathRuntime.ts')
  const load = loader({
    electron,
    fontkit: requireProject('fontkit'),
    'node:fs': observer.fs,
    'node:child_process': { ...observer.childProcess, spawnSync: forbidden('automatic native build / synchronous OS command') },
    [path.join(sourceRoot, 'src/main/install/fontMutationProcessRuntime.ts')]: {
      createFontMutationSession: forbidden('real Windows font/registry mutation'),
    },
  }, { setImmediate, clearImmediate }, {
    [helper]: source => source.replaceAll('import.meta.url', JSON.stringify(pathToFileURL(helper).href)),
  }, sourceRoot)

  try {
    try { options.onLoaderReady?.(load) } catch { observationSetupErrors++ }
    const sqlite = load('src/main/db/sqliteHelpers.ts')
    const config = load('src/main/app/appRuntimeConfig.ts')
    const fonts = load('src/main/fonts/fontRuntime.ts')
    const cached = fonts.createCachedFontRuntime({ sharedFontId: forbidden('legacy shared ID authority') })
    const paths = load('src/main/path/cachePath.ts')
    const key = paths.normalizePathForCacheCompare
    const fontIdentity = load('src/main/fonts/fontFileIdentity.ts')
    libraryDb = openDb(libraryPath)
    load('src/main/library/runtime/librarySchemaRuntime.ts').initializeLibraryDb(libraryDb)
    snapshotRuntime = load('src/main/library/tagFontSnapshotRuntime.ts')
    snapshotOwner = snapshotRuntime.openTagFontSnapshots(libraryDb)
    for (const [index, root] of roots.entries()) libraryDb.prepare('INSERT INTO folders(path, sort_order) VALUES (?, ?)').run(root, index)
    libraryDb.prepare('INSERT OR REPLACE INTO meta(key,value) VALUES (?,?)').run('localFavoritesMigrated', '1')
    const openLibraryDb = async () => libraryDb
    const appWatchedFolders = async () => [...roots]

    transport = load('src/main/rust-core/rustCoreWorkerTransportRuntime.ts').createRustCoreWorkerTransportRuntime({
      enabled: true, required: true, appendStartupLog,
    })
    const diagnosis = await transport.diagnoseRustCoreWorker()
    assert.equal(path.resolve(diagnosis.path), workerPath, 'Unexpected worker binary selected')
    const indexing = load('src/main/rust-core/clients/rustIndexingClientRuntime.ts').createRustIndexingClientRuntime({ ...transport, appendStartupLog })
    const metadata = load('src/main/rust-core/clients/rustMetadataClientRuntime.ts').createRustMetadataClientRuntime({ ...transport, appendStartupLog })
    const previewClient = load('src/main/rust-core/clients/rustPreviewClientRuntime.ts').createRustPreviewClientRuntime({ ...transport, appendStartupLog })
    const native = {
      invalidateRustCoreSchedulerCaches: transport.invalidateRustCoreSchedulerCaches,
      cancelRustCoreSchedulerScopes: transport.cancelRustCoreSchedulerScopes,
      noteRustCoreSchedulerInteractiveActivity: transport.noteRustCoreSchedulerInteractiveActivity,
    }
    for (const [owner, methods] of [[indexing, [
      'runRustMergedIndexPageQuery', 'runRustMergedIndexMetricsQuery', 'runRustMergedIndexIdsQuery',
      'runRustMergedIndexRebuild', 'runRustMergedIndexSync',
    ]], [metadata, ['runRustInstallStatusRead', 'runRustInstallStatusSave', 'runRustSharedMetadataOverlayRead', 'runRustInstallStatusCompare']]]) {
      for (const method of methods) native[method] = async input => {
        const startedAt = receiptDetail(() => performance.now()), context = observationContext()
        const inputCategory = receiptDetail(() => ({ sidebarPage: input.request?.sidebarPage, activeFilter: input.request?.activeFilter?.kind,
          requestSequence: input.request?.diagnosticRequestSequence, rootCount: input.roots?.length ?? input.sources?.length }))
        const result = await owner[method](input)
        assert(result, `Mandatory real native receipt missing: ${method}`)
        nativeReceipts.push({ method, startedAt, finishedAt: receiptDetail(() => performance.now()), context, inputCategory, result: plain(result) })
        return result
      }
    }

    let items = []
    const rootStorage = load('src/main/indexing/root-index/rootIndexDatabaseRuntime.ts').createRootIndexDatabaseRuntime({
      openStableSqliteDb: openDb, closeSqliteDb, exists, appendStartupLog,
      fontScanCacheVersion: config.FONT_SCAN_CACHE_VERSION, scriptDetectionVersion: config.SCRIPT_DETECTION_VERSION,
    })
    let status, readBoundary, readerProvenance
    status = load('src/main/install/installStatusRuntime.ts').createInstallStatusRuntime({
      rootCacheDir: rootCacheForRoot, dataPath, cacheIdentityPath: () => dataPath('identity.json'),
      ensureCacheIdentity: async () => {
        if (!fs.existsSync(dataPath('identity.json'))) fs.writeFileSync(dataPath('identity.json'), JSON.stringify({ cacheId: 'production-projection-fixture' }))
      },
      appWatchedFolders,
      findBestWatchedRootForFile: load('src/main/path/fontPathPolicy.ts').findBestWatchedRootForFile,
      openStableSqliteDb: openDb, closeSqliteDb, ...sqlite, exists,
      sha1: fonts.sha1, normalizePathForCacheCompare: key,
      isCleanWindowsDefaultCompareResult: () => false,
      completeBackgroundTask: async () => {}, appendStartupLog,
      readInstallStatusIndexInWorker: groups => readBoundary(groups),
      saveInstallStatusIndexInWorker: native.runRustInstallStatusSave,
    })
    const extractedReaderPath = path.join(sourceRoot, 'src/main/install/status/installStatusWorkerReadRuntime.ts')
    if (fs.existsSync(extractedReaderPath)) {
      readBoundary = load('src/main/install/status/installStatusWorkerReadRuntime.ts').createInstallStatusWorkerReadRuntime({
        openLibraryDb, exists, openStableSqliteDb: openDb, closeSqliteDb,
        initializeMachineInstallDb: status.initializeMachineInstallDb,
        readRust: native.runRustInstallStatusRead,
        readWorker: forbidden('Node installation-read fallback'), appendStartupLog,
      })
      readerProvenance = { mode: 'production-extracted-reader', path: 'src/main/install/status/installStatusWorkerReadRuntime.ts',
        moduleSha256: sha256(fs.readFileSync(extractedReaderPath)) }
    } else {
      const baseline = exactLegacyReadBoundary({ sourceRoot, requireProject, dependencies: {
        openLibraryDb, exists, openStableSqliteDb: openDb, closeSqliteDb, appendStartupLog,
        installStatusRuntime: status,
        migrateInstallStatusIdentity: load('src/main/install/status/installStatusIdentityMigration.ts').migrateInstallStatusIdentity,
        rustCoreWorkerRuntime: native,
        dbQueryWorkerRuntime: { readInstallStatusIndex: forbidden('baseline Node read fallback') },
      } })
      readBoundary = baseline.read
      readerProvenance = baseline.provenance
    }
    const statusDb = await status.openFallbackInstallDb()
    const installPath = await status.fallbackInstallStatusDbPath()
    statusDb.close()

    const localTags = load('src/main/library/runtime/localFontTagNodePersistenceRuntime.ts').createLocalFontTagNodePersistenceRuntime(openLibraryDb)
    const favorites = load('src/main/library/runtime/localFontFavoritesRuntime.ts').createLocalFontFavoritesRuntime({
      openLibraryDb, loadLegacyLocalSnapshot: forbidden('unrequested historical import'), invalidate: () => query?.clearFontQueryCaches(), appendLog: appendStartupLog,
    })
    const protection = load('src/main/library/runtime/localFontProtectionRuntime.ts').createLocalFontProtectionRuntime({
      openLibraryDb, watchedFolders: appWatchedFolders, invalidate: () => query?.clearFontQueryCaches(),
    })
    const hydrateLocalTagsForFonts = async value => protection.hydrate(await favorites.hydrate(await localTags.hydrateLocalTagsForFonts(value)))
    async function loadSharedFontsForFolders(requestedRoots) {
      if (!rootOnline) throw new Error('Controlled root offline: persisted merged population must remain available')
      const result = []
      for (const root of requestedRoots) {
        const cache = await rootStorage.readRootIndexSqliteFile(rootDbForRoot(root), root, 'root')
        for (const [relative, entry] of Object.entries(cache.entries)) if (entry.status === 'ok' && entry.font) {
          result.push(cached.cachedFontForRuntime(entry.font, cached.cacheEntryRuntimePath(root, relative),
            { size: entry.fileSize, mtimeMs: entry.modifiedAt, birthtimeMs: entry.createdAt }, relative))
        }
      }
      return result
    }
    const rendererState = { pageSeq: { current: 0 }, metricsSeq: { current: 0 }, token: 0, refreshes: 0, metrics: null }
    const effects = []
    const rendererEnvironmentPorts = {
      [path.join(sourceRoot, 'src/renderer/src/constants/environmentConstants.ts')]: {
        RENDERER_ENV: { DEV: false, PROD: true }, IS_DEVELOPMENT: false,
      },
    }
    const rendererBase = loader(rendererEnvironmentPorts, {}, {}, sourceRoot)
    const rendererLoad = loader({
      ...rendererEnvironmentPorts,
      react: { useRef: current => ({ current }), useEffect: effect => effects.push(effect) },
      '../../../appRuntime': rendererBase('src/renderer/src/library-normalize/libraryIndexChangeRuntime.ts'),
    }, {}, {}, sourceRoot)
    const derived = rendererLoad('src/renderer/src/databaseDerivedStateRuntime.ts')
    rendererLoad('src/renderer/src/runtime/app/effects/useFontIndexChangedEventRuntime.ts').useFontIndexChangedEventRuntime({
      hfm: { onFontIndexChanged: callback => { eventListener = callback; return () => { eventListener = undefined } } },
      refreshDatabaseDerivedState: () => {
        rendererState.refreshes++
        derived.refreshDatabaseDerivedStateRuntime({
          timerRef: { current: null }, clearTimeout,
          databasePageRequestSeqRef: rendererState.pageSeq, fontMetricsRequestSeqRef: rendererState.metricsSeq,
          setDatabasePageResult: () => {}, setDatabaseQueryResult: () => {},
          setDatabaseFontMetrics: value => { rendererState.metrics = value },
          setDatabaseRefreshToken: update => { rendererState.token = update(rendererState.token) },
        })
      },
      getCurrentLibrary: () => ({ fonts: {}, folders: roots }),
      commitLibraryUpdate: forbidden('projection event fabricating library rows'),
      saveLibraryImmediately: forbidden('projection event saving shell'),
      loadCacheStats: forbidden('projection event rereading cache statistics'),
      captureFontScrollSnapshot: forbidden('projection event scrolling'),
      restoreFontScrollSnapshot: forbidden('projection event restoring scroll'),
      cleanupRemovedFontState: forbidden('projection event removing previews'), setStatus: () => {},
    })
    cleanupRenderer = effects[0]()
    watcher = load('src/main/watcher/folderWatcherRuntime.ts').createFolderWatcherRuntime({
      appendStartupLog, verboseLogs: false, startupGraceMs: 0, flushDebounceMs: 1,
      isIgnoredWatcherPath: () => false, closeRuntimeDatabases: () => {},
      watcherChangeBatchLooksUnchanged: forbidden('this diagnostic does not start watchers'),
      applyWatchedFolderChangesToIndex: forbidden('this diagnostic does not start scanning'),
    })
    const writerPath = path.join(sourceRoot, 'src/main/install/status/installStatusProjectionWriteRuntime.ts')
    const writerWiring = fs.existsSync(writerPath) ? assertProductionWriterWiring(sourceRoot, requireProject) : []
    const statusWriter = fs.existsSync(writerPath)
      ? load('src/main/install/status/installStatusProjectionWriteRuntime.ts').createInstallStatusProjectionWriteRuntime({
        saveInstallStatusIndex: status.saveInstallStatusIndex,
        syncMergedIndexAfterInstallStatusRefresh: (...args) => query.syncMergedIndexAfterInstallStatusRefresh(...args),
      })
      : { saveInstallStatusIndex: status.saveInstallStatusIndex, installStatusProjectionOwnedByWriter: false }
    queue = load('src/main/activation/mainActivationInstallStatusSaveRuntime.ts').createMainActivationInstallStatusSaveRuntime({
      readInstallStatusIndex: status.readInstallStatusIndex, saveInstallStatusIndex: statusWriter.saveInstallStatusIndex,
      installStatusProjectionOwnedByWriter: statusWriter.installStatusProjectionOwnedByWriter,
      appWatchedFolders, rootForFontPath: status.rootForFontPath,
      syncMergedIndexAfterInstallStatusRefresh: (...args) => query.syncMergedIndexAfterInstallStatusRefresh(...args),
      clearFontQueryCaches: () => query.clearFontQueryCaches(), appendStartupLog, batchDelayMs: 60000,
    })
    query = load('src/main/bootstrap/mainDataQueryCompositionRuntime.ts').createMainDataQueryCompositionRuntime({
      onSharedTagCountsChanged: revision => { watcher.sendFontIndexChanged({ folder: '', at: new Date().toISOString(),
        source: 'metrics', metricsRevision: revision, upserts: [], deletes: [] }); options.onSharedTagCountsChanged?.(revision) },
      onProjectionCommitted: revision => { watcher.sendFontIndexChanged({ folder: '', at: new Date().toISOString(),
        source: 'projection', projectionRevision: revision, upserts: [], deletes: [] }); options.onProjectionCommitted?.(revision) },
      applyPendingActivationState: queue.applyPendingActivationState,
      hasPendingActivationState: () => queue.hasPendingActivationInstallStatusSave() || queue.hasInFlightActivationInstallStatusSave(),
      appWatchedFolders, loadSharedFontsForFolders, loadSharedFontsForFoldersFresh: loadSharedFontsForFolders,
      hydrateLocalTagsForFonts,
      hydrateLocalFavoritesForFonts: async value => protection.hydrate(await favorites.hydrate(value)),
      isSystemInstalledRecord: () => false, isPathInWindowsFonts: () => false, appendStartupLog,
      tagMetadataRevisionBarrier: load('src/main/library/tagMetadataRevisionBarrierRuntime.ts').createTagMetadataRevisionBarrierRuntime({ appendStartupLog }),
      rustCoreWorkerRuntime: native,
      migrationDiagnosticsRuntime: { record: value => appendStartupLog(`diagnostic migration: ${JSON.stringify(value)}`) },
      dataPath, exists, openStableSqliteDb: openDb,
      openRootIndexDb: (...args) => {
        if (!rootOnline) throw new Error('Controlled root unavailable')
        return rootStorage.openRootIndexDb(...args)
      },
      closeSqliteDb, installStatusDbPathForRoot: status.installStatusDbPathForRoot,
      cacheKeyForRootFile: paths.relativePathForRoot,
      dbQueryWorkerRuntime: new Proxy({}, { get: (_target, property) => forbidden(`Node query fallback: ${String(property)}`) }),
      librarySqlitePath: () => libraryPath, openLibraryDb,
      applySharedMetadataToMergedRows: forbidden('Node merged-row fallback'),
      sharedMetadataSignatureForRoot: async () => 'metadata:none',
      delayToEventLoop: tick, rootCacheDir: rootCacheForRoot, rootIndexDbPath: rootDbForRoot,
      resolveActiveRootIndexDbPath: async (_cache, defaultPath) => defaultPath,
      openMachineInstallDbForRoot: status.openMachineInstallDbForRoot,
      sqliteRowToScanEntry: load('src/main/indexing/root-index/rootIndexSqliteRuntime.ts').sqliteRowToScanEntry,
      cachedFontForRuntime: cached.cachedFontForRuntime, cacheEntryRuntimePath: cached.cacheEntryRuntimePath,
      getInstallStatusIndexSnapshot: status.getInstallStatusIndexSnapshot,
      loadLibraryShellFromSqlite: load('src/main/library/runtime/libraryPersistenceRuntime.ts').loadLibraryShellFromSqlite,
      saveMetricsSnapshot: async (name, value) => {
        libraryDb.exec('CREATE TABLE IF NOT EXISTS diagnostic_metrics(name TEXT PRIMARY KEY,json TEXT NOT NULL)')
        libraryDb.prepare('INSERT OR REPLACE INTO diagnostic_metrics VALUES (?,?)').run(name, JSON.stringify(value))
      },
      readInstallStatusIndex: status.readInstallStatusIndex,
    })


    let foreground
    async function createForegroundRuntime({ withGlobalIo, interaction }) {
      assert(!foreground, 'Configure the production foreground composition once per host')
      assert.equal(typeof withGlobalIo, 'function')
      const availability = load('src/main/path/startupPathAvailabilityRuntime.ts')
      for (const root of roots) assert(await availability.ensureStartupPathRootAvailable(root, appendStartupLog, 'foreground-fixture-bootstrap'), 'Foreground fixture root is unavailable')
      const constants = load('src/main/cache/constants.ts')
      const previewCache = load('src/main/preview/previewCacheRuntime.ts')
      const previewDb = openDb(dataPath('preview.sqlite'))
      const initializePreviewDb = db => previewCache.initializePreviewDbSchema(db, {
        schemaVersion: constants.PREVIEW_SQLITE_SCHEMA_VERSION, ...sqlite,
      })
      initializePreviewDb(previewDb)
      const tasksDb = openDb(dataPath('tasks.sqlite'))
      load('src/main/tasks/background-runtime/backgroundTaskSchemaRuntime.ts').initializeTasksDb({
        ...sqlite, taskSqliteSchemaVersion: constants.TASKS_SQLITE_SCHEMA_VERSION,
      }, tasksDb)
      const tasks = load('src/main/tasks/background-runtime/backgroundTaskStoreRuntime.ts').createBackgroundTaskStoreRuntime({ openTasksDb: async () => tasksDb })
      const resolver = load('src/main/windows/runtime/fontPathResolverRuntime.ts').createFontPathResolverRuntime({
        fontExtensions: new Set(['.ttf', '.otf', '.ttc', '.otc']), appendStartupLog,
        windowsFontsDir: () => fontRoot, currentUserFontsDir: () => fontRoot,
      })
      const authorization = load('src/main/path/fontPathAuthorizationRuntime.ts').createFontPathAuthorizationRuntime({
        readRoots: appWatchedFolders, watchedRoots: appWatchedFolders, appOwnedRoots: async () => [],
        fontExtensions: new Set(['.ttf', '.otf', '.ttc', '.otc']),
      })
      const rootPreviewCacheDir = root => path.join(directory, 'root-preview', sha256(key(root)).slice(0, 20))
      const rootPreviewImageDir = root => path.join(rootPreviewCacheDir(root), 'images')
      const rootPreviewDbPath = root => path.join(rootPreviewCacheDir(root), 'preview.sqlite')
      const routing = load('src/main/rust-core/rustSharedIoCommandRuntime.ts')
      for (const root of roots) {
        fs.mkdirSync(rootPreviewImageDir(root), { recursive: true })
        const sharedPreviewDb = openDb(rootPreviewDbPath(root))
        try { initializePreviewDb(sharedPreviewDb) } finally { closeSqliteDb(sharedPreviewDb) }
        // Case-private backing stores avoid cross-run cache reuse, while their
        // native shared-cache operations still enter the real isolated owner.
        routing.registerIsolatedRoot(rootPreviewCacheDir(root))
      }
      const manifest = load('src/main/cache/scan-storage/rootPreviewManifestRuntime.ts').createRootPreviewManifestRuntime({
        exists, sha1: fonts.sha1, appName: 'HFMFixture', appendStartupLog,
        previewSqliteSchemaVersion: constants.PREVIEW_SQLITE_SCHEMA_VERSION,
      })
      const hidden = load('src/main/cache/scan-storage/cacheWindowsHiddenRuntime.ts').createCacheWindowsHiddenRuntime({ appendStartupLog })
      const previewReceipts = []
      const preview = load('src/main/preview/previewRuntime.ts').createPreviewRuntime({
        ...tasks, ...previewClient, ...resolver, ...authorization, ...manifest, ...hidden,
        cacheKeyForRootFile: paths.relativePathForRoot, cacheKeyForPath: key,
        rootPreviewCacheDir, rootPreviewImageDir, rootPreviewDbPath,
        legacyRootPreviewCacheDir: rootPreviewCacheDir,
        localPreviewImageDir: () => dataPath('preview-images'), previewSqlitePath: () => dataPath('preview.sqlite'),
        sha1: fonts.sha1, appendStartupLog, openPreviewDb: async () => previewDb,
        openStableSqliteDb: openDb, initializePreviewDb, closeSqliteDb, normalizePathForCacheCompare: key,
        normalizePreviewCacheIndexStatus: previewCache.normalizePreviewCacheIndexStatus,
        upsertPreviewCacheRows: previewCache.upsertPreviewCacheRows,
        loadLibraryShell: async () => load('src/main/library/runtime/libraryPersistenceRuntime.ts').loadLibraryShellFromSqlite(await openLibraryDb()),
        ensureWindows: () => assert.equal(process.platform, 'win32'), previewTaskKey: key => `preview_cache:${key}`,
        execFileAsync: forbidden('preview renderer fallback'), withGlobalIo,
        missingFontPreviewDataUri: forbidden('missing preview substitution'),
        previewSqliteSchemaVersion: constants.PREVIEW_SQLITE_SCHEMA_VERSION,
        runRustPreviewRenderImage: async input => {
          const startedAt = receiptDetail(() => performance.now()), context = observationContext()
          const inputCategory = receiptDetail(() => ({ foregroundBytes: input.foregroundBytes === true, systemFont: input.preferSystemFont === true }))
          try {
            const result = await previewClient.runRustPreviewRenderImage(input)
            const observed = result && Object.fromEntries(Object.entries(result).map(([key, value]) => [key, Buffer.isBuffer(value)
              ? { diagnosticByteLength: value.length, diagnosticSha256: sha256(value) } : value]))
            previewReceipts.push({ input: plain(input), result: plain(observed), startedAt, finishedAt: receiptDetail(() => performance.now()), context, inputCategory })
            return result
          } catch (error) {
            receiptDetail(() => previewReceipts.push({ input: { fontPath: input.fontPath }, startedAt, finishedAt: performance.now(), context, inputCategory,
              error: { name: error?.name, code: error?.code, reason: error?.reason, message: String(error?.message || error).slice(0,512) } }))
            throw error
          }
        },
      })
      const runtime = {
        ...query, ...preview, ...interaction, appendLog: appendStartupLog,
        getSharedAvailability: load('src/main/path/sharedAvailabilityRuntime.ts').createSharedAvailabilityReader(openLibraryDb),
      }
      load('src/main/ipc/ipcHandlers.ts').registerIpcHandlers(runtime)
      // This is an Electron boundary adapter, not a sender-validation bypass.
      // Development security already trusts this exact renderer document.
      const rendererUrl = pathToFileURL(path.join(process.cwd(), 'out', 'renderer', 'index.html')).href
      assert(load('src/main/security/appSecurityRuntime.ts').isTrustedRendererUrl(rendererUrl), 'Synthetic renderer URL is not trusted by production policy')
      const allowed = new Set(['fonts:queryPage', 'fonts:getMetrics', 'fonts:cancelQuery', 'fonts:renderPreviewImage', 'fonts:ensurePreviewCache', 'performance:userActivity'])
      let nextSender = 0
      const renderers = new Set(), invocations = []
      function createRenderer() {
        const sender = new EventEmitter()
        sender.id = ++nextSender
        sender.isDestroyed = () => false
        sender.getURL = () => rendererUrl
        renderers.add(sender)
        return { sender, senderFrame: { url: rendererUrl } }
      }
      async function invoke(channel, args = [], event = createRenderer(), actionId) {
        assert(allowed.has(channel), `Unrequested diagnostic IPC: ${channel}`)
        const handler = ipcHandlers.get(channel)
        assert.equal(typeof handler, 'function', `Production IPC missing: ${channel}`)
        const row = { channel, actionId, sender: event.sender.id, startedAt: performance.now() }
        invocations.push(row)
        try { const value = await handler(event, ...args); row.ok = true; return value }
        catch (error) { row.ok = false; row.error = { name: error?.name, message: String(error?.message || error), reason: error?.reason }; throw error }
        finally { row.finishedAt = performance.now(); row.elapsedMs = row.finishedAt - row.startedAt }
      }
      foregroundShutdown = load('src/main/app/shutdownCoordinatorRuntime.ts').createShutdownCoordinator({
        log: appendStartupLog, closeRenderers: async () => true,
        freeze: () => { for (const sender of renderers) sender.emit('destroyed'); renderers.clear() },
        restore: forbidden('fixture shutdown restoration'), cleanup: async () => ({ remaining: 0 }), save: async () => {},
        confirmLoss: async () => false, drainLogs: async () => {}, terminate: () => {},
      })
      foreground = { preview, previewDb, tasksDb, previewReceipts, invocations, createRenderer, invoke,
        provenance: { mode: 'production-ipc-preview-composition', renderer: 'synthetic trusted Electron sender; no renderer paint or Electron serialization',
          preview: 'createPreviewRuntime: storage, source stat, local SQLite, native render and image commit',
          caches: 'Case-private initialized preview/task/shared-cache SQLite; isolated shared backing paths avoid cross-run image reuse; no injected latency',
          responseBoundary: 'Full production IPC response; deferred shared-cache publication is not forced into foreground response time' } }
      return foreground
    }


    const mergedPath = dataPath('db', 'merged-index.sqlite')
    async function initialize(nextItems, initialization = {}) {
      assert(!initialized, 'Initialize once per per-run database directory')
      initialized = true
      items = [...nextItems]
      const owner = item => load('src/main/path/fontPathPolicy.ts').findBestWatchedRootForFile(item.path, roots)
      for (const item of items) {
        assert.equal(fontIdentity.fileRuntimeFontId(item.path, item.fileSize, item.modifiedAt), item.id,
          'Only valid concrete identities belong in the indexed population')
        assert(owner(item), 'Indexed item is outside the private fixture roots')
      }
      for (const root of roots) {
        const db = await rootStorage.openRootIndexDb(rootDbForRoot(root), root, 'root')
        const entries = {}
        for (const item of items.filter(item => key(owner(item)) === key(root))) {
          const relative = path.relative(root, item.path).replaceAll('\\', '/')
          entries[relative] = { path: relative, cacheKey: `fixture:${relative}`, fileSize: item.fileSize,
            modifiedAt: item.modifiedAt, createdAt: item.createdAt, status: 'ok', font: item, cachedAt: '2026-10-06T00:00:00.000Z' }
        }
        rootStorage.writeFullRootIndexToOpenDb(db, { version: config.FONT_SCAN_CACHE_VERSION, entries })
        db.close()
      }
      const db = await status.openFallbackInstallDb()
      const insert = db.prepare('INSERT INTO install_status(font_id,signature,installed,by_type,matches_json,checked_at,system_default) VALUES(?,?,?,?,?,?,0)')
      db.transaction(() => {
        for (const [index, item] of items.entries()) insert.run(item.id, `content-v0:unproven-${index}`, index < 2 ? 1 : 0,
          index < 2 ? 'user' : 'none', '[]', '2026-01-01')
        for (let index = 0; index < (initialization.legacyRows ?? initialization.legacyCount ?? 94); index++)
          insert.run(`legacy-unresolved-${index}`, `old-name-only-${index}`, 1, 'user', '[]', '2025-01-01')
      })()
      db.close()
      if (initialization.oldProjection !== false && initialization.seedOldProjection !== false) {
        const prepared = await query.openMergedIndexDb(); closeSqliteDb(prepared)
        const old = openDb(mergedPath)
        old.prepare("DELETE FROM meta WHERE key='installEvidenceVersion'").run()
        const sources = roots.map(root => ({ root, indexDbPath: rootDbForRoot(root), installDbPath: installPath,
          indexSignature: 'old-index-fixture', installSignature: 'install-v2|legacy', sharedMetadataSignature: 'metadata:none' }))
        sqlite.setSqliteMeta(old, 'sourcesKey', JSON.stringify(sources))
        const sourceInsert = old.prepare('INSERT INTO sources(root_path,index_db_path,install_db_path,index_signature,install_signature,shared_metadata_signature,synced_at) VALUES(?,?,?,?,?,?,?)')
        for (const source of sources) sourceInsert.run(source.root, source.indexDbPath, installPath, source.indexSignature, source.installSignature, 'metadata:none', '2025-01-01')
        const rowInsert = old.prepare('INSERT INTO entries(root_path,relative_path,cache_key,file_size,modified_at,created_at,status,font_json,message,cached_at,is_deleted,installed,installed_by,matches_json,category_index,search_text) VALUES(?,?,?,?,?,?,?,?,?,?,0,?,?,?,?,?)')
        old.transaction(() => {
          for (const [index, item] of items.entries()) {
            const root = owner(item)
            rowInsert.run(root, path.relative(root, item.path).replaceAll('\\', '/'), `old:${index}`,
              item.fileSize, item.modifiedAt, item.createdAt || item.modifiedAt, 'ok', JSON.stringify(item), '', '2025-01-01',
              index < 2 ? 1 : 0, index < 2 ? 'user' : 'none', '[]', 'sansSerif', item.fileName)
          }
        })()
        assert.equal(old.prepare('SELECT COUNT(*) AS n FROM entries').get().n, items.length)
        old.close()
      }
      if (options.isolateRoots) {
        const availability = load('src/main/path/startupPathAvailabilityRuntime.ts')
        for (const root of roots) assert(await availability.ensureStartupPathRootAvailable(root, appendStartupLog, 'production-host-fixture'), 'Fixture root not available')
      }
      return { indexedPopulation: items.length, legacyRows: initialization.legacyRows ?? initialization.legacyCount ?? 94 }
    }
    return {
      load, status, statusWriter, writer: statusWriter, writerWiring, sqlCounters,
      query, native, indexing, metadata, previewClient, transport, config, fontIdentity,
      libraryDb, openDb, closeSqliteDb, readBoundary, readerProvenance,
      loadSharedFontsForFolders, rootStorage, observer, logs, appendLog: appendStartupLog, appendStartupLog,
      receipts: nativeReceipts, nativeReceipts, queue, projectionEvents, rendererState,
      get observationContextErrors() { return observationContextErrors },
      get observationSetupErrors() { return observationSetupErrors },
      get observationReceiptErrors() { return observationReceiptErrors },
      initialize, createForegroundRuntime, rootPaths: roots, roots, setRootOnline: value => { rootOnline = !!value },
      paths: { sourceRoot, workerPath, directory, fixtureDirectory, dataDirectory, libraryPath, mergedPath, installPath, rootDbForRoot, rootCacheForRoot },
      openLibraryDb, appWatchedFolders, exists, dataPath,
      close: closeHost, deliverRendererEvent: payload => eventListener?.(payload),
      get items() { return [...items] },
      // Intentionally injected invalid display metadata belongs in the runner's
      // explicit correctness-only wrapper, never in root SQL or native metrics.
    }
  } catch (error) {
    try { await closeHost() } catch (cleanupError) { error.cleanupError = String(cleanupError) }
    error.fixtureDirectory = directory
    error.diagnosticLogs = logs
    throw error
  }

  async function closeHost() {
    if (closed) return
    closed = true
    await query?.disposeSharedTagMetrics?.()
    if (foregroundShutdown) await foregroundShutdown.request()
    cleanupRenderer?.()
    watcher?.stopFolderWatchers()
    let captureCleanupError
    try {
      // Keep the existing owner reference before dispose removes it from the
      // module's WeakMap. Active capture must release physical work while its
      // transport and SQLite handle are still alive.
      if (snapshotRuntime?.disposeTagFontSnapshots) snapshotRuntime.disposeTagFontSnapshots(libraryDb)
      else snapshotOwner?.dispose?.()
      await snapshotOwner?.whenIdle?.()
    } catch (error) { captureCleanupError = error }
    transport?.stopRustCoreDaemon()
    const until = Date.now() + 5000
    while (observer.children.size && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 20))
    for (const db of [...opened]) db.close()
    for (const key of envKeys) {
      if (savedEnv[key] === undefined) delete process.env[key]
      else process.env[key] = savedEnv[key]
    }
    assert.equal(observer.children.size, 0, 'Native children remained after host cleanup')
    if (captureCleanupError) throw captureCleanupError
  }
}

module.exports = { createHost, exactLegacyReadBoundary, assertProductionWriterWiring }
