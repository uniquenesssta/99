#!/usr/bin/env node
'use strict'

// Windows integration regression: real files, isolated native directory receipts,
// SQLite snapshots/writes and the selected production worker-ready validation.
// This is bounded-work evidence on a private local fixture, not a NAS latency or
// Electron/UI benchmark. No font bytes, source names, host paths or raw logs are saved.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createRequire } = require('node:module')
const { createHost, productionHostGlobals } = require('./lib/production-projection-host.cjs')
const plain = value => JSON.parse(JSON.stringify(value))
const arg = (name, fallback) => { const at = process.argv.indexOf(name); return at < 0 ? fallback : process.argv[at + 1] }
const FILES = 169, DIRECTORIES = 169, METADATA_REQUESTS = 22

function redactDiagnostic(value, roots = []) {
  let text = String(value)
  for (const [root, label] of roots.filter(([root]) => typeof root === 'string' && root).sort((a, b) => b[0].length - a[0].length)) {
    for (const spelling of new Set([root, root.replaceAll('\\', '/')])) text = text.split(spelling).join(label)
  }
  return text.replace(/[A-Za-z]:[\\/][^\r\n,"'<>]*/g, '<redacted-path>')
    .replace(/\\\\[^\r\n,"'<>]+/g, '<redacted-path>').slice(0, 800)
}

function failureDiagnostics(host, state, error, roots) {
  const relevant = /^(?:local merged index (?:background validation|root signature|rebuilt)|merged index worker readiness|rust merged index (?:rebuild|page query)|root index (?:read failed|latest pointer resolve skipped|rust directory)|shared snapshot disposal failed)/
  const location = String(error?.stack || '').match(/check-watcher-noop-freshness\.cjs:(\d+):(\d+)/)
  return { phase: state.phase || 'fixture-setup', ownedSqliteSnapshots: state.ownedSqliteSnapshots || 0,
    assertionLocation: location ? { file: 'check-watcher-noop-freshness.cjs', line: Number(location[1]), column: Number(location[2]) } : undefined,
    watcherResult: state.lastWatcherResult,
    nativeReceipts: (host?.receipts || []).map(row => row.method).slice(-12),
    // Exact selected failure messages, with case/source/system paths removed.
    // Never emit the complete host log, SQL payloads, rows or child stdout.
    events: (host?.logs || error?.diagnosticLogs || []).filter(line => relevant.test(line)).slice(-12)
      .map(line => redactDiagnostic(line, roots)) }
}

// Fresh VM only for a selected owner or a fault control. Its imports are the
// already selected production host modules, never alternate filesystem/storage.
function selectedOwners(host, relatives, replacements = {}) {
  const sourceRoot = host.paths.sourceRoot
  const ts = createRequire(path.join(sourceRoot, 'package.json'))('typescript')
  const { loader } = require(path.join(sourceRoot, 'build/diagnostics/check-operation-chain.cjs'))
  const selected = new Set(relatives.map(file => path.join(sourceRoot, file)))
  const mocks = {}, transforms = {}
  for (const relative of relatives) {
    const absolute = path.join(sourceRoot, relative)
    const source = fs.readFileSync(absolute, 'utf8').replace(/\r\n/g, '\n')
    const tree = ts.createSourceFile(relative, source, ts.ScriptTarget.Latest, true)
    assert.equal(tree.parseDiagnostics.length, 0)
    for (const node of tree.statements) {
      if (!ts.isImportDeclaration(node) || node.importClause?.isTypeOnly) continue
      const name = node.moduleSpecifier.text
      if (!name.startsWith('.')) continue
      let target = path.resolve(path.dirname(absolute), name)
      if (!target.endsWith('.ts')) target += '.ts'
      if (!selected.has(target)) mocks[target] = host.load(path.relative(sourceRoot, target))
    }
    transforms[absolute] = () => {
      const replacement = replacements[relative]
      if (!replacement) return source
      const [before, after] = replacement
      assert.equal(source.split(before).length, 2, `Fault control anchor changed: ${relative}`)
      return source.replace(before, after)
    }
  }
  return loader(mocks, { ...productionHostGlobals(), setInterval, clearInterval }, transforms, sourceRoot)
}

// Execute the selected composition declaration, with actual folder/query
// owners. A fixture approximation here would hide publication-generation bugs.
function selectedStorageInvalidator(host, state) {
  const ts = createRequire(path.join(host.paths.sourceRoot, 'package.json'))('typescript')
  const relative = 'src/main/bootstrap/mainDataStorageCompositionRuntime.ts'
  const source = fs.readFileSync(path.join(host.paths.sourceRoot, relative), 'utf8')
  const tree = ts.createSourceFile(relative, source, ts.ScriptTarget.Latest, true)
  assert.equal(tree.parseDiagnostics.length, 0)
  const matches = []
  const visit = node => { if (ts.isFunctionDeclaration(node) && node.name?.text === 'invalidateSharedFontRuntimeCaches') matches.push(node); ts.forEachChild(node, visit) }
  visit(tree); assert.equal(matches.length, 1)
  const output = ts.transpileModule(`${matches[0].getText(tree)}\nreturn invalidateSharedFontRuntimeCaches;`, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText
  const invalidate = new Function('folderCacheRuntimeRef', 'clearFontQueryCaches', output)({
    invalidateSharedFontRuntimeCaches: (...args) => { state.sourceInvalidations++; host.folderCache.invalidateSharedFontRuntimeCaches(...args) },
  }, (...args) => { state.queryInvalidations++; return host.query.clearFontQueryCaches(...args) })
  return (...args) => { state.sourcePublicationModes.push(args[0] !== false); return invalidate(...args) }
}

function observeProduction(load, state) {
  const shared = load('src/main/path/sharedFileSystemRuntime.ts')
  const folderModule = load('src/main/folders/folderCacheRuntime.ts')
  const createFolder = folderModule.createFolderCacheRuntime
  folderModule.createFolderCacheRuntime = options => createFolder({ ...options,
    readRootIndexSqliteFile: async (...args) => {
      const observation = state.sourceRead, signal = shared.currentSharedIoSignal()
      const result = await options.readRootIndexSqliteFile(...args)
      return observation ? observation(result, signal) : result
    },
  })
  const pageCacheModule = load('src/main/library/fontPageQueryCacheRuntime.ts')
  const createPageCache = pageCacheModule.createFontPageQueryCacheRuntime
  pageCacheModule.createFontPageQueryCacheRuntime = options => createPageCache({ ...options,
    queryUncached: async (...args) => {
      const observation = state.foreground, signal = shared.currentSharedIoSignal()
      const result = await options.queryUncached(...args)
      return observation ? observation.page(result, signal) : result
    },
  })
  const facadeModule = load('src/main/library/fontQueryFacadeRuntime.ts')
  const createFacade = facadeModule.createFontQueryFacadeRuntime
  facadeModule.createFontQueryFacadeRuntime = options => createFacade({ ...options,
    rustCoreWorkerRuntime: { ...options.rustCoreWorkerRuntime,
      runRustMergedIndexIdsQuery: async (...args) => {
        const observation = state.foreground, signal = shared.currentSharedIoSignal()
        const result = await options.rustCoreWorkerRuntime.runRustMergedIndexIdsQuery(...args)
        return observation ? observation.ids(result, signal) : result
      },
    },
  })
  const configure = shared.configureSharedFileExecutor
  shared.configureSharedFileExecutor = execute => configure(async (...args) => {
    const request = args[0], stage = state.stage
    if (stage) {
      stage.operations[request.operation] = (stage.operations[request.operation] || 0) + 1
      if (request.operation === 'stat' && /\.ttf$/i.test(request.path)) stage.fontStats++
      if (['readFile', 'fontContentIdentity'].includes(request.operation) && /\.ttf$/i.test(request.path)) stage.fontReads++
    }
    let output
    try { output = await execute(...args) }
    catch (error) {
      // Failed native writes (including exclusive-open EEXIST) are classified
      // by the transport before a fulfilled executor receipt can reach us.
      // Observe that actual rejection and preserve its identity/close owner.
      state.observeNativeFailure?.(request, error)
      throw error
    }
    state.observeNative?.(request, output)
    if (request.operation === 'sqliteSnapshot' && output.result.ok) {
      assert.equal(typeof output.snapshotPath, 'string', 'Native SQLite snapshot path is missing')
      const relative = path.relative(state.nativeTempDirectory, output.snapshotPath)
      assert(relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative),
        'Native SQLite snapshot escaped the case-owned temporary directory')
      state.ownedSqliteSnapshots = (state.ownedSqliteSnapshots || 0) + 1
    }
    if (stage && ['directoryMetadata', 'directoryMetadataBatch'].includes(request.operation)) {
      assert.equal(output.result.ok, true, 'Actual native enumeration failed')
      const rows = request.operation === 'directoryMetadataBatch'
        ? output.result.value : [{ path: request.path, value: output.result.value }]
      assert(rows.length >= 1 && rows.length <= 8, 'Directory request exceeded the production sibling bound')
      stage.batchSizes.push(rows.length)
      for (const row of rows) {
        assert(!stage.directories.has(row.path), 'Directory enumerated twice in one walk')
        stage.directories.add(row.path)
        const current = fs.statSync(row.path)
        assert(current.isDirectory())
        assert(Math.abs(current.mtimeMs - row.value.stat.mtimeMs) < 1, 'Native directory time is not current')
        for (const entry of row.value.entries) if (entry.isFile && /\.ttf$/i.test(entry.name)) {
          const currentFile = fs.statSync(path.join(row.path, entry.name))
          assert.equal(entry.stat.size, currentFile.size, 'Native child size is not current')
          assert(Math.abs(entry.stat.mtimeMs - currentFile.mtimeMs) < 1, 'Native child time is not current')
          stage.nativeFileEvidence++
        }
      }
      // A fault is injected only after a real successful native receipt. The
      // production receipt validator must reject the incomplete final batch.
      if (state.incompleteReceipt && stage.directories.size === DIRECTORIES) {
        const value = plain(output.result.value)
        assert(Array.isArray(value) && value.length > 1)
        value.pop()
        return { ...output, result: { ...output.result, value } }
      }
    }
    return output
  })
  const syncModule = load('src/main/indexing/merged-page/mergedIndexSyncRuntime.ts')
  const createSync = syncModule.createMergedIndexSyncRuntime
  syncModule.createMergedIndexSyncRuntime = (...args) => {
    assert(!state.sync, 'Unexpected duplicate merged sync owner')
    state.sync = createSync(...args)
    return state.sync
  }
  const pageModule = load('src/main/indexing/merged-page/mergedIndexPageQueryRuntime.ts')
  const createPage = pageModule.createMergedIndexPageQueryRuntime
  pageModule.createMergedIndexPageQueryRuntime = (...args) => {
    assert(!state.page, 'Unexpected duplicate merged-page owner')
    state.context = args[0]
    state.page = createPage(...args)
    return state.page
  }
}

function installWriteAudit(db) {
  for (const key of ['directory', 'content', 'entry']) db.prepare('INSERT INTO meta(key,value) VALUES(?,?)').run(`diagnostic.${key}Writes`, '0')
  for (const operation of ['INSERT', 'UPDATE', 'DELETE']) {
    for (const [table, key] of [['directories', 'directory'], ['entries', 'entry']]) {
      db.exec(`CREATE TRIGGER diagnostic_${key}_${operation.toLowerCase()} AFTER ${operation} ON ${table}
        BEGIN UPDATE meta SET value=CAST(value AS INTEGER)+1 WHERE key='diagnostic.${key}Writes'; END;`)
    }
  }
  for (const operation of ['INSERT', 'UPDATE']) db.exec(`CREATE TRIGGER diagnostic_content_${operation.toLowerCase()} AFTER ${operation} ON meta
    WHEN NEW.key NOT LIKE 'diagnostic.%'
    BEGIN UPDATE meta SET value=CAST(value AS INTEGER)+1 WHERE key='diagnostic.contentWrites'; END;`)
}

function audit(host) {
  const db = host.openDb(host.paths.watcherActiveDb, { readonly: true })
  try {
    const meta = Object.fromEntries(db.prepare('SELECT key,value FROM meta ORDER BY key').all().map(row => [row.key, row.value]))
    return { meta, directories: plain(db.prepare('SELECT * FROM directories ORDER BY relative_path').all()),
      entries: plain(db.prepare('SELECT * FROM entries ORDER BY relative_path').all()),
      events: Number(db.prepare('SELECT COUNT(*) AS n FROM index_events').get().n),
      writes: Object.fromEntries(['directory','content','entry'].map(key => [key, Number(meta[`diagnostic.${key}Writes`])])) }
  } finally { db.close() }
}

function assertContentUntouched(before, after) {
  for (const key of ['updatedAt','last_update.entry_state_check','schemaVersion','schema_version','cacheVersion','index_version','index_opstamp'])
    assert.equal(after.meta[key], before.meta[key], `Directory bookkeeping changed content metadata: ${key}`)
  assert.deepEqual(after.entries, before.entries, 'Directory bookkeeping changed font entries')
  assert.equal(after.events, before.events, 'Directory bookkeeping emitted a font index event')
  assert.equal(after.writes.content, before.writes.content, 'No-op issued a content metadata write, even with the same value')
  assert.equal(after.writes.entry, before.writes.entry, 'No-op issued a font entry write')
  const contentMeta = meta => Object.fromEntries(Object.entries(meta).filter(([key]) => !key.startsWith('diagnostic.')))
  assert.deepEqual(contentMeta(after.meta), contentMeta(before.meta), 'Directory bookkeeping changed content metadata')
}

function assertBoundedWalk(stage, expectedFiles, cold) {
  assert.equal(stage.directories.size, DIRECTORIES, 'Full root walk omitted a directory')
  assert.equal(stage.nativeFileEvidence, expectedFiles, 'Every font needs current native stat evidence')
  assert.equal(stage.freshRows, expectedFiles, 'Watcher did not consume every fresh file receipt')
  assert.equal(stage.batchSizes.length, METADATA_REQUESTS, 'Directory batching regressed')
  assert.equal(stage.operations.directoryMetadata, 1)
  assert.equal(stage.operations.directoryMetadataBatch, 21)
  assert.equal(stage.operations.readdir || 0, 0, 'Watcher duplicated the authoritative enumeration')
  assert.equal(stage.operations.sqliteSnapshot || 0, 1, 'Entries and directory baselines must share one actual snapshot')
  assert.equal(stage.fontStats, 0, 'Watcher re-statted files already covered by the native receipt')
  assert.equal(stage.fontReads, 0, 'Unchanged fonts were reopened')
  assert.equal(stage.initializers, 0, 'Compatible watcher storage repeated cache initialization')
  assert.equal(stage.manifestWrites, 0, 'No-op watcher republished its manifest')
  assert(stage.processes > 0 && stage.processes <= (cold ? 48 : 36), 'No-op process starts exceeded the fixed work bound')
  assert.equal(stage.nativeApplies.length, cold ? 1 : 0, 'Redundant directory/native write')
  if (cold) assert.deepEqual(stage.nativeApplies[0], { upserts: 0, deletes: 0, directories: DIRECTORIES, applied: true })
  else for (const operation of ['mkdir','openFile','writeFile','writeOwnedFile','rename','removeOwnedFile'])
    assert.equal(stage.operations[operation] || 0, 0, `Unchanged watcher performed ${operation}`)
}

async function main() {
  assert.equal(process.platform, 'win32', 'Execute this regression only on Windows')
  const sourceRoot = path.resolve(arg('--source-root', process.cwd()))
  const workerPath = path.resolve(arg('--worker', process.env.HFM_TEST_NATIVE_WORKER || path.join(sourceRoot, 'build/native/hfm-core-worker.exe')))
  assert(fs.statSync(workerPath).isFile(), 'A version-matched Windows native worker is required')
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hfm-watcher-noop-'))
  const fontRoot = path.join(directory, 'fonts')
  fs.mkdirSync(fontRoot)
  const dirs = [fontRoot, ...Array.from({ length: DIRECTORIES - 1 }, (_, index) => path.join(fontRoot, `child-${String(index).padStart(3, '0')}`))]
  for (const dir of dirs.slice(1)) fs.mkdirSync(dir)
  const nativeTempDirectory = path.join(directory, 'native-temp')
  const savedTemp = Object.fromEntries(['TEMP', 'TMP'].map(key => [key, process.env[key]]))
  const redactions = [[directory, '<fixture>'], [sourceRoot, '<source-root>'], [os.tmpdir(), '<system-temp>'],
    [process.env.USERPROFILE, '<user-profile>'], [process.env.WINDIR, '<windows>']]
  const state = { nativeTempDirectory, ownedSqliteSnapshots: 0, phase: 'fixture-setup', sourceInvalidations: 0, queryInvalidations: 0, sourcePublicationModes: [] }, stages = [], controls = []
  let host, failure
  try {
    fs.mkdirSync(nativeTempDirectory)
    // The transport allocates snapshots with node:os.tmpdir(), not Electron's
    // app.getPath('temp'). Keep real allocations inside the host's existing
    // SQLite ownership boundary; never relax that host guard or copy snapshots.
    Object.assign(process.env, { TEMP: nativeTempDirectory, TMP: nativeTempDirectory })
    assert.equal(path.resolve(os.tmpdir()), path.resolve(nativeTempDirectory), 'Native temporary directory ownership was not configured')
    host = await createHost({ sourceRoot, workerPath, directory, fixtureDirectory: directory, roots: [fontRoot], isolateRoots: true,
      onLoaderReady: load => observeProduction(load, state) })
    assert.equal(host.observationSetupErrors, 0, 'Observation setup must not fail silently')
    assert(state.page && state.context, 'Missing actual merged-page owner')
    const { selectFonts } = require(path.join(sourceRoot, 'build/diagnostics/lib/operation-work-performance.cjs'))
    const manifest = selectFonts(path.join(directory, 'private-font-manifest'))
    const fonts = host.load('src/main/fonts/fontRuntime.ts')
    const cachePaths = host.load('src/main/cache/cachePaths.ts')
    // Match mainDataStorageCompositionRuntime: persisted cache IDs use this
    // production helper; cachedFontForRuntime restores canonical file-v2 IDs.
    // Unlike the read-only host, this fixture also exercises the sanitizer.
    const { sharedFontId } = cachePaths.createCachePathHelpers({ dataPath: host.dataPath, sha1: fonts.sha1, fontExtensions: new Set(['.ttf']) })
    const cached = fonts.createCachedFontRuntime({ sharedFontId })
    const paths = host.load('src/main/path/cachePath.ts')
    const constants = host.load('src/main/cache/constants.ts')
    const files = dirs.map(dir => path.join(dir, 'fixture.ttf'))
    const items = [], templates = []
    const copy = (source, target, time = '2026-01-01T00:00:00.000Z') => {
      fs.copyFileSync(source, target); fs.utimesSync(target, new Date(time), new Date(time))
    }
    for (const [index, file] of files.entries()) {
      copy(manifest[index % manifest.length].source, file)
      const stat = fs.statSync(file)
      if (index < manifest.length) templates.push(await fonts.fontItemFromPath(file))
      const item = cached.cachedFontForRuntime(templates[index % manifest.length], file, stat, paths.relativePathForRoot(fontRoot, file))
      assert.equal(item.id, host.fontIdentity.fileRuntimeFontId(file, stat.size, stat.mtimeMs))
      assert(item.scripts?.length && item.scriptVersion === host.config.SCRIPT_DETECTION_VERSION)
      items.push(item)
    }
    await host.initialize(items, { legacyRows: 0, oldProjection: false })
    const defaultDbPath = host.paths.rootDbForRoot(fontRoot), cacheDir = host.paths.rootCacheForRoot(fontRoot)
    const dbPath = path.join(path.dirname(defaultDbPath), 'index-watcher-active.sqlite')
    const seed = host.openDb(defaultDbPath)
    try {
      // The reusable host deliberately seeds placeholder keys. Replace them
      // with actual production signatures before claiming a no-op workload.
      const update = seed.prepare('UPDATE entries SET cache_key=? WHERE relative_path=?')
      for (const file of files) {
        const relative = paths.relativePathForRoot(fontRoot, file), stat = fs.statSync(file)
        update.run(cachePaths.fileCacheSignature(relative, stat.size, stat.mtimeMs), relative)
      }
      installWriteAudit(seed)
      // A real, non-default latest-pointer target proves that reuseExisting
      // follows the selected database rather than trusting the default path.
      seed.prepare('VACUUM INTO ?').run(dbPath)
    } finally { seed.close() }
    host.paths.watcherActiveDb = dbPath
    await host.rootManifest.writeRootCacheManifest(cacheDir, fontRoot, 'root', FILES, dbPath)
    // The host's backing DB is intentionally outside its font root. Register it
    // separately so a cache read really uses the native SQLite snapshot route.
    host.load('src/main/rust-core/rustSharedIoCommandRuntime.ts').registerIsolatedRoot(cacheDir)
    assert(await host.load('src/main/path/startupPathAvailabilityRuntime.ts').ensureStartupPathRootAvailable(cacheDir, host.appendLog, 'watcher-fixture-cache'))
    const global = host.load('src/main/performance/globalIoRuntime.ts').createGlobalIoRuntime({ env: process.env, localScanWorkers: 2,
      appendLog: host.appendLog, isIndexingActive: () => false, isUserActive: () => false,
      storageProfileForPath: value => ({ rootPath: path.parse(value).root, type: 'ssd', reason: 'controlled-local-fixture', isNetwork: false }) })
    const observedGlobalIo = host.observer.global(global)
    const withGlobalIo = async (...args) => { const result = await observedGlobalIo(...args); await state.afterGlobalIo?.(args[0], result); return result }
    const rootLoad = selectedOwners(host, ['src/main/indexing/rootIndexRuntime.ts', 'src/main/indexing/root-index/rootIndexLockRuntime.ts'])
    const rootIndex = rootLoad('src/main/indexing/rootIndexRuntime.ts').createRootIndexRuntime({
      appName: host.config.APP_NAME, fontScanCacheVersion: host.config.FONT_SCAN_CACHE_VERSION,
      scriptDetectionVersion: host.config.SCRIPT_DETECTION_VERSION, exists: host.exists,
      openStableSqliteDb: host.openStableSqliteDb, closeSqliteDb: host.closeSqliteDb, appendStartupLog: host.appendLog, withGlobalIo,
      invalidateSharedFontRuntimeCaches: selectedStorageInvalidator(host, state), recordCacheEvent: async () => {},
      runRustRootIndexApplyChanges: async input => {
        const result = await host.indexing.runRustRootIndexApplyChanges(input)
        assert.equal(result?.applied, true, 'Actual native root write is required')
        assert.equal(result.upserts, input.upserts.length)
        assert.equal(result.deletes, input.deletes.length)
        state.stage?.nativeApplies.push({ upserts: input.upserts.length, deletes: input.deletes.length,
          directories: input.directories?.length || 0, applied: result.applied })
        state.afterRootApply?.(input, result)
        return result
      },
    })
    const common = { fontExtensions: new Set(['.ttf']), scriptDetectionVersion: host.config.SCRIPT_DETECTION_VERSION,
      fileCacheSignature: cachePaths.fileCacheSignature, cacheKeyForRootFile: paths.relativePathForRoot,
      cacheEntryRuntimePath: cached.cacheEntryRuntimePath, withGlobalIo, appendStartupLog: host.appendLog,
      hasValidFontSignature: fonts.hasValidFontSignature, fontItemFromPath: fonts.fontItemFromPath,
      sanitizeCachedFont: cached.sanitizeCachedFont, cachedFontForRuntime: cached.cachedFontForRuntime,
      openRootIndexDb: rootIndex.openRootIndexDb, closeSqliteDb: host.closeSqliteDb,
      saveRootIndexDirectorySignatures: async (...args) => { const result = await rootIndex.saveRootIndexDirectorySignatures(...args); await state.afterDirectorySave?.(); return result } }
    const directoryFile = 'src/main/indexing/scan-orchestrator/rootDirectoryCacheRuntime.ts'
    const storageFile = 'src/main/cache/scan-storage/rootIndexStorageRuntime.ts'
    const watcherFile = 'src/main/watcher/watchedFolderIndexRuntime.ts'
    function makeWatcher({ directoryModule = host.load(directoryFile), storageModule = host.load(storageFile), watcherModule = host.load(watcherFile), runRustFontParseBatch = host.indexing.runRustFontParseBatch, saveRootIndexSqliteChanges = rootIndex.saveRootIndexSqliteChanges, exposeEntry = false, compatibilityEntry = false } = {}) {
      const directoryRuntime = directoryModule.createRootDirectoryCacheRuntime(common)
      const entry = host.load('src/main/watcher/manual-refresh/manualFolderIndexEntryRuntime.ts').createManualFolderIndexEntryRuntime({
        ...common, runRustFontParseBatch, runFontParseWorkerPool: async () => { throw Error('Watcher must use actual selective native parsing') }, scanFoldersRuntime: () => directoryRuntime })
      if (exposeEntry) return entry
      const unexpectedInitialization = async () => { if (state.stage) state.stage.initializers++; throw Error('Compatible storage attempted initialization') }
      const storage = storageModule.createRootIndexStorageRuntime({
        fontScanCacheVersion: host.config.FONT_SCAN_CACHE_VERSION, rootCacheDir: host.paths.rootCacheForRoot,
        rootIndexDbPath: host.paths.rootDbForRoot, rootIndexDbDir: root => path.dirname(host.paths.rootDbForRoot(root)),
        rootCacheLockDir: root => path.join(host.paths.rootCacheForRoot(root), constants.ROOT_CACHE_LOCK_DIR_NAME),
        ensureRootArchitectureDatabases: unexpectedInitialization, resolveActiveRootIndexDbPath: rootIndex.resolveActiveRootIndexDbPath,
        readRootIndexSqliteFile: rootIndex.readRootIndexSqliteFile, exists: host.exists, appendStartupLog: host.appendLog,
        recoveryMessage: error => String(error), writeRootCacheManifest: async (...args) => {
          if (state.stage) state.stage.manifestWrites++
          return rootIndex.writeRootCacheManifest(...args)
        },
      }, { readScanCacheFile: async () => { throw Error('Legacy cache is outside this fixture') }, hideDirectoryOnWindows: unexpectedInitialization })
      return watcherModule.createWatchedFolderIndexRuntime({ ...common, ...entry,
        ...(compatibilityEntry ? { upsertFontIndexEntries: undefined } : {}),
        upsertFontIndexEntry: async (...args) => { const result = await entry.upsertFontIndexEntry(...args); await state.afterSingleEntry?.(); return result },
        fontScanCacheVersion: host.config.FONT_SCAN_CACHE_VERSION, isIgnoredWatcherPath: () => false,
        rootIndexDbPath: host.paths.rootDbForRoot, rootCacheDir: host.paths.rootCacheForRoot, exists: host.exists,
        resolveActiveRootIndexDbPath: rootIndex.resolveActiveRootIndexDbPath,
        ensureRootScanCacheStorage: async (...args) => {
          const selected = await storage.ensureRootScanCacheStorage(...args)
          assert.equal(path.resolve(selected.cachePath), path.resolve(dbPath), 'Watcher did not use the actual latest-pointer database')
          return selected
        },
        listFontFilesWithDirectoryCache: async (...args) => {
          const rows = await directoryRuntime.listFontFilesWithDirectoryCache(...args)
          for (const row of rows) {
            assert.equal(row.freshStat, true, 'Watcher reused historical child attributes')
            const current = fs.statSync(row.file)
            assert.equal(row.stat.size, current.size)
            assert(Math.abs(row.stat.mtimeMs - current.mtimeMs) < 1)
          }
          if (state.stage) state.stage.freshRows += rows.length
          await state.afterDirectoryRows?.()
          return rows
        },
        saveRootIndexSqliteChanges,
        saveScanCacheFile: async () => { throw Error('Watcher fell back to a JSON cache') },
        writeRootCacheManifest: rootIndex.writeRootCacheManifest,
        runRustWatcherPreflight: input => host.indexing.runRustWatcherPreflight(input),
      })
    }
    const watcher = makeWatcher()
    const change = type => [{ folder: fontRoot, fileName: '.', eventType: type, receivedAt: Date.now(), origin: 'controlled-full-root' }]
    function recordWatcherResult(label, result) {
      state.lastWatcherResult = { label, upserts: result.upserts.length, deletes: result.deletes.length,
        errorCount: result.errors.length, errors: result.errors.slice(0, 8).map(error => redactDiagnostic(error.message, redactions)) }
      return result
    }
    function startStage(label) {
      host.observer.reset()
      state.phase = label
      return state.stage = { label, operations: {}, directories: new Set(), batchSizes: [], nativeFileEvidence: 0,
        freshRows: 0, fontStats: 0, fontReads: 0, initializers: 0, manifestWrites: 0, nativeApplies: [] }
    }
    function finishStage() {
      const stage = state.stage
      stage.processes = host.observer.counts.processes
      state.stage = undefined
      return stage
    }
    const summarize = stage => ({ ...stage, directories: stage.directories.size })
    async function signature() { return state.context.rootIndexContentSignature(dbPath, fontRoot) }
    async function validate(label, expectedRebuilds, expectedTotal) {
      state.phase = `validation:${label}`
      const ctx = state.context, key = ctx.mergedIndexRootsKey([fontRoot])
      await Promise.all([...ctx.mergedIndexValidateInFlight.values()])
      // Make the next normal timer window due. Do not alter source signatures,
      // readiness/cache keys, rows, query results, or validation/build decisions.
      ctx.mergedIndexLastValidateAt.set(key, Date.now() - ctx.backgroundValidateIntervalMs - 1)
      const start = host.receipts.length, logStart = host.logs.length
      const request = { sidebarPage: 'library', activeFilter: { kind: 'all' }, installStatus: 'all', sortMode: 'nameAsc' }
      assert(await state.page.ensureMergedIndexReadyForWorker([fontRoot]), `${label}: actual worker readiness failed`)
      await Promise.all([...ctx.mergedIndexValidateInFlight.values()])
      await ctx.waitForMergedIndexMutations()
      const logs = host.logs.slice(logStart)
      assert(logs.some(line => line.includes('background validation finished: reason=worker-ready-validation')), `${label}: next worker-ready validation did not finish`)
      assert(!logs.some(line => /background validation skipped|signature fallback|rebuild fallback to node/.test(line)), `${label}: production validation degraded`)
      const page = await state.page.queryFontPageFromMergedIndexWorker(request, 1000, 0)
      assert(page, `${label}: actual native worker page unavailable`)
      assert.equal(page.total, expectedTotal, `${label}: rebuilt worker population is stale`)
      const receipts = host.receipts.slice(start)
      assert.equal(receipts.filter(row => row.method === 'runRustMergedIndexRebuild').length, expectedRebuilds, `${label}: unexpected merged rebuild count`)
      assert(receipts.some(row => row.method === 'runRustMergedIndexPageQuery'), `${label}: native page receipt missing`)
      const merged = host.openDb(host.paths.mergedPath, { readonly: true })
      let source
      try { source = merged.prepare('SELECT index_signature FROM sources WHERE root_path=?').get(fontRoot) }
      finally { merged.close() }
      assert.equal(source?.index_signature, await signature(), `${label}: worker validation did not acknowledge the real content signature`)
      return page
    }
    // First native query owns initial build; subsequent checks specifically take
    // the already-usable worker-ready branch, rather than an explicit rebuild.
    state.phase = 'initial-root-signature'
    assert.match(await signature(), /^root-v3\|/, 'Initial root signature must come from an owned real SQLite snapshot')
    assert(state.ownedSqliteSnapshots > 0, 'Initial signature bypassed the real native SQLite snapshot')
    state.phase = 'initial-worker-page'
    assert(await state.page.queryFontPageFromMergedIndexWorker({ sidebarPage: 'library', activeFilter: { kind: 'all' } }, 1000, 0),
      'Initial production worker page did not become ready')
    await Promise.all([...state.context.mergedIndexValidateInFlight.values()])
    await state.context.waitForMergedIndexMutations()
    assert(host.receipts.some(row => row.method === 'runRustMergedIndexRebuild'), 'Fixture never established an actual native merged index')
    const original = audit(host), originalSignature = await signature()
    assert.equal(original.directories.length, 0, 'Cold directory fixture was already populated')
    for (const type of ['rescan', 'rename']) {
      startStage(`preflight-${type}`)
      assert.equal(await watcher.watcherChangeBatchLooksUnchanged(fontRoot, change(type)), false)
      const stage = finishStage()
      assert.equal(stage.processes, 0, 'Rename/rescan preflight started a pointless process')
      assert.deepEqual(stage.operations, {}, 'Rename/rescan preflight touched storage')
    }
    startStage('cold-full-root')
    const coldPayload = recordWatcherResult('cold-full-root', await watcher.applyWatchedFolderChangesToIndex(change('rescan')))
    const cold = finishStage(), afterCold = audit(host)
    assert.deepEqual([coldPayload.upserts.length, coldPayload.deletes.length, coldPayload.errors.length], [0,0,0])
    assertBoundedWalk(cold, FILES, true)
    assert.equal(afterCold.directories.length, DIRECTORIES)
    assert.equal(afterCold.writes.directory - original.writes.directory, DIRECTORIES, 'Real native directory rows were not persisted')
    assertContentUntouched(original, afterCold)
    assert.equal(await signature(), originalSignature, 'Cold directory-only apply invalidated root-v3')
    await validate('cold-directory-write', 0, FILES)
    stages.push(summarize(cold))

    startStage('warm-full-root')
    const warmPayload = recordWatcherResult('warm-full-root', await watcher.applyWatchedFolderChangesToIndex(change('rescan')))
    const warm = finishStage(), afterWarm = audit(host)
    assert.deepEqual([warmPayload.upserts.length, warmPayload.deletes.length, warmPayload.errors.length], [0,0,0])
    assertBoundedWalk(warm, FILES, false)
    assert.deepEqual(afterWarm, afterCold, 'Unchanged rescan rewrote persisted bookkeeping')
    assert.equal(await signature(), originalSignature)
    await validate('warm-directory-noop', 0, FILES)
    stages.push(summarize(warm))

    // Narrow race/error controls at the production storage boundary, outside
    // the measured native walks. Only the outer probe and denied read are
    // controlled; the missing-file sentinel comes from the real SQLite reader.
    async function checkStorageBoundary(kind, module = host.load(storageFile), label = kind) {
      state.phase = `storage-boundary:${label}`
      const root = kind === 'compatible' ? fontRoot : path.join(directory, `storage-${label}`)
      const cache = kind === 'compatible' ? cacheDir : path.join(root, '.hfm-cache')
      const defaultPath = kind === 'compatible' ? defaultDbPath : path.join(cache, constants.ROOT_INDEX_DB_DIR_NAME, constants.ROOT_INDEX_DB_FILE_NAME)
      const counts = { probes: 0, reads: 0, hidden: 0, architecture: 0, manifests: 0 }
      const denied = Object.assign(new Error('Controlled inaccessible root index'), { code: 'EACCES' })
      const storage = module.createRootIndexStorageRuntime({
        fontScanCacheVersion: host.config.FONT_SCAN_CACHE_VERSION,
        rootCacheDir: () => cache, rootIndexDbPath: () => defaultPath, rootIndexDbDir: () => path.dirname(defaultPath),
        rootCacheLockDir: () => path.join(cache, constants.ROOT_CACHE_LOCK_DIR_NAME),
        resolveActiveRootIndexDbPath: host.rootManifest.resolveActiveRootIndexDbPath,
        exists: async file => {
          counts.probes++
          // Outer existence can become stale before the reader's own probe.
          if (kind !== 'compatible' && counts.probes === 1) return true
          return host.exists(file)
        },
        readRootIndexSqliteFile: async (...args) => {
          counts.reads++
          if (kind === 'inaccessible') throw denied
          return host.rootStorage.readRootIndexSqliteFile(...args)
        },
        ensureRootArchitectureDatabases: async () => { counts.architecture++ },
        writeRootCacheManifest: async () => { counts.manifests++ },
        appendStartupLog: host.appendLog, recoveryMessage: error => String(error),
      }, { readScanCacheFile: async () => { throw Error('Unexpected legacy boundary read') },
        hideDirectoryOnWindows: async () => { counts.hidden++ } })
      if (kind === 'inaccessible') {
        await assert.rejects(() => storage.ensureRootScanCacheStorage(root, { reuseExisting: true }), error => error === denied)
        assert.equal(counts.reads, 1, 'Inaccessible storage must attempt exactly one read')
        assert(!fs.existsSync(cache), 'Inaccessible read created cache directories')
      } else {
        const result = await storage.ensureRootScanCacheStorage(root, { reuseExisting: true })
        if (kind === 'missing') {
          assert.equal(result.cache.rebuildRequired, true, 'Missing sentinel skipped recovery')
          assert.equal(counts.reads, 2, 'Missing sentinel must re-enter the normal storage path')
          assert.equal(counts.hidden, 1, 'Missing storage must enter the normal directory setup once')
          assert.equal(counts.architecture, 1, 'Missing storage must enter architecture recovery once')
          assert.equal(counts.manifests, 0, 'Missing index must not be published')
          assert.deepEqual(plain(result.cache.entries), {}, 'Missing storage returned nonexistent entries')
          return
        }
        assert.equal(path.resolve(result.cachePath), path.resolve(dbPath), 'Compatible storage selected the wrong database')
        assert(Array.isArray(result.cache.directorySignatures), 'Compatible storage did not return a completed snapshot')
        assert.equal(result.cache.directorySignatures.length, DIRECTORIES, 'Compatible storage lost directory baselines')
        assert.equal(counts.reads, 1, 'Compatible storage repeated its index read')
      }
      assert.deepEqual([counts.hidden, counts.architecture, counts.manifests], [0,0,0], 'Storage success/error path performed setup or writes')
    }
    for (const kind of ['compatible', 'missing', 'inaccessible']) {
      await checkStorageBoundary(kind)
      controls.push(`storage-boundary-${kind}`)
    }
    const missingGuardLoad = selectedOwners(host, [storageFile], { [storageFile]: [
      'if (!cache.rebuildRequired && Array.isArray(cache.directorySignatures)) {', 'if (!cache.rebuildRequired) {' ] })
    await assert.rejects(() => checkStorageBoundary('missing', missingGuardLoad(storageFile), 'missing-mutant'), /Missing sentinel skipped recovery/)
    controls.push('rejects-missing-sentinel-reuse')

    // Reopening an equivalent Node schema is a distinct writer-init regression.
    state.phase = 'equivalent-node-schema-initializer'
    const local = host.openDb(dbPath)
    try { host.rootStorage.initializeRootIndexDb(local, fontRoot, 'root') } finally { local.close() }
    assertContentUntouched(afterWarm, audit(host))

    // Every negative uses a real file change and the same full-root walk. Child
    // overwrite preserves its parent's timestamp/count to disallow that shortcut.
    let currentTotal = FILES, priorSignature = originalSignature
    const added = path.join(dirs[5], 'added.ttf')
    for (const kind of ['changed', 'added', 'deleted']) {
      state.phase = `font-mutation:${kind}`
      if (kind === 'changed') {
        const parentStat = fs.statSync(dirs[3])
        copy(manifest[4].source, files[3], '2026-01-01T00:00:05.000Z')
        fs.utimesSync(dirs[3], parentStat.atimeMs / 1000, parentStat.mtimeMs / 1000)
        assert.equal(Math.round(fs.statSync(dirs[3]).mtimeMs), Math.round(parentStat.mtimeMs), 'Changed-child control did not preserve the parent directory timestamp')
      } else if (kind === 'added') { copy(manifest[1].source, added); currentTotal++ }
      else { fs.unlinkSync(added); currentTotal-- }
      const result = recordWatcherResult(`font-mutation:${kind}`, await watcher.applyWatchedFolderChangesToIndex(change('rescan')))
      assert.equal(result.errors.length, 0, `${kind}: full-root watcher returned an error`)
      assert.equal(result.upserts.length, kind === 'deleted' ? 0 : 1, `${kind}: wrong watcher upsert count`)
      assert.equal(result.deletes.length, kind === 'deleted' ? 1 : 0, `${kind}: wrong watcher delete count`)
      for (const item of result.upserts) {
        const stat = fs.statSync(item.path)
        assert.equal(item.id, host.fontIdentity.fileRuntimeFontId(item.path, stat.size, stat.mtimeMs), `${kind}: watcher published a noncanonical runtime identity`)
      }
      const next = await signature()
      assert.notEqual(next, priorSignature, `${kind}: actual font mutation failed to invalidate root-v3`)
      const page = await validate(kind, 1, currentTotal)
      if (kind === 'changed') assert(page.items.some(item => item.id === result.upserts[0].id), 'New file identity did not reach the worker page')
      priorSignature = next
      controls.push(`${kind}-font-invalidates`)
    }

    // Simulate a pre-fix writer whose only freshness evidence is updatedAt.
    state.phase = 'old-writer-updatedAt-control'
    const oldWriter = host.openDb(dbPath)
    try { oldWriter.prepare("UPDATE meta SET value=? WHERE key='updatedAt'").run('2026-02-02T00:00:00.000Z') }
    finally { oldWriter.close() }
    assert.notEqual(await signature(), priorSignature, 'Old-writer updatedAt evidence was ignored')
    await validate('old-writer-updatedAt', 1, currentTotal)
    controls.push('old-writer-updatedAt-invalidates')
    priorSignature = await signature()
    state.phase = 'schema-version-control'
    const schema = host.openDb(dbPath)
    try { schema.prepare("UPDATE meta SET value=? WHERE key IN ('schemaVersion','schema_version')").run(String(constants.ROOT_INDEX_DB_SCHEMA_VERSION - 1)) }
    finally { schema.close() }
    assert.notEqual(await signature(), priorSignature, 'Schema compatibility evidence was ignored')
    await validate('schema-version', 1, currentTotal)
    // Real native zero-entry apply repairs the old version, which must invalidate.
    state.phase = 'native-schema-migration-control'
    priorSignature = await signature()
    const migrated = await host.indexing.runRustRootIndexApplyChanges({ dbPath, rootPath: fontRoot, storage: 'root', mode: 'incremental',
      schemaVersion: constants.ROOT_INDEX_DB_SCHEMA_VERSION, cacheVersion: host.config.FONT_SCAN_CACHE_VERSION,
      scriptDetectionVersion: host.config.SCRIPT_DETECTION_VERSION, upserts: [], deletes: [], directories: [] })
    assert.equal(migrated?.applied, true, 'Native schema migration did not return an applied receipt')
    assert.notEqual(await signature(), priorSignature, 'Actual schema migration failed to invalidate')
    await validate('schema-migration', 1, currentTotal)
    controls.push('schema-and-migration-invalidate')

    const beforeIncomplete = audit(host)
    const incompleteFile = files.at(-1), incompleteDir = dirs.at(-1), incompleteTime = fs.statSync(incompleteDir)
    // A genuinely missing indexed file makes an unsafe partial-walk delete
    // observable. The rejected batch must leave that old row untouched.
    fs.unlinkSync(incompleteFile)
    state.incompleteReceipt = true
    startStage('incomplete-enumeration')
    try {
      const incomplete = recordWatcherResult('incomplete-enumeration', await watcher.applyWatchedFolderChangesToIndex(change('rescan')))
      assert(incomplete.errors.length > 0, 'Incomplete native receipt was accepted')
      assert.equal(incomplete.upserts.length, 0)
      assert.equal(incomplete.deletes.length, 0)
    }
    finally {
      state.incompleteReceipt = false; finishStage()
      copy(manifest[(FILES - 1) % manifest.length].source, incompleteFile)
      fs.utimesSync(incompleteDir, incompleteTime.atimeMs / 1000, incompleteTime.mtimeMs / 1000)
    }
    assert.deepEqual(audit(host), beforeIncomplete, 'Incomplete enumeration deleted entries or persisted directory evidence')
    controls.push('incomplete-native-receipt-retains-index')

    // Regression controls alter only a freshly loaded test VM. Each removed
    // optimization must violate the same acceptance oracle used above.
    const mutations = [
      ['duplicate-directory-writes', directoryFile, 'if (!signatureUnchanged) context.directoryUpdates.push({', 'context.directoryUpdates.push({', 'directoryModule'],
      ['second-directory-snapshot', directoryFile, 'if (context.cache.directorySignatures) {', 'if (false) {', 'directoryModule'],
      ['storage-initialization', storageFile, 'if (request.reuseExisting) {', 'if (false) {', 'storageModule'],
    ]
    for (const [name, relative, before, after, option] of mutations) {
      const mutantLoad = selectedOwners(host, [relative], { [relative]: [before, after] })
      const mutant = makeWatcher({ [option]: mutantLoad(relative) })
      const previous = audit(host)
      startStage(name)
      let thrown
      try {
        await mutant.applyWatchedFolderChangesToIndex(change('rescan'))
        assertBoundedWalk(finishStage(), FILES, false)
      } catch (error) { thrown = error; if (state.stage) finishStage() }
      assert(thrown, `Removing ${name} escaped the regression oracle`)
      assert.match(String(thrown.message), name === 'duplicate-directory-writes' ? /Redundant directory\/native write/
        : name === 'second-directory-snapshot' ? /one actual snapshot/ : /attempted initialization/,
      `Fault control failed for an unrelated reason: ${name}`)
      assertContentUntouched(previous, audit(host))
      controls.push(`rejects-${name}`)
    }
    const preflightGuard = "if (normalizedChanges.some(change => String(change.eventType || '').toLowerCase() !== 'change')) return false"
    const preflightLoad = selectedOwners(host, [watcherFile], { [watcherFile]: [preflightGuard, 'if (false) return false'] })
    startStage('preflight-regression')
    assert.equal(await makeWatcher({ watcherModule: preflightLoad(watcherFile) }).watcherChangeBatchLooksUnchanged(fontRoot, change('rescan')), false)
    const preflightWork = finishStage()
    assert.throws(() => assert.equal(preflightWork.processes, 0, 'Rename/rescan preflight started a pointless process'), /pointless process/)
    controls.push('rejects-redundant-native-preflight')
    const beforeFreshness = audit(host), parentTime = fs.statSync(dirs[7])
    state.phase = 'fresh-child-regression-control'
    copy(manifest[0].source, files[7], '2026-01-01T00:00:09.000Z')
    fs.utimesSync(dirs[7], parentTime.atimeMs / 1000, parentTime.mtimeMs / 1000)
    assert.equal(Math.round(fs.statSync(dirs[7]).mtimeMs), Math.round(parentTime.mtimeMs))
    const staleLoad = selectedOwners(host, [directoryFile], { [directoryFile]: [
      'const directoryUnchanged = !context.requireFreshFileStats && !shared && signatureUnchanged;',
      'const directoryUnchanged = signatureUnchanged;' ] })
    const stale = recordWatcherResult('historical-child-mutant', await makeWatcher({ directoryModule: staleLoad(directoryFile) }).applyWatchedFolderChangesToIndex(change('rescan')))
    assert(stale.errors.some(error => /historical child attributes/.test(error.message)), 'Historical child evidence escaped the freshness oracle')
    assert.equal(stale.upserts.length, 0)
    assert.equal(stale.deletes.length, 0)
    assert.deepEqual(audit(host), beforeFreshness)
    state.phase = 'fresh-child-control-recovery'
    const recovered = recordWatcherResult('fresh-child-control-recovery', await watcher.applyWatchedFolderChangesToIndex(change('rescan')))
    assert.equal(recovered.upserts.length, 1, 'Freshness control recovery did not upsert the changed child')
    assert.equal(recovered.deletes.length, 0, 'Freshness control recovery deleted an existing child')
    assert.equal(recovered.errors.length, 0, 'Freshness control recovery returned an error')
    await validate('freshness-control-recovery', 1, currentTotal)
    controls.push('rejects-parent-signature-child-reuse')

    const inventoryProof = await require('./lib/watcher-inventory-checkpoints.cjs').checkWatcherInventoryCheckpoints({
      host, rootIndex, makeWatcher, fontRoot, cacheDir, dbPath, files, manifest, copy, state, startStage, finishStage, audit, controls })

    await host.close()
    assert.deepEqual(host.closeProof(), { hostClosed: true, databaseOwnersClosed: true, childrenReaped: true,
      remainingDatabaseOwners: 0, remainingChildren: 0 })
    const report = { ok: true, platform: 'win32', scope: 'private local fixture, actual isolated native I/O; no NAS or renderer latency claim',
      directories: DIRECTORIES, initialFiles: FILES, stages, controls, inventoryProof,
      validation: 'Actual worker-ready page + background validation + native rebuild receipts + persisted source signature',
      schedulingControl: 'Only validation throttle age is made due; production freshness and build decisions are unchanged',
      snapshotOwnership: { casePrivateTemporaryDirectory: true, verifiedNativeSnapshots: state.ownedSqliteSnapshots },
      cleanup: host.closeProof() }
    const reportPath = arg('--report')
    if (reportPath) { fs.mkdirSync(path.dirname(path.resolve(reportPath)), { recursive: true }); fs.writeFileSync(reportPath, JSON.stringify(report, null, 2)) }
    console.log(`[diagnostics:watcher-noop-freshness] ${JSON.stringify(report)}`)
  } catch (error) {
    failure = error
    error.watcherDiagnostics = failureDiagnostics(host, state, error, redactions)
    throw error
  }
  finally {
    state.stage = undefined
    try {
      try { await host?.close() } catch (error) { if (!failure) throw error }
    } finally {
      for (const key of ['TEMP', 'TMP']) {
        if (savedTemp[key] === undefined) delete process.env[key]
        else process.env[key] = savedTemp[key]
      }
      fs.rmSync(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 })
    }
  }
}
let completed = false
process.once('beforeExit', () => { if (!completed) { console.error('[diagnostics:watcher-noop-freshness] did not complete'); process.exitCode = 1 } })
main().then(() => { completed = true }).catch(error => {
  completed = true
  // Native failures can contain private paths/logs. Publish only a bounded,
  // redacted diagnostic message; fixtures are always removed in finally.
  const text = redactDiagnostic(error?.message || error)
  console.error(`[diagnostics:watcher-noop-freshness] ${error?.name || 'Error'}: ${text}`)
  if (error?.watcherDiagnostics) console.error(`[diagnostics:watcher-noop-freshness] context=${JSON.stringify(error.watcherDiagnostics)}`)
  process.exitCode = 1
})
