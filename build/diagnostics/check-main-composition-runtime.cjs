#!/usr/bin/env node
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')
const { createHarness, observeBootstrap, root, entry, bootstrap } = require('./helpers/mainCompositionHarness.cjs')
const fixture = require('./fixtures/main-composition-runtime.fixture.json')
const compositionFile = owner => path.join(bootstrap, `main${owner}CompositionRuntime.ts`)

function reviewedBootstrapObservations() {
  const expected = structuredClone(fixture.observations)
  const calls = expected.flows.externalChange.calls.filter(call => call[0] === 'createFolderCacheRuntime.invalidateSharedFontRuntimeCaches')
  assert.equal(calls.length, 1, 'reviewed source-cache forwarding fixture drifted')
  assert.deepEqual(calls[0][1], [], 'historical source-cache default contract changed')
  // The default publication path is unchanged; its previously implicit true
  // is now explicitly forwarded beside the new source-only checkpoint path.
  calls[0][1] = [true]
  // Reviewed lifecycle addition: a local configuration/probe owner starts only
  // after cache initialization and is awaited beside the existing watcher.
  assert(!expected.owners.some(([name]) => name === 'createSharedAvailabilityProbeScheduler'))
  expected.owners.push(['createSharedAvailabilityProbeScheduler', 1]); expected.owners.sort()
  // Reviewed private source-recovery owner: no new IPC registration or change
  // to historical flow observations; the watcher receives its readiness port.
  assert(!expected.owners.some(([name]) => name === 'createRootIndexSourceRecoveryRuntime'))
  expected.owners.push(['createRootIndexSourceRecoveryRuntime', 1]); expected.owners.sort()
  assert.equal(expected.construction[0][0], 'createMigrationDiagnosticsRuntime.logStartupPolicy')
  expected.construction.splice(1, 0, ['onApplicationClosing', ['<function>']], ['onApplicationResumed', ['<function>']])
  const lifecycle = expected.flows.lifecycle.calls
  const initialized = lifecycle.findIndex(call => call[0] === 'createCacheArchitectureRuntime.initializeCacheArchitectureV2')
  assert.deepEqual(lifecycle[initialized][1], ['fixture'])
  lifecycle[initialized][1] = []
  lifecycle.splice(initialized + 1, 0, ['createSharedAvailabilityProbeScheduler.start', []])
  const watcherClose = lifecycle.find(call => call[0] === 'createFolderWatcherRuntime.awaitFolderWatchersClosed')
  assert.deepEqual(watcherClose[1], ['fixture']); watcherClose[1] = []
  return expected
}
const expectedObservations = reviewedBootstrapObservations()

async function checkAvailabilityAndMaintenanceWiring(overrides = new Map()) {
  const h = createHarness(overrides); h.load(entry)
  const data = h.compositions.get('createMainDataCompositionRuntime')
  const storage = h.compositions.get('createMainDataStorageCompositionRuntime')
  const statusOpen = h.options('createSharedAvailabilityReader')
  assert.equal(statusOpen, storage.openLibraryDbLocal, 'status reader reaches the migration-capable DB wrapper')
  assert.equal(statusOpen.fixtureOperation, 'library.open')
  h.failOperations.add('createLocalFontFavoritesRuntime.initialize')
  h.reset(); await statusOpen()
  assert.deepEqual(h.calls, [['library.open', []]], 'status DB accessor performs nonlocal migration work')
  h.reset()
  assert.deepEqual(h.clean(await h.options('createSharedAvailabilityProbeScheduler').readRoots()), ['/fonts'])
  assert.deepEqual(h.calls, [['library.open', []]], 'probe configuration read canonicalizes or migrates configured roots')
  h.scanActive = false; h.installRefreshActive = false
  const maintenance = h.options('createApplicationDatabaseMaintenanceRuntime').isForegroundBusy
  assert.equal(h.options('createSharedMetadataFrontendDiagnosticsRuntime').isForegroundBusy, maintenance)
  assert.equal(maintenance(), false, 'idle composition prevents optional work')
  for (const key of ['rendererUserActive', 'scanActive', 'installRefreshActive', 'previewActive', 'previewPending', 'rustInteractive']) {
    h[key] = true; assert.equal(maintenance(), true, `maintenance misses ${key}`); h[key] = false
  }
  assert.equal(maintenance(), false)
  h.reset(); h.resumedListeners.forEach(listener => listener())
  assert(!h.calls.some(call => call[0] === 'createSharedAvailabilityProbeScheduler.start'), 'resume bypassed cache initialization')
  await data.lifecycle.initializeCacheArchitecture()
  assert(h.calls.some(call => call[0] === 'createSharedAvailabilityProbeScheduler.start'))
  let close; h.availabilityCloseGate = new Promise(resolve => { close = resolve })
  h.closingListeners.forEach(listener => listener())
  let settled = false
  const pending = h.payload.awaitFolderWatchersClosed().then(() => { settled = true })
  try {
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(settled, false, 'shutdown stopped waiting before availability probe physical close')
    h.resumedListeners.forEach(listener => listener())
  } finally { close(); await pending }
  assert.equal(settled, true)
}

