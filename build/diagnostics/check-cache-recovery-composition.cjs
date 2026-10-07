#!/usr/bin/env node
'use strict'
// Windows only. Production database, folder-cache, scan-publication and renderer
// owners on real populated SQLite files; only external I/O faults are injected.
const assert = require('node:assert/strict')
const fs = require('node:fs'), fsp = fs.promises, path = require('node:path'), os = require('node:os')
const { DatabaseSync } = require('node:sqlite')
const { loader } = require('./check-operation-chain.cjs')
const root = path.resolve(__dirname, '../..'), abs = value => path.join(root, value)
const plain = value => JSON.parse(JSON.stringify(value))
function openDb(file) {
  const db = new DatabaseSync(file)
  db.transaction = fn => () => { db.exec('BEGIN IMMEDIATE'); try { const value = fn(); db.exec('COMMIT'); return value } catch (error) { db.exec('ROLLBACK'); throw error } }
  return db
}
const exists = async file => { try { await fsp.stat(file); return true } catch (error) { if (error.code === 'ENOENT') return false; throw error } }
function fixtureFont(file, id = 'fixture') { return { id, path: file, fileName: path.basename(file), family: id, fullName: id,
  postscriptName: id, style: 'Regular', format: 'ttf', fileSize: 100, modifiedAt: 1, addedAt: '', favorite: false,
  collectionIds: [], tagNames: ['shared'], localTagNames: ['模板'], systemInstalled: false, systemInstallMatches: [], active: false } }
function fixtureCache(folder) { const font = fixtureFont(path.join(folder, 'font.ttf')); return { version: 1, entries: { 'font.ttf': {
  path: 'font.ttf', cacheKey: 'font.ttf', fileSize: 100, modifiedAt: 1, status: 'ok', font, cachedAt: '2026-01-01T00:00:00Z' } } } }
