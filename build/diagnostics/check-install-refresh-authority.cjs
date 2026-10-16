'use strict'
// Windows-only integration diagnostic. Persistence, signatures, revision admission,
// candidate enumeration and local projection execute production TypeScript.
// Only OS/font evidence and unrelated scheduling boundaries are isolated.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { createHash } = require('node:crypto')
const root = path.resolve(__dirname, '../..')
const at = relative => path.join(root, relative)

function loader(stubs) {
  const ts = require('typescript')
  const cache = new Map()
  function load(file) {
    file = path.resolve(file)
    if (Object.hasOwn(stubs, file)) return stubs[file]
    if (cache.has(file)) return cache.get(file).exports
    const module = { exports: {} }
    cache.set(file, module)
    const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    }).outputText
    vm.runInThisContext(`(function(require,module,exports){${code}\n})`, { filename: file })(id => {
      if (Object.hasOwn(stubs, id)) return stubs[id]
      return id.startsWith('.') ? load(path.resolve(path.dirname(file), id + '.ts')) : require(id)
    }, module, module.exports)
    return module.exports
  }
  return relative => load(at(relative))
}
function deferred() {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}
async function checkWorkerAdmissionGuard() {
  const { EventEmitter } = require('node:events')
  const scriptGate = deferred(), scriptEntered = deferred()
  let retired = false, posted = 0
  class FixtureWorker extends EventEmitter {
    postMessage(message) {
      posted++
      // Let an unfixed implementation settle instead of hanging the diagnostic.
      queueMicrotask(() => this.emit('message', { id: message.id, ok: true, result: { written: 1, groups: 1 } }))
    }
    async terminate() { return 0 }
  }
  const load = loader({
    'node:fs': { promises: { mkdir: async () => {}, writeFile: async () => { scriptEntered.resolve(); await scriptGate.promise } } },
    'node:worker_threads': { Worker: FixtureWorker },
    [at('src/main/db/query-worker/dbQueryWorkerConstants.ts')]: { DB_QUERY_WORKER_IDLE_TIMEOUT_MS: 60000, DB_QUERY_WORKER_VERSION: 'fixture' },
    [at('src/main/db/query-worker/dbQueryWorkerPayloadSummary.ts')]: { summarizeDbWorkerPayload: () => 'fixture' },
    [at('src/main/db/query-worker/dbQueryWorkerSourceRuntime.ts')]: { buildDbQueryWorkerSource: () => '' },
    [at('src/main/app/shutdownCoordinatorRuntime.ts')]: { isApplicationClosing: () => false, applicationWorkEpoch: () => 1 },
    [at('src/main/rust-core/rustSharedIoCommandRuntime.ts')]: {},
    [at('src/main/path/sharedPathProbeRuntime.ts')]: {},
    [at('src/main/path/ioDeadlineRuntime.ts')]: {},
  })
  const guards = load('src/main/path/startupPathAvailabilityRuntime.ts')
  const client = load('src/main/db/query-worker/dbQueryWorkerClientRuntime.ts').createDbQueryWorkerClientRuntime({
    dataPath: (...parts) => path.win32.join('C:\\hfm-fixture', ...parts), appendStartupLog() {},
  })
  try {
    const pending = guards.withStartupPathRootGuard(() => { if (retired) throw Error('fixture root retired') },
      () => client.saveInstallStatusIndex({ groups: [] }))
    const rejected = assert.rejects(pending, /fixture root retired/)
    await scriptEntered.promise
    retired = true
    scriptGate.resolve()
    await rejected
    assert.equal(posted, 0, 'retired roots must not reach worker postMessage after async worker startup')
  } finally { client.shutdown() }
}
async function main() {
  assert.equal(process.platform, 'win32', 'This diagnostic must run on Windows')
  const { DatabaseSync } = require('node:sqlite')
  const machine = new DatabaseSync(':memory:')
  const merged = new DatabaseSync(':memory:')
  const folder = '\\\\fixture-nas\\fonts\\library'
  const logs = []
  let generation = 1
  let unavailablePath = null
  let identityGate = null
  const unexpected = () => { throw Error('Unexpected root/source reconciliation or filesystem access') }
  const load = loader({
    'node:fs': { promises: { readFile: async () => '{"cacheId":"diagnostic-machine"}', mkdir: async () => {} } },
    [at('src/main/rust-core/nodeStateFallbackCompatibilityRuntime.ts')]: {
      nodeStateFallbackCompatibilityAllowed: () => true,
      logNodeStateFallbackDisabled() {}, logNodeStateFallbackUsed() {}, nodeStateFallbackDeniedMessage: () => 'denied',
    },
    [at('src/main/path/sharedIoProcessRuntime.ts')]: { rethrowSharedIoProcessError() {} },
    [at('src/main/path/sharedIoCancellationRuntime.ts')]: { assertSharedIoActive() {}, rethrowSharedIoCancellation() {} },
    [at('src/main/path/sharedFileSystemRuntime.ts')]: { withSharedIoPriority: (_, run) => run(), withoutSharedIoSignal: run => run() },
    [at('src/main/path/startupPathAvailabilityRuntime.ts')]: {
      getStartupPathRootState: root => ({ rootId: root, generation: 1, state: 'online' }),
      withStartupPathRootGuard: async (guard, run) => { guard(); return run() },
    },
    [at('src/main/watcher/folderWatcherRegistrationRuntime.ts')]: { currentFolderWatcherRegistrationGeneration: () => generation },
    [at('src/main/app/shutdownCoordinatorRuntime.ts')]: { applicationWorkEpoch: () => 1, assertApplicationOpen() {} },
    [at('src/main/library/fontQueryTaskRuntime.ts')]: { assertFontQueryActive() {} },
    [at('src/main/indexing/merged-page/mergedIndexInstallAuthorityRuntime.ts')]: { migrateMergedInstallAuthority: unexpected },
    [at('src/main/indexing/merged-page/mergedIndexProjectionFailureRuntime.ts')]: { settleMergedSyncError: unexpected },
    [at('src/main/indexing/merged-page/mergedIndexSharedMetadataExternalCheckRuntime.ts')]: {},
    [at('src/main/indexing/root-query/rootIndexQuerySharedSql.ts')]: {},
    [at('src/main/install/refresh/installRefreshSnapshotEvidenceRuntime.ts')]: { assertInstallSnapshotNamesCurrent: async () => {} },
    [at('src/main/install/fontInstallEvidenceRuntime.ts')]: {
      createFontInstallEvidenceSession: () => ({
        read: async file => {
          if (file === unavailablePath) throw Error('temporary EIO')
          return { path: file, size: 4, modified: 1, sha256: 'a'.repeat(64) }
        },
        confirm: async item => ({ known: true, installed: !item.fileName.startsWith('stale-'), by: item.fileName.startsWith('stale-') ? 'none' : 'user', matches: [] }),
      }),
    },
  })
  const { fileRuntimeFontId } = load('src/main/fonts/fontFileIdentity.ts')
  const { normalizePathForCacheCompare } = load('src/main/path/cachePath.ts')
  const makeItem = name => {
    const file = path.win32.join(folder, name)
    return { id: fileRuntimeFontId(file, 4, 1), path: file, fileName: name, fileSize: 4, modifiedAt: 1, family: 'Fixture', active: false }
  }
  const items = [...Array.from({ length: 11 }, (_, i) => makeItem(`missing-${i}.ttf`)), makeItem('stale-0.ttf'), makeItem('stale-1.ttf')]
  const untouched = makeItem('untouched.ttf')
  const population = [...items, untouched]
  const itemsById = new Map(population.map(item => [item.id, item]))
  const getMeta = (db, key) => db.prepare('SELECT value FROM meta WHERE key=?').get(key)?.value
  const setMeta = (db, key, value) => db.prepare('INSERT OR REPLACE INTO meta VALUES(?,?)').run(key, value)
  const status = load('src/main/install/installStatusRuntime.ts').createInstallStatusRuntime({
    dataPath: (...parts) => path.win32.join('C:\\hfm-fixture', ...parts),
    rootCacheDir: unexpected, cacheIdentityPath: () => 'fixture-identity.json',
    ensureCacheIdentity: async () => { if (identityGate) { const gate = identityGate; identityGate = null; gate.entered.resolve(); await gate.release.promise } },
    appWatchedFolders: async () => [folder], findBestWatchedRootForFile: () => folder,
    openStableSqliteDb: (_, label) => { assert(label.startsWith('machine-install:')); return machine },
    closeSqliteDb() {}, getSqliteMeta: getMeta, setSqliteMeta: setMeta,
    parseSqliteJson: (value, fallback) => { try { return JSON.parse(value) } catch { return fallback } },
    exists: async () => true, sha1: value => createHash('sha1').update(value).digest('hex'), normalizePathForCacheCompare,
    isCleanWindowsDefaultCompareResult: () => false, completeBackgroundTask: async () => {}, appendStartupLog: line => logs.push(line),
  })
  status.initializeMachineInstallDb(machine, 'local-fallback')
  const insertStatus = machine.prepare('INSERT INTO install_status(font_id,signature,installed,by_type,matches_json) VALUES(?,?,?,?,?)')
  for (const item of items.slice(11)) insertStatus.run(item.id, 'content-v1:stale-signature', 1, 'user', '[]')
  insertStatus.run(untouched.id, status.installStatusSignature(untouched), 1, 'user', '[]')
  const initial = await status.readInstallStatusIndex(population)
  assert.equal(initial.misses.length, 13)
  assert.equal(Object.values(initial.missingReasons).filter(reason => reason === 'missing-row').length, 11)
  assert.equal(Object.values(initial.missingReasons).filter(reason => reason === 'signature-mismatch').length, 2)

  merged.exec(`CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT);
    CREATE TABLE sources(root_path TEXT PRIMARY KEY,index_db_path TEXT,index_signature TEXT,install_signature TEXT,shared_metadata_signature TEXT);
    CREATE TABLE entries(root_path TEXT,relative_path TEXT,file_size INTEGER,modified_at REAL,status TEXT,font_json TEXT,is_deleted INTEGER,
      installed INTEGER,installed_by TEXT,matches_json TEXT,PRIMARY KEY(root_path,relative_path));`)
  const sources = [{ root: folder, indexDbPath: folder + '\\index.sqlite', indexSignature: 'root-v3|1', installSignature: 'content-signature-v1|old', sharedMetadataSignature: 'metadata-v2|1' }]
  merged.prepare('INSERT INTO sources VALUES(?,?,?,?,?)').run(folder, sources[0].indexDbPath, sources[0].indexSignature, sources[0].installSignature, sources[0].sharedMetadataSignature)
  setMeta(merged, 'schemaVersion', '7'); setMeta(merged, 'sourcesKey', JSON.stringify(sources)); setMeta(merged, 'startupReady', '1')
  const insertEntry = merged.prepare('INSERT INTO entries VALUES(?,?,?,?,?,?,0,?,?,?)')
  for (const item of population) insertEntry.run(folder, item.fileName, 4, 1, 'ok', JSON.stringify(item), item === untouched ? 1 : null, item === untouched ? 'user' : null, item === untouched ? '[]' : null)
  const invariant = () => ({
    population: merged.prepare('SELECT root_path,relative_path,file_size,modified_at,status,font_json,is_deleted FROM entries ORDER BY relative_path').all(),
    sources: merged.prepare('SELECT * FROM sources ORDER BY root_path').all(), meta: merged.prepare('SELECT * FROM meta ORDER BY key').all(),
  })
  const before = invariant()
  let commits = 0
  const ctx = {
    schemaVersion: 7, getSqliteMeta: getMeta, setSqliteMeta: setMeta,
    sqliteTableExists: (db, name) => !!db.prepare('SELECT name FROM sqlite_master WHERE name=?').get(name),
    mergedIndexSourcesKey: JSON.stringify, mergedIndexRootsKey: roots => JSON.stringify([...roots].sort()), normalizePathForCacheCompare,
    appWatchedFolders: async () => [folder], openMergedIndexDb: async () => merged, closeSqliteDb() {},
    mergedIndexLocalSnapshotUsable: () => getMeta(merged, 'startupReady') === '1',
    pathInsideFolder: (root, file) => file.startsWith(root + '\\'), fontFromRootIndexPageRow: (_, row) => JSON.parse(row.font_json),
    runMergedIndexMutation: async (_, run) => run({ commit: () => { commits++ } }), appendStartupLog: line => logs.push(line),
    readInstallStatusForProjection: async requested => {
      const snapshot = await status.readInstallStatusIndex(requested)
      return requested.map(item => {
        const result = snapshot.results[item.id]
        return { ...item, installStatusKnown: !!result, active: result?.by === 'managed' || result?.by === 'both',
          systemInstalled: !!result?.installed && result.by !== 'managed', systemInstallMatches: result?.matches || [] }
      })
    },
  }
  const snapshot = load('src/main/indexing/merged-page/mergedIndexInstallCandidateRuntime.ts').createMergedIndexInstallCandidateRuntime(ctx)
  const validation = load('src/main/indexing/merged-page/mergedIndexValidationRuntime.ts').createMergedIndexValidationRuntime(ctx, {}, {})
  const writer = load('src/main/install/status/installStatusProjectionWriteRuntime.ts').createInstallStatusProjectionWriteRuntime({
    saveInstallStatusIndex: status.saveInstallStatusIndex,
    syncMergedIndexAfterInstallStatusRefresh: (roots, requested, options) => validation.syncMergedIndexAfterInstallStatusRefresh(roots, unexpected, requested, undefined, options),
  })
  let refreshAdmission = null
  const runner = load('src/main/install/refresh/installStatusRefreshRunner.ts').createInstallStatusRefreshRunner({
    ...status, ...writer,
    saveInstallStatusIndex: (...args) => { const pending = writer.saveInstallStatusIndex(...args); refreshAdmission?.resolve(); return pending },
    appWatchedFolders: async () => [folder], loadSharedFontsForFolders: async () => { throw Error('root index temporarily malformed') },
    readInstallRefreshSnapshot: snapshot.readInstallRefreshSnapshot,
    saveInstalledTotalSummaryForRoots: unexpected, readInstalledTotalSummaryForRoots: unexpected,
    getSystemInstalledFontsCached: async () => [], buildInstalledFontLookupIndex: () => ({}),
    compareFontInstalledWithLookupIndex: () => ({ installed: false, by: 'none', matches: [] }),
    emitInstallStatusProgress() {}, waitForRendererIdle: async () => {}, delayToEventLoop: async () => {}, withGlobalIo: (_, run) => run(), appendStartupLog: line => logs.push(line),
  }, { installStatusRefreshBatchSize: 20, lightweightMissingThreshold: 32, readSystemInstalledFontsLightweight: async () => [] })
  const repaired = await runner.refreshInstallStatusIndex({}, { emitProgress: false })
  assert.equal(repaired.scope, 'snapshot'); assert.equal(repaired.total, 14); assert.equal(repaired.updatedCount, 13)
  assert.equal(repaired.installedCount, 12); assert.equal(repaired.notInstalledCount, 2); assert.equal(repaired.missingCount, 0)
  assert.equal((await status.readInstallStatusIndex(population)).misses.length, 0)
  assert.equal(machine.prepare('SELECT count(*) AS n FROM install_status').get().n, 14)
  const projected = merged.prepare('SELECT installed,installed_by FROM entries WHERE relative_path<>?').all(untouched.fileName)
  assert.equal(projected.filter(row => row.installed === 1 && row.installed_by === 'user').length, 11)
  assert.equal(projected.filter(row => row.installed === 0 && row.installed_by === 'none').length, 2)
  assert.equal(commits, 1); assert.deepEqual(invariant(), before)

  // A transient evidence read failure stays unknown in both real stores.
  unavailablePath = items[0].path
  const partial = await runner.refreshInstallStatusIndex({ force: true }, { emitProgress: false })
  assert.equal(partial.missingCount, 1); assert.equal(partial.notInstalledCount, 2)
  const unknown = await status.readInstallStatusIndex([items[0]])
  assert.equal(unknown.missingReasons[items[0].id], 'explicit-unknown')
  assert(machine.prepare('SELECT signature FROM install_status WHERE font_id=?').get(items[0].id).signature.startsWith('unknown:content-v1:'))
  assert.equal(merged.prepare('SELECT installed FROM entries WHERE relative_path=?').get(items[0].fileName).installed, null)
  assert.deepEqual(invariant(), before)
  unavailablePath = null
  const recovered = await runner.refreshInstallStatusIndex({}, { emitProgress: false })
  assert.equal(recovered.updatedCount, 1); assert.equal(recovered.missingCount, 0)

  // Hold the real machine write lane across asynchronous identity IO. A newer
  // foreground reservation must win over an older refresh revision in the queue.
  const expectedRevision = status.installStatusWriteRevision()
  const newerItem = items[1]
  const gate = { entered: deferred(), release: deferred() }; identityGate = gate
  const newer = status.saveInstallStatusIndex({ [newerItem.id]: { installed: false, by: 'none', matches: [] } }, itemsById)
  await gate.entered.promise
  let admitted = null
  const stale = status.saveInstallStatusIndex({ [newerItem.id]: { installed: true, by: 'user', matches: [] } }, itemsById, { expectedRevision, onPersisted: ids => { admitted = ids } })
  gate.release.resolve(); await newer; await stale
  assert.equal(admitted, null)
  assert.equal((await status.readInstallStatusIndex([newerItem])).results[newerItem.id].installed, false)
  await validation.syncMergedIndexAfterInstallStatusRefresh([], unexpected, [newerItem], undefined, { preserveSourceCheckpoint: true })
  assert.equal(merged.prepare('SELECT installed FROM entries WHERE relative_path=?').get(newerItem.fileName).installed, 0)

  // Registration changes after enqueue must abort before touching SQLite, even
  // though the queue itself remains healthy after the rejection.
  const gate2 = { entered: deferred(), release: deferred() }; identityGate = gate2
  const blocker = status.saveInstallStatusIndex({ [untouched.id]: { installed: true, by: 'user', matches: [] } }, itemsById)
  await gate2.entered.promise
  const targetRows = () => machine.prepare('SELECT * FROM install_status WHERE font_id<>? ORDER BY font_id').all(untouched.id)
  const targetBefore = targetRows()
  refreshAdmission = deferred()
  const queued = runner.refreshInstallStatusIndex({ force: true }, { emitProgress: false })
  const rejected = assert.rejects(queued, /install-refresh-root-registration-changed/)
  await refreshAdmission.promise
  generation++; gate2.release.resolve(); await blocker; await rejected
  refreshAdmission = null
  assert.deepEqual(targetRows(), targetBefore)
  assert.deepEqual(invariant(), before)
  assert(logs.some(line => line.includes('stale refresh rows skipped')))
  assert(logs.some(line => line.includes('changed=13')))
  machine.close(); merged.close()
  await checkWorkerAdmissionGuard()
  console.log('install refresh authority: passed (production SQLite, 11 missing + 2 stale, unknown recovery, revision and registration guards)')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