async function checkAvailabilityAndMaintenanceMutations() {
  const mutations = [
    [compositionFile('Data'), 'createSharedAvailabilityReader(storage.openLibraryDbLocal)', 'createSharedAvailabilityReader(openLibraryDb)'],
    [compositionFile('Data'), 'const db = await storage.openLibraryDbLocal() as', 'const db = await storage.openLibraryDb() as'],
    [path.join(bootstrap, 'mainApplicationRuntime.ts'), 'await data.resources.awaitSharedAvailabilityProbesClosed();', 'void data.resources.awaitSharedAvailabilityProbesClosed();'],
    [compositionFile('Operations'), '|| (preview?.active || 0) > 0 || (preview?.pending || 0) > 0', ''],
    [compositionFile('Operations'), '|| rustCoreWorkerRuntime.hasRustCoreInteractiveWork()', ''],
  ]
  for (const [file, before, after] of mutations) {
    const source = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n')
    assert.equal(source.split(before).length, 2, 'availability/maintenance mutation anchor drifted: ' + before)
    await assert.rejects(() => checkAvailabilityAndMaintenanceWiring(new Map([[file, source.replace(before, after)]])), undefined, 'availability/maintenance mutation escaped: ' + before)
  }
  return mutations.length
}

async function checkCheckpointCacheWiring(overrides = new Map()) {
  const h = createHarness(overrides)
  h.load(entry)
  const storage = h.compositions.get('createMainDataStorageCompositionRuntime')
  h.reset()
  storage.invalidateSharedFontRuntimeCaches(false)
  assert.deepEqual(h.calls, [['createFolderCacheRuntime.invalidateSharedFontRuntimeCaches', [false]]], 'checkpoint advanced a query generation or lost source-cache eviction')
  const fullPublication = expectedObservations.flows.externalChange.calls.slice(1, -1)
  for (const args of [[], [true]]) {
    h.reset()
    storage.invalidateSharedFontRuntimeCaches(...args)
    assert.deepEqual(h.calls, fullPublication, 'default or explicit publication lost the original full invalidation')
  }
}

async function checkCheckpointCacheMutations() {
  const file = compositionFile('DataStorage')
  const source = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n')
  const mutations = [
    ['if (invalidateQueries) clearFontQueryCaches();', 'clearFontQueryCaches();'],
    ['invalidateSharedFontRuntimeCaches(invalidateQueries);', 'invalidateSharedFontRuntimeCaches(true);'],
    ['function invalidateSharedFontRuntimeCaches(invalidateQueries = true)', 'function invalidateSharedFontRuntimeCaches(invalidateQueries = false)'],
  ]
  for (const [before, after] of mutations) {
    assert.equal(source.split(before).length, 2, 'checkpoint wiring mutation anchor drifted')
    await assert.rejects(() => checkCheckpointCacheWiring(new Map([[file, source.replace(before, after)]])), undefined, 'checkpoint wiring mutation escaped: ' + before)
  }
  return mutations.length
}