async function main() {
  assert.equal(process.platform, 'win32', 'HFM verification is Windows-only')
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'hfm-cache-recovery-'))
  const load = loader(), helpers = load('src/main/db/sqliteHelpers.ts'), policy = load('src/main/db/sqliteRecoveryPolicy.ts')
  const stages = []
  try {
    for (const code of ['SQLITE_BUSY', 'SQLITE_LOCKED', 'EACCES', 'EROFS', 'EIO', 'ENOENT']) assert.equal(policy.isRecoverableDerivedSqliteError({ code }), false)
    for (const code of ['SQLITE_CORRUPT', 'SQLITE_NOTADB']) assert.equal(policy.isRecoverableDerivedSqliteError({ code }), true)
    assert.equal(policy.isRecoverableDerivedSqliteError({ sharedIo: true, reason: 'cancelled', outcome: 'unknown' }), false)
    const appPath = path.join(directory, 'app.sqlite'), app = openDb(appPath)
    app.exec(`PRAGMA journal_mode=WAL; CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      INSERT INTO meta VALUES('schemaVersion','90'); CREATE TABLE app_state(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      INSERT INTO app_state VALUES('license','license-sentinel');
      CREATE TABLE local_font_favorites(font_id TEXT PRIMARY KEY,favorite INTEGER NOT NULL); INSERT INTO local_font_favorites VALUES('legacy',1);
      CREATE TABLE local_font_tags(font_id TEXT,tag_name TEXT,updated_at TEXT,PRIMARY KEY(font_id,tag_name)); INSERT INTO local_font_tags VALUES('legacy','模板','before');`)
    const licensePath = path.join(directory, 'license', 'license.json')
    await fsp.mkdir(path.dirname(licensePath)); fs.writeFileSync(licensePath, 'real-path-license-sentinel')
    app.exec(`CREATE TABLE font_uninstall_receipts(source_path TEXT PRIMARY KEY,revision INTEGER NOT NULL,receipt_json TEXT NOT NULL);
      INSERT INTO font_uninstall_receipts VALUES('source',7,'{"remaining":true}');
      CREATE TABLE local_font_protection(font_path TEXT PRIMARY KEY,protected INTEGER NOT NULL CHECK(protected IN (0,1))); INSERT INTO local_font_protection VALUES('source',1);
      CREATE TABLE tag_relinked_files(real_path TEXT PRIMARY KEY,font_path TEXT NOT NULL,file_size INTEGER NOT NULL,modified_at REAL NOT NULL,content_sha256 TEXT); INSERT INTO tag_relinked_files VALUES('real','source',100,1,'hash');
      CREATE TABLE tag_font_snapshots(font_path TEXT PRIMARY KEY,font_json TEXT NOT NULL); INSERT INTO tag_font_snapshots VALUES('source','{"family":"retained"}');`)
    const businessTables = ['font_uninstall_receipts','local_font_protection','tag_relinked_files','tag_font_snapshots']
    const business = Object.fromEntries(businessTables.map(table=>[table,plain(app.prepare(`SELECT * FROM ${table}`).all())]))
    const walReader = openDb(appPath)
    walReader.exec('BEGIN'); walReader.prepare('SELECT * FROM app_state').all()
    app.prepare("INSERT INTO app_state VALUES('wal-commit','after-reader-start')").run()
    assert(fs.statSync(`${appPath}-wal`).size > 0)
    const migrateApp = load('src/main/library/runtime/librarySchemaRuntime.ts').initializeLibraryDb
    migrateApp(app); migrateApp(app)
    assert.deepEqual(plain(app.prepare('SELECT * FROM local_font_favorites').get()), { font_id: 'legacy', favorite: 1, font_path: '' })
    assert.equal(app.prepare('SELECT tag_name FROM local_font_tags').get().tag_name, '模板')
    assert.equal(app.prepare("SELECT value FROM app_state WHERE key='license'").get().value, 'license-sentinel')
    helpers.setSqliteMeta(app, 'schemaVersion', '101')
    assert.throws(() => migrateApp(app), /版本不受支持/)
    assert.equal(helpers.getSqliteMeta(app, 'schemaVersion'), '101')
    app.close(); walReader.exec('ROLLBACK'); walReader.close()
    const reopenedApp = openDb(appPath)
    assert.equal(reopenedApp.prepare("SELECT value FROM app_state WHERE key='wal-commit'").get().value, 'after-reader-start')
    for (const table of businessTables) assert.deepEqual(plain(reopenedApp.prepare(`SELECT * FROM ${table}`).all()), business[table])
    reopenedApp.close()
    assert.equal(fs.readFileSync(licensePath,'utf8'),'real-path-license-sentinel')
    const corrupt = path.join(directory, 'unreadable-app.sqlite'); fs.writeFileSync(corrupt, 'retain-user-database')
    const sqlite = load('src/main/db/sqliteRuntime.ts').createSqliteRuntime({ appName: 'HFM', nodeRequire: () => function(file) { return openDb(file) },
      normalizePath: value => value, sqliteSidecarPaths: file => [file, `${file}-wal`, `${file}-shm`], appendLog() {}, exists,
      backupsRootPath: () => path.join(directory, 'backups'), corruptDatabasesRootPath: () => path.join(directory, 'corrupt'),
      quickCheckIntervalMs: 0, fastOpenSharedCacheDbs: false, verboseSqliteLogs: false, busyTimeoutMs: 10, mmapSizeBytes: 0, corruptRetentionCount: 3 })
    await assert.rejects(() => sqlite.openRecoverableApplicationSqliteDb(corrupt, 'library'))
    assert.equal(fs.readFileSync(corrupt, 'utf8'), 'retain-user-database')
    assert.equal(await exists(path.join(directory, 'corrupt')), false)
    stages.push('populated app migration preserves tags/favorites/license/WAL; future and unreadable app fail closed')

    const preview = openDb(path.join(directory, 'preview.sqlite'))
    preview.exec(`CREATE TABLE preview_cache(preview_key TEXT PRIMARY KEY,relative_path TEXT,output_path TEXT,font_signature TEXT,text_hash TEXT,font_size INTEGER,width INTEGER,height INTEGER,storage TEXT,status TEXT);
      INSERT INTO preview_cache VALUES('old','font.ttf','old.png','sig','text',12,100,30,'root','ok');`)
    const migratePreview = load('src/main/preview/previewCacheRuntime.ts').initializePreviewDbSchema
    migratePreview(preview, { schemaVersion: 1, ensureSqliteColumn: helpers.ensureSqliteColumn, setSqliteMeta: helpers.setSqliteMeta })
    assert.equal(preview.prepare('SELECT output_path FROM preview_cache').get().output_path, 'old.png')
    assert(preview.prepare('SELECT updated_at FROM preview_cache').get().updated_at)
    preview.close(); stages.push('populated legacy preview columns migrate before indexes')

    const roots = [path.join(directory, 'root-a'), path.join(directory, 'root-b')]
    for (const folder of roots) await fsp.mkdir(folder)
    const readCounts = new Map(), caches = roots.map(fixtureCache)
    let failed = true, cancel = true
    const localLoad = loader({ [abs('src/main/folders/folderCacheRootAvailabilityRuntime.ts')]: {
      filterFolderCacheAvailableRoots: async folders => ({ folders, skippedFolders: [], configuredFolders: folders }) },
      [abs('src/main/indexing/root-index/sharedIndexTrustRuntime.ts')]: { createSharedIndexTrustRuntime: () => ({ inspectSharedIndexTrust: async folder => ({ trusted: true, activeDbPath: folder + '.sqlite' }) }) } })
    const { SharedIoProcessError } = localLoad('src/main/path/sharedIoProcessRuntime.ts')
    const folderCache = localLoad('src/main/folders/folderCacheRuntime.ts').createFolderCacheRuntime({ fontScanCacheVersion: 1, sharedFontMemoryCacheTtlMs: 30000,
      exists: async () => true, rootCacheDir: value => value, rootIndexDbPath: folder => folder + '.sqlite',
      readRootIndexSqliteFile: async (_file, folder) => {
        readCounts.set(folder, (readCounts.get(folder) || 0) + 1)
        if (folder === roots[1] && failed) { failed = false; throw cancel ? new SharedIoProcessError('cancelled', 'not-started', 'query-superseded') : Object.assign(Error('denied'), { code: 'EACCES' }) }
        return caches[roots.indexOf(folder)]
      }, applySharedMetadataOverlay: async (_folder, cache) => cache,
      cacheEntryRuntimePath: (folder, entry) => path.join(folder, entry), cachedFontForRuntime: (font, file) => ({ ...font, id: file, path: file }),
      appendStartupLog() {}, recoveryMessage: String, clearExternalFontQueryCaches() {} })
    await assert.rejects(() => folderCache.loadSharedFontsForFolders(roots), /cancelled/)
    assert.equal((await folderCache.loadSharedFontsForFolders(roots)).length, 2)
    assert.equal(readCounts.get(roots[0]), 2, 'Cancelled partial read became a complete cache')
    folderCache.invalidateSharedFontRuntimeCaches(); failed = true; cancel = false
    await assert.rejects(() => folderCache.loadSharedFontsForFolders(roots), /完整读取/)
    assert.equal((await folderCache.loadSharedFontsForFolders(roots)).length, 2)
    stages.push('cancelled and failed second-root hydration cannot populate complete memory cache')

    const rootLoad = loader({ [abs('src/main/rust-core/rustSharedIoCommandRuntime.ts')]: { sharedIoResourceKeys: async () => [] } })
    const rootRuntime = rootLoad('src/main/indexing/rootIndexRuntime.ts').createRootIndexRuntime({ appName: 'HFM', fontScanCacheVersion: 1, scriptDetectionVersion: 1,
      exists, openStableSqliteDb: openDb, closeSqliteDb: db => db.close(), appendStartupLog() {}, withGlobalIo: async (_label, run) => run(), invalidateSharedFontRuntimeCaches() {}, recordCacheEvent: async () => {} })
    const cacheDir = path.join(roots[0], '.hfm-cache'), dbPath = path.join(cacheDir, 'database', 'index.sqlite')
    await fsp.mkdir(path.dirname(dbPath), { recursive: true }); fs.writeFileSync(dbPath, 'old-corrupt-index')
    const context = { rootPath: roots[0], cacheDir, cachePath: dbPath, storage: 'root', cache: { version: 1, entries: {}, rebuildRequired: true },
      nextEntries: caches[0].entries, seenKeys: new Set(['font.ttf']), directoryUpdates: [], directorySkipped: 0 }
    const write = rootLoad('src/main/indexing/scan-orchestrator/scanRootCacheWriteRuntime.ts').writeRootScanCacheContexts
    const deps = { fontScanCacheVersion: 1, appendStartupLog() {}, saveScanCacheFile: (file, cache, folder, storage) => rootRuntime.saveRootIndexSqliteFile(file, folder, storage, cache) }
    await write(deps, {}, [context], [{ path: roots[0], message: 'denied subtree' }])
    assert.equal(fs.readFileSync(dbPath, 'utf8'), 'old-corrupt-index')
    assert.equal(await exists(path.join(cacheDir, 'database', 'index.latest.json')), false)
    await write(deps, {}, [context], [])
    const active = await rootRuntime.resolveActiveRootIndexDbPath(cacheDir, dbPath)
    assert.notEqual(active, dbPath)
    assert.equal(fs.readFileSync(dbPath, 'utf8'), 'old-corrupt-index')
    assert.equal(Object.keys((await rootRuntime.readRootIndexSqliteFile(active, roots[0], 'root')).entries).length, 1)
    stages.push('partial recovery retains old DB; complete production scan publication validates and switches immutable snapshot')
    const cancellation = new AbortController(), scope = rootLoad('src/main/path/sharedFileSystemRuntime.ts')
    let releaseWrite, enteredWrite
    const entered = new Promise(resolve => { enteredWrite = resolve }), gate = new Promise(resolve => { releaseWrite = resolve })
    const pointer = path.join(directory,'guarded-pointer.json'); await fsp.writeFile(pointer,'old-pointer')
    const atomicLoad = loader({ [abs('src/main/path/sharedFileSystemRuntime.ts')]: { ...scope, sharedFileSystem: { ...fsp,
      writeFile: async (...args) => { const result = await fsp.writeFile(...args); enteredWrite(); await gate; return result },
    } } })
    const writing = scope.withSharedIoSignal(cancellation.signal, () => atomicLoad('src/main/indexing/root-index/rootIndexFileRuntime.ts').writeJsonAtomic(pointer,{active:'candidate'}))
    await entered; cancellation.abort('user cancelled candidate'); releaseWrite()
    await assert.rejects(writing,/cancel/i)
    assert.equal(fs.readFileSync(pointer,'utf8'),'old-pointer')
    for (const code of ['EACCES','EPERM']) {
      const failing = loader({ [abs('src/main/path/sharedFileSystemRuntime.ts')]: { ...scope, sharedFileSystem: { ...fsp,
        rename: async () => { throw Object.assign(Error(code),{code}) },
      } } })
      await assert.rejects(failing('src/main/indexing/root-index/rootIndexFileRuntime.ts').writeJsonAtomic(pointer,{active:'denied'}),new RegExp(code))
      assert.equal(fs.readFileSync(pointer,'utf8'),'old-pointer')
    }
    stages.push('cancellation and denied atomic rename retain the last-good active pointer')


    const oldMerged = path.join(directory, 'merged-index.sqlite'); fs.writeFileSync(oldMerged, 'old-derived')
    let rebuilds = 0
    const recoveryModule = load('src/main/indexing/mergedIndexRecoveryRuntime.ts')
    function recovery(fault = '') {
      const owner = recoveryModule.createMergedIndexRecoveryRuntime({ defaultPath: oldMerged, open: file => {
        if (fault === 'locked' && file === oldMerged) throw Object.assign(Error('locked'), { code: 'SQLITE_BUSY' })
        return openDb(file)
      }, close: db => db.close(), log() {}, initialize: db => { db.exec('CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE IF NOT EXISTS entries(id TEXT PRIMARY KEY)') } })
      owner.setRebuild(async db => { rebuilds++; if (fault === 'offline') throw Error('offline'); db.exec("INSERT INTO entries VALUES('verified'); INSERT INTO meta VALUES('sourcesKey','[{\"root\":\"complete\"}]')") })
      return owner
    }
    await assert.rejects(() => recovery('locked').open(), /locked/)
    assert.equal(rebuilds, 0)
    await assert.rejects(() => recovery('offline').open(), /offline/)
    assert.equal(fs.readFileSync(oldMerged, 'utf8'), 'old-derived')
    assert.equal(await exists(`${oldMerged}.active.json`), false)
    const owner = recovery(); const recovered = await owner.open(); assert.equal(recovered.prepare('SELECT COUNT(*) n FROM entries').get().n, 1); recovered.close()
    assert.equal(fs.readFileSync(oldMerged, 'utf8'), 'old-derived')
    const before = rebuilds; const reopened = await recovery().open(); reopened.close(); assert.equal(rebuilds, before, 'restart rebuilt compatible snapshot')
    const selected = await recoveryModule.resolveMergedIndexDbPath(oldMerged); await fsp.unlink(selected)
    const repairedMissing = await recovery().open(); assert.equal(repairedMissing.prepare('SELECT COUNT(*) n FROM entries').get().n, 1); repairedMissing.close()
    stages.push('merged corruption/offline/locks, retained originals, missing-pointer-target and restart convergence')
    const pendingApp = openDb(path.join(directory,'pending-favorites.sqlite')); migrateApp(pendingApp)
    let snapshotReady = false
    const favorites = load('src/main/library/runtime/localFontFavoritesRuntime.ts').createLocalFontFavoritesRuntime({
      openLibraryDb: async()=>pendingApp, invalidate(){}, appendLog(){}, loadLegacyLocalSnapshot: async()=>{
        if(!snapshotReady)throw Object.assign(Error('derived unavailable'),{code:'SQLITE_CORRUPT'})
        return [{...fixtureFont(path.join(roots[0],'favorite.ttf')),favorite:true}]
      } })
    await favorites.initialize()
    assert.equal(pendingApp.prepare("SELECT value FROM meta WHERE key='localFavoritesMigrated'").get(),undefined)
    snapshotReady=true;await favorites.initialize()
    assert.equal(pendingApp.prepare('SELECT COUNT(*) n FROM local_font_favorites').get().n,1)
    pendingApp.close()
    stages.push('deferred favorite migration cannot deadlock derived recovery or mark unreadable history complete')


    const placeholder = { ...fixtureFont(path.join(roots[0], 'missing.ttf'), 'missing:historical'), fileSize: 0,
      recoveryPlaceholder: true, fileAvailability: 'missing', localTagNames: ['模板'] }
    const renderer = loader({ [abs('src/renderer/src/constants/environmentConstants.ts')]: { RENDERER_ENV: { DEV: false, PROD: true }, IS_DEVELOPMENT: false } })
    assert.equal(renderer('src/renderer/src/library-normalize/libraryNormalizeBase.ts').isDefinitelyBadFontRecord(placeholder), false)
    assert.equal(renderer('src/renderer/src/library-normalize/libraryNormalizeBase.ts').isDefinitelyBadFontRecord({ ...placeholder, recoveryPlaceholder: false }), true)
    const admit = load('src/main/ipc/sharedActionAdmissionRuntime.ts').createSharedActionAdmission()
    for (const channel of ['fonts:installSystem', 'fonts:uninstallSystem', 'fonts:activateFont', 'fonts:deleteFiles', 'fonts:moveFilesToFolder']) {
      await assert.rejects(() => admit(channel, [[placeholder]]), /历史字体记录/)
    }
    await admit('fonts:relinkTagFont', [placeholder])
    let clears = 0, refresh = 0
    renderer('src/renderer/src/databaseDerivedStateRuntime.ts').refreshDatabaseDerivedStateRuntime({ timerRef: { current: null }, clearTimeout,
      databasePageRequestSeqRef: { current: 1 }, fontMetricsRequestSeqRef: { current: 1 }, setDatabasePageResult: () => clears++,
      setDatabaseQueryResult: () => clears++, setDatabaseFontMetrics: () => clears++, setDatabaseRefreshToken: update => { refresh = update(refresh) } })
    assert.equal(clears, 0); assert.equal(refresh, 1)
    stages.push('historical placeholder visible but physical operations rejected; same-scope page retained')
    const effects = [], loaded = { current: false }, began = { current: false }
    let writes = 0, libraryReplacements = 0
    const hookLoad = loader({ react: { useEffect: run => effects.push(run), useRef: current => ({ current }), useCallback: run => run },
      '../../../appRuntime': { markPartialLibrary: value => value, normalizeLibrary: value => value } },
      { window: { setTimeout, clearTimeout } })
    const hfm = { loadLibraryShell: async () => { throw Object.assign(Error('temporary database lock'), { code: 'SQLITE_BUSY' }) }, saveLibrary: async () => { writes++; return true } }
    hookLoad('src/renderer/src/runtime/app/effects/useInitialLibraryShellRuntime.ts').useInitialLibraryShellRuntime({ hfm,
      initialLibraryLoadStartedRef: began, libraryLoadedRef: loaded, setLibrary: () => libraryReplacements++, setStatus() {},
      setDatabasePageResult() {}, setDatabaseQueryResult() {}, setDatabaseRefreshToken() {} })
    effects.shift()(); await new Promise(resolve => setImmediate(resolve))
    assert.equal(loaded.current, false); assert.equal(libraryReplacements, 0)
    hfm.loadLibraryShell = async () => ({ folders: roots })
    const autosave = hookLoad('src/renderer/src/runtime/app/effects/useLibraryAutosaveRuntime.ts').useLibraryAutosaveRuntime({ hfm,
      library: { folders: [], tags: [], fonts: {} }, libraryShellSaveKey: 'empty', libraryLoadedRef: loaded, setLibrary() {}, setStatus() {} })
    for (const run of effects.splice(0)) run()
    await autosave.saveLibraryImmediately({ folders: [], tags: [], fonts: {} })
    await autosave.flushLibraryPersistence()
    assert.equal(writes, 0, 'Failed initial load enabled empty profile autosave after DB became writable')
    stages.push('failed initial profile load cannot autosave empty state when database becomes writable')

    console.log(JSON.stringify({ ok: true, stages }, null, 2))
  } finally { await fsp.rm(directory, { recursive: true, force: true }) }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