async function checkImportAndOwnership(overrides = new Map()) {
  const h = createHarness(overrides)
  for (const owner of ['Core', 'Data', 'DataStorage', 'DataQuery', 'Mutation', 'Operations', 'Maintenance', 'Scan']) h.load(compositionFile(owner))
  assert.equal(h.constructors.size, 0, 'import constructed a domain runtime')
  assert.equal(h.compositions.size, 0, 'import constructed a composition')
  assert.deepEqual(h.calls, [], 'import opened resources or scheduled work')
  h.load(entry)
  const data = h.compositions.get('createMainDataCompositionRuntime')
  const storage = h.compositions.get('createMainDataStorageCompositionRuntime')
  const query = h.compositions.get('createMainDataQueryCompositionRuntime')
  const restorePaths=h.options('createSqliteRuntime').applicationDatabasePaths
  assert.equal(typeof restorePaths,'function','RESTORE_PATH_GATE: persistent restore admission paths were not wired')
  assert.deepEqual(h.clean(restorePaths()), ['librarySqlitePath','tasksSqlitePath','previewSqlitePath','kvsSqlitePath','eventsSqlitePath','hashSqlitePath','metricsSqlitePath'].map(key=>storage[key]()), 'RESTORE_PATH_GATE: application database restore coverage drifted')
  for (const key of ['closeLibraryDb', 'closePreviewDb', 'clearLocalPreviewDbHandle', 'checkpointOpenCacheDbs', 'closeCacheDb']) {
    assert.equal(data.resources[key], storage[key], `${key} lost its single storage owner`)
  }
  assert.equal(data.capabilities.queryFontsInLibrary, query.queryFontsInLibrary)
  assert.equal(data.capabilities.rememberRelinkedFontFile, query.rememberRelinkedFontFile)
  const protection = h.options('createLocalFontProtectionRuntime')
  assert.equal(protection.openLibraryDb.fixtureOperation, 'library.open', 'protection must use the existing library connection owner')
  assert.equal(protection.watchedFolders, storage.appWatchedFolders, 'protection lost persisted root authority')
  const authority = h.options('createFontProtectionAuthorityRuntime')
  assert.equal(authority.roots, storage.fontProtectionRoots, 'destructive protection lost historical root authority')
  assert.equal(typeof h.options('createSystemFontInstallRuntime').withFontProtection, 'function', 'install/delete/uninstall lost their guard')
  assert.equal(typeof h.options('createSystemFontInstallRuntime').readUninstallActivationClaims, 'function', 'uninstall lost main-owned legacy activation claims')
  assert.equal(typeof h.options('createSystemFontInstallRuntime').openUninstallReceipts, 'function', 'uninstall lost durable receipt storage')
  assert.equal(typeof h.options('createSystemFontInstallRuntime').persistUninstallResult, 'function', 'uninstall lost the existing local projection owner')
  assert.equal(typeof h.options('createSystemFontInstallRuntime').deactivateForFileDelete, 'function', 'source deletion lost activation settlement')
  for (const key of ['setLocalFontProtection', 'clearLocalFontProtection', 'readLocalFontProtection', 'fontProtectionRoots']) {
    assert.equal(typeof storage[key], 'function', `${key} is missing`)
    assert.equal(data.storage[key], storage[key], `${key} lost its storage owner`)
  }
  h.librarySnapshot = { fonts: { a: { id: 'a', active: true, favorite: true, tagNames: ['shared'] } }, previewText: 'retained' }
  const hydrate = query.hydrateInstallStatusForFonts
  query.hydrateInstallStatusForFonts = async items => items.map(item => ({ ...item, active: false }))
  h.reset()
  const library = await data.capabilities.loadLibrary()
  query.hydrateInstallStatusForFonts = hydrate
  assert(h.calls.some(call => call[0] === 'createLibraryRuntime.loadLibrary'), 'complete load bypassed storage owner')
  assert.deepEqual(h.clean(library), { fonts: { a: { id: 'a', active: false, favorite: true, tagNames: ['shared'] } }, previewText: 'retained' }, 'complete load did not apply local activation authority')
  assert.equal(h.options('createPreviewRuntime').openPreviewDb, storage.openPreviewDb)
  assert.equal(h.options('createMainBackgroundRuntime').openRecoverableApplicationSqliteDb, storage.openRecoverableApplicationSqliteDb)
  h.cachedPage = { items: [{ id: 'a', path: 'C:\\fonts\\a.ttf', systemInstalled: false, pendingUninstall: undefined }], total: 1 }
  h.pendingUninstall = { message: 'pending after cached page' }
  let page = await query.queryFontPageInLibrary({})
  assert.equal(page.items[0].pendingUninstall.message, 'pending after cached page', 'cached page hid durable retry hint')
  h.pendingUninstall = undefined
  page = await query.queryFontPageInLibrary({})
  assert.equal(page.items[0].pendingUninstall, undefined, 'cached page revived cleared receipt')
  assert.equal(page.items[0].systemInstalled, false, 'pending hint changed installation truth')
  h.reset()
  data.resources.checkpointOpenCacheDbs()
  for (const label of ['kvs', 'events', 'hash', 'metrics']) data.resources.closeCacheDb(label)
  assert.deepEqual(h.calls, [
    ['createCacheArchitectureRuntime.checkpointOpenCacheDbs', []],
    ...['kvs', 'events', 'hash', 'metrics'].map(label => ['createCacheArchitectureRuntime.closeCacheDb', [label]]),
  ])
}

async function checkMetricsOwnerWiring(overrides = new Map()) {
  const h = createHarness(overrides)
  h.load(entry)
  const storage = h.compositions.get('createMainDataStorageCompositionRuntime')
  const query = h.compositions.get('createMainDataQueryCompositionRuntime')
  const counts = h.options('createSharedTagMetricsSnapshotRuntime')
  assert.equal(counts.roots, storage.appWatchedFolders, 'counts lost the existing persisted-root owner')
  assert.equal(typeof counts.revision, 'function', 'counts lost their revision source')
  assert.equal(typeof counts.changed, 'function', 'counts lost their invalidation callback')
  h.reset()
  await counts.read()
  assert.deepEqual(h.calls, [['createTagFontQueryRuntime.sharedTagCounts', []]], 'counts bypassed the existing binding reader')
  h.reset()
  counts.changed(7)
  assert.equal(h.calls.length, 1, 'count completion did extra query/storage work')
  assert.equal(h.calls[0][0], 'createFolderWatcherRuntime.sendFontIndexChanged', 'count notification lost the existing broadcast owner')
  const payload = h.calls[0][1][0]
  assert.equal(new Date(payload.at).toISOString(), payload.at, 'metrics event timestamp must be an ISO instant')
  assert.deepEqual({ ...payload, at: '<count-time>' }, { source: 'metrics', metricsRevision: 7, folder: '', at: '<count-time>', upserts: [], deletes: [] })
  h.reset()
  query.clearFontQueryCaches(false)
  assert(!h.calls.some(call => call[0] === 'createSharedTagMetricsSnapshotRuntime.invalidate'), 'non-cancelling projection clear retired the count owner')
  h.reset()
  await query.disposeSharedTagMetrics()
  assert.deepEqual(h.calls, [['createSharedTagMetricsSnapshotRuntime.dispose', []]], 'counts disposal lost its single owner')
}

async function checkMetricsOwnerMutations() {
  const mutations = [
    [compositionFile('Data'), 'onSharedTagCountsChanged: options.onSharedTagCountsChanged,', 'onSharedTagCountsChanged: () => undefined,'],
    [compositionFile('DataQuery'), 'roots: appWatchedFolders, revision:', 'roots: async () => [], revision:'],
    [compositionFile('DataQuery'), 'read: () => tagFonts!.sharedTagCounts(),', 'read: () => undefined,'],
    [compositionFile('DataQuery'), 'if (cancelInFlight) sharedTagMetrics.invalidate();', 'sharedTagMetrics.invalidate();'],
  ]
  for (const [file, before, after] of mutations) {
    const source = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n')
    assert.equal(source.split(before).length, 2, 'metrics ownership mutation anchor drifted: ' + before)
    await assert.rejects(() => checkMetricsOwnerWiring(new Map([[file, source.replace(before, after)]])), undefined, 'metrics ownership mutation escaped: ' + before)
  }
  return mutations.length
}

// Use the real preview connection owner, substituting only the driver/schema
// ports. The existing library-db-handle gate exercises the real library owner.
async function checkPreviewHandleOwnership() {
  const file = path.join(root, 'src/main/preview/previewDbRuntime.ts')
  const source = fs.readFileSync(file, 'utf8')
  const module = { exports: {} }
  let schemaFails = false, schemas = 0
  const code = ts.transpileModule(source, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true,
  } }).outputText
  vm.runInNewContext(code, { module, exports: module.exports, require: spec => {
    if (spec === './previewCacheRuntime') return { initializePreviewDbSchema: () => {
      schemas += 1
      if (schemaFails) throw new Error('fixture schema failure')
    } }
    if (spec.endsWith('/sharedFileSystemRuntime')) return { sharedFileSystem: fs.promises }
    if (spec.startsWith('node:')) return require(spec)
    throw new Error(`unexpected import ${spec}`)
  } }, { filename: file })
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hfm-composition-preview-'))
  const handles = [], closed = [], deleted = []
  const owner = module.exports.createPreviewDbRuntime({
    previewSqlitePath: () => path.join(directory, 'preview.sqlite'), previewSqliteSchemaVersion: 1,
    openRecoverableApplicationSqliteDb: async (_file, label) => {
      assert.equal(label, 'preview')
      const handle = { prepare: sql => ({ run: () => deleted.push(sql) }) }
      handles.push(handle)
      return handle
    },
    closeSqliteDb: db => { if (db) closed.push(db) },
    ensureSqliteColumn: () => undefined, setSqliteMeta: () => undefined,
  })
  try {
    assert.equal(handles.length, 0, 'constructing a connection opened a DB')
    const [a, b] = await Promise.all([owner.openPreviewDb(), owner.openPreviewDb()])
    assert.equal(a, b)
    assert.equal(handles.length, 1)
    assert.equal(schemas, 1)
    assert.equal(owner.getOpenPreviewDb(), a)
    owner.closePreviewDb()
    owner.closePreviewDb()
    assert.deepEqual(closed, [a], 'one handle closed twice')
    assert.equal(owner.getOpenPreviewDb(), null)
    const c = await owner.openPreviewDb()
    assert.notEqual(c, a)
    owner.clearLocalPreviewDbHandle()
    assert.deepEqual(deleted, ['DELETE FROM preview_cache'])
    assert.deepEqual(closed, [a, c])
    assert.equal(owner.getOpenPreviewDb(), null)
    schemaFails = true
    await assert.rejects(owner.openPreviewDb(), /fixture schema failure/)
    assert.equal(owner.getOpenPreviewDb(), null)
    assert.equal(closed.at(-1), handles.at(-1), 'schema failure leaked its handle')
    schemaFails = false
    const recovered = await owner.openPreviewDb()
    assert.equal(owner.getOpenPreviewDb(), recovered)
    owner.closePreviewDb()
    assert.equal(closed.at(-1), recovered)
  } finally { fs.rmSync(directory, { recursive: true, force: true }) }
}

function checkOutputTypes() {
  const config = ts.readConfigFile(path.join(root, 'tsconfig.json'), ts.sys.readFile)
  assert.equal(config.error, undefined)
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root)
  const files = ['Core', 'Data', 'DataStorage', 'DataQuery', 'Mutation', 'Operations', 'Maintenance', 'Scan'].map(compositionFile)
  const program = ts.createProgram({ rootNames: [...files, ...parsed.fileNames.filter(file => file.endsWith('.d.ts'))], options: parsed.options })
  const errors = ts.getPreEmitDiagnostics(program)
  assert.equal(errors.length, 0, errors.map(error => ts.flattenDiagnosticMessageText(error.messageText, '\n')).join('\n'))
  const checker = program.getTypeChecker()
  let operations = 0
  function value(type, label) {
    assert.equal(type.flags & ts.TypeFlags.Any, 0, `${label} exposes any`)
    if (type.isUnionOrIntersection()) type.types.forEach(part => value(part, label))
    if (type.flags & ts.TypeFlags.Object && type.objectFlags & ts.ObjectFlags.Reference) {
      checker.getTypeArguments(type).forEach(part => value(part, label))
    }
  }
  function surface(type, location, label) {
    for (const field of type.getProperties()) {
      const member = checker.getTypeOfSymbolAtLocation(field, location)
      value(member, `${label}.${field.name}`)
      const signatures = member.getCallSignatures()
      if (signatures.length) {
        operations += 1
        for (const signature of signatures) {
          value(signature.getReturnType(), `${label}.${field.name} result`)
          signature.getParameters().forEach(parameter => value(checker.getTypeOfSymbolAtLocation(parameter, location), `${label}.${field.name} argument`))
        }
      } else if (member.flags & ts.TypeFlags.Object) surface(member, location, `${label}.${field.name}`)
    }
  }
  for (const file of files) {
    const source = program.getSourceFile(file)
    const factory = checker.getExportsOfModule(checker.getSymbolAtLocation(source)).find(symbol => symbol.name.startsWith('create'))
    const signature = checker.getTypeOfSymbolAtLocation(factory, source).getCallSignatures()[0]
    surface(signature.getReturnType(), source, factory.name)
  }
  assert(operations > 100, 'composition type surface was not inspected')
  return operations
}

async function checkInstallCandidateWiring(overrides = new Map()) {
  const h = createHarness(overrides); h.load(entry)
  const query = h.compositions.get('createMainDataQueryCompositionRuntime')
  const refresh = h.options('createInstallStatusRefreshRuntime')
  assert.equal(refresh.readInstallRefreshSnapshot, query.readInstallRefreshSnapshot, 'INSTALL_CANDIDATE_WIRING: snapshot must belong to local query owner')
  assert.equal(refresh.readInstallRefreshSnapshot.fixtureOperation, 'createMergedIndexPageRuntime.readInstallRefreshSnapshot')
  h.reset()
  await refresh.readInstallSnapshotNames([{ jobId: 'fresh-name' }])
  assert.deepEqual(h.calls, [['createRustCoreWorkerRuntime.runRustFontParseBatch', [[{ jobId: 'fresh-name' }]]]], 'INSTALL_CANDIDATE_WIRING: fresh names must use native parse authority')
}
async function checkInstallCandidateMutations() {
  const file = compositionFile('Operations'), text = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n')
  const changes = [
    ['    readInstallSnapshotNames: jobs => rustCoreWorkerRuntime.runRustFontParseBatch(jobs),', '    readInstallSnapshotNames: async () => null,'],
    ['    readInstallRefreshSnapshot,\n    syncMergedIndexAfterInstallStatusRefresh,\n', '    readInstallRefreshSnapshot: async () => null,\n    syncMergedIndexAfterInstallStatusRefresh,\n'],
  ]
  // The second anchor occurs once in the owner options, apart from destructuring;
  // target its last occurrence so the mutant remains valid TypeScript.
  for (const [before, after] of changes) {
    const position = text.lastIndexOf(before); assert(position >= 0, 'install wiring mutation anchor missing')
    const mutated = text.slice(0, position) + after + text.slice(position + before.length)
    await assert.rejects(() => checkInstallCandidateWiring(new Map([[file, mutated]])), /INSTALL_CANDIDATE_WIRING/)
  }
  return changes.length
}

async function checkRejectedMutations() {
  const mutations = [
    ['eager DB open', compositionFile('Data'), '  const query = createMainDataQueryCompositionRuntime({', '  void storage.openLibraryDb();\n  const query = createMainDataQueryCompositionRuntime({'],
    ['wrong close owner', compositionFile('Scan'), 'closeTasksDb();', 'closeLibraryDb();'],
    ['false-save notification', compositionFile('DataStorage'), 'if (saved) notifyPreviewLibraryShellChanged()', 'notifyPreviewLibraryShellChanged()'],
    ['lost preview task binding', compositionFile('Data'), '    completeBackgroundTask,\n    skipBackgroundTask,', '    completeBackgroundTask: () => undefined,\n    skipBackgroundTask,'],
    ['missing DB worker shutdown', compositionFile('Data'), 'dbQueryWorkerShutdown: () => dbQueryWorkerRuntime.shutdown()', 'dbQueryWorkerShutdown: () => undefined'],
    ['wrong schema audit database', compositionFile('Data'), '        openLibraryDb,\n        closeSqliteDb,\n        getSqliteMeta,', '        openLibraryDb: openPreviewDb,\n        closeSqliteDb,\n        getSqliteMeta,'],
  ]
  for (const [name, file, before, after] of mutations) {
    const source = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n')
    assert.equal(source.split(before).length, 2, `${name}: mutation anchor drifted`)
    await assert.rejects(async () => {
      const observations = await observeBootstrap(new Map([[file, source.replace(before, after)]]))
      assert.deepEqual(observations, expectedObservations)
    }, undefined, `${name} was not detected`)
  }
  return mutations.length
}

async function main() {
  await checkImportAndOwnership()
  const recoveryWiring = createHarness(); recoveryWiring.load(entry)
  const readiness = recoveryWiring.options('createFolderWatcherRuntime').ensureSourceReady
  assert.equal(typeof readiness, 'function', 'private watcher source readiness port is missing')
  assert.equal(readiness.fixtureOperation,
    'createRootIndexSourceRecoveryRuntime.ensureReady', 'source recovery must remain owned by its private watcher readiness port')
  const restoreFile=compositionFile('DataStorage'), restoreSource=fs.readFileSync(restoreFile,'utf8').replace(/\r\n/g,'\n')
  const restoreWiring='applicationDatabasePaths: () => [librarySqlitePath(), tasksSqlitePath(), previewSqlitePath(), kvsSqlitePath(), eventsSqlitePath(), hashSqlitePath(), metricsSqlitePath()],'
  assert.equal(restoreSource.split(restoreWiring).length-1,1)
  await assert.rejects(()=>checkImportAndOwnership(new Map([[restoreFile,restoreSource.replace(restoreWiring,'applicationDatabasePaths: () => [],')]])),error=>error instanceof assert.AssertionError && /RESTORE_PATH_GATE/.test(error.message))
  // The direct composition is observed below; the dedicated restore diagnostic
  // exercises actual marker/SQLite admission and crash windows.
  await checkMetricsOwnerWiring()
  await checkCheckpointCacheWiring()
  await checkAvailabilityAndMaintenanceWiring()
  await checkPreviewHandleOwnership()
  await checkInstallCandidateWiring()
  assert.deepEqual(await observeBootstrap(), expectedObservations, 'AT-4.1 composition behavior changed')
  const operations = checkOutputTypes()
  const mutations = await checkRejectedMutations() + await checkMetricsOwnerMutations() + await checkCheckpointCacheMutations() + await checkAvailabilityAndMaintenanceMutations() + await checkInstallCandidateMutations()
  console.log(`[diagnostics:main-composition-runtime] passed: ${fixture.observations.registrations.length} registrations, ${Object.keys(fixture.observations.flows).length} baseline flows, import/DB ownership, ${operations} typed operations, ${mutations} rejected mutations`)
}
main().catch(error => { console.error(error); process.exitCode = 1 })
