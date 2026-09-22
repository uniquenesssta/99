#!/usr/bin/env node
// C-00 observer. Default runs the pinned pre-C-00 production baseline.
// It records known defects without making diagnostics:all red; --strict is the negative business gate.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const fsp = fs.promises
const path = require('node:path')
const os = require('node:os')
const { execFileSync } = require('node:child_process')
const { DatabaseSync } = require('node:sqlite')
const { loader } = require('./check-operation-chain.cjs')

const root = path.resolve(__dirname, '../..')
const baseline = '515f2103106db1dc2a200b43fd3e8304d1ed780e'
const current = process.argv.includes('--current')
const crlf = process.argv.includes('--crlf')
const transforms = {}
const sourceFiles = execFileSync('git', ['ls-tree', '-r', '--name-only', baseline, 'src'], { cwd: root, encoding: 'utf8' })
  .trim().split('\n').filter(file => /\.(?:ts|tsx)$/.test(file))
for (const file of sourceFiles) {
  transforms[path.join(root, file)] = source => {
    const text = current ? source : execFileSync('git', ['show', baseline + ':' + file], { cwd: root, encoding: 'utf8' })
    return crlf ? text.replace(/\r?\n/g, '\r\n') : text
  }
}
const load = (mocks = {}, globals = {}) => loader(mocks, globals, transforms)
const abs = rel => path.join(root, rel)
const rows = []
const report = (id, defect, evidence) => rows.push({ id, status: defect ? 'KNOWN_DEFECT' : 'CONTROL_PASS', evidence })
const tick = () => new Promise(resolve => setImmediate(resolve))
const exists = async file => { try { await fsp.access(file); return true } catch { return false } }

async function observeRootIndexAccess(dir) {
  const localDir = path.join(dir, 'local-root')
  const networkDir = path.join(dir, 'network-root')
  await Promise.all([fsp.mkdir(localDir, { recursive: true }), fsp.mkdir(networkDir, { recursive: true })])
  const rustCalls = []
  const events = []
  const isNetwork = value => String(value || '').includes('network-root')
  const mocks = {
    [abs('src/main/path/sharedFileSystemRuntime.ts')]: {
      sharedFileSystem: fsp,
      sharedSqliteReadSnapshot: async () => undefined,
    },
    [abs('src/main/rust-core/rustSharedIoCommandRuntime.ts')]: {
      sharedIoResourceKeys: async paths => paths.some(isNetwork) ? ['\\\\nas\\share'] : [],
    },
    [abs('src/main/indexing/root-index/rootIndexLockRuntime.ts')]: {
      createRootIndexLockRuntime: () => ({
        rootCacheDirForIndexPath: file => path.dirname(file),
        withRootCacheWriteLock: async (_file, action) => action(),
      }),
    },
    [abs('src/main/indexing/root-index/rootIndexManifestRuntime.ts')]: {
      createRootIndexManifestRuntime: () => ({
        resolveActiveRootIndexDbPath: async (_dir, fallback) => fallback,
        writeRootCacheManifest: async () => undefined,
        validateRootIndexLatestPointer: async () => undefined,
      }),
    },
    [abs('src/main/indexing/root-index/rootIndexSnapshotRuntime.ts')]: {
      createRootIndexSnapshotRuntime: () => ({
        rootIndexSnapshotDbPath: cacheDir => path.join(cacheDir, 'snapshot.sqlite'),
        cleanupOldRootIndexSnapshots: async () => undefined,
        inspectRootIndexSnapshotMaintenance: async () => ({}),
        cleanupRootIndexSnapshotMaintenance: async () => ({}),
        listRootIndexDatabaseFiles: async () => [],
      }),
    },
  }
  const runtime = load(mocks)('src/main/indexing/rootIndexRuntime.ts').createRootIndexRuntime({
    appName: 'HFM',
    fontScanCacheVersion: 1,
    scriptDetectionVersion: 1,
    exists,
    openStableSqliteDb: file => new DatabaseSync(file),
    closeSqliteDb: db => db.close(),
    appendStartupLog: line => events.push(line),
    withGlobalIo: async (_label, action) => action(),
    invalidateSharedFontRuntimeCaches() {},
    recordCacheEvent: async () => undefined,
    runRustRootIndexApplyChanges: async input => {
      rustCalls.push(input)
      return { applied: true, count: input.upserts.length, upserts: input.upserts.length, deletes: input.deletes.length }
    },
  })
  const entry = {
    path: 'a.ttf', cacheKey: 'a.ttf', fileSize: 10, modifiedAt: 1, createdAt: 1,
    status: 'ok', font: { id: 'a', path: path.join(localDir, 'a.ttf'), fileName: 'a.ttf', format: 'ttf' },
    cachedAt: '2026-09-19T00:00:00.000Z',
  }

  const localDb = path.join(localDir, 'index.sqlite')
  await runtime.saveRootIndexSqliteChanges(localDb, localDir, 'root', [['a.ttf', entry]], [])
  assert.equal(rustCalls.length, 0, 'local storage=root unexpectedly routed through shared Rust transaction')
  assert(await exists(path.join(localDir, 'snapshot.sqlite')), 'local root atomic snapshot was not written')
  report('C00-C01', false, { storage: 'root', access: 'local', nodeSnapshot: true, rustCalls: 0 })

  const networkDb = path.join(networkDir, 'index.sqlite')
  let error
  try {
    await runtime.saveRootIndexSqliteChanges(networkDb, networkDir, 'root', [['a.ttf', { ...entry, path: 'a.ttf', font: { ...entry.font, path: path.join(networkDir, 'a.ttf') } }]], [])
  } catch (caught) {
    error = caught
  }
  const defect = Boolean(error && error.reason === 'main-write-denied' && rustCalls.length === 0)
  report('C00-B01', defect, {
    storage: 'root',
    access: 'shared',
    reason: error && error.reason,
    message: error && error.message,
    rustCalls: rustCalls.length,
    route: defect ? 'atomic-snapshot-before-access-classification' : 'shared-route-no-longer-reproduced',
  })
}

async function observeWatcherRecovery(dir) {
  const folder = path.join(dir, 'network-root')
  await fsp.mkdir(folder, { recursive: true })
  const calls = []
  const logs = []
  const never = new Promise(() => {})
  const mocks = {
    electron: { BrowserWindow: { getAllWindows: () => [] } },
    [abs('src/main/rust-core/rustSharedIoCommandRuntime.ts')]: { sharedIoResourceKeys: async () => ['\\\\nas\\share'] },
    [abs('src/main/path/sharedFileSystemRuntime.ts')]: {
      sharedFileSystem: fsp,
      executeSharedFile: async () => never,
    },
    [abs('src/main/path/startupPathAvailabilityRuntime.ts')]: {
      ensureStartupPathRootAvailable: async () => true,
      markStartupPathRootUnavailable() {},
    },
  }
  const runtime = load(mocks)('src/main/watcher/folderWatcherRuntime.ts').createFolderWatcherRuntime({
    appendStartupLog: line => logs.push(line),
    isIgnoredWatcherPath: () => false,
    verboseLogs: false,
    startupGraceMs: 0,
    flushDebounceMs: 60000,
    closeRuntimeDatabases() {},
    watcherChangeBatchLooksUnchanged: async () => false,
    applyWatchedFolderChangesToIndex: async (changes, recovery) => {
      calls.push({ recovery: Boolean(recovery), eventTypes: changes.map(item => item.eventType), files: changes.map(item => item.fileName) })
      throw Object.assign(new Error('共享根索引持久化失败。'), { watcherRecoveryDisposition: 'defer' })
    },
    syncMergedIndexForRootIncremental: async () => undefined,
    syncMergedIndexForRootSnapshot: async () => undefined,
    isScanActive: () => false,
  })
  try {
    await runtime.startWatchingFolders([folder])
    runtime.notifyFolderChanged(folder, 'rescan')
    await runtime.flushPendingFolderChanges()
    await runtime.flushPendingFolderChanges()
    const defect = calls.length >= 2 && calls[0].recovery === false && calls[1].recovery === true
    report('C00-B02', defect, {
      applyCalls: calls,
      recoveryExhausted: logs.some(line => line.includes('recovery exhausted')),
      meaning: defect ? 'one structural persistence failure causes a second root-level recovery pass' : 'recovery no longer repeats the root rescan',
    })
  } finally {
    runtime.stopFolderWatchers()
  }
}

async function observeTimeoutOffline() {
  let rootState = { state: 'online', generation: 1 }
  const rootPath = '\\\\nas\\share\\fonts'
  const mocks = {
    [abs('src/main/path/startupPathAvailabilityRuntime.ts')]: {
      getStartupPathRootState: () => ({ rootId: rootPath, ...rootState }),
      markStartupPathRootUnavailable: () => { rootState = { state: 'offline', generation: rootState.generation + 1 } },
    },
    [abs('src/main/rust-core/rustSharedIoCommandRuntime.ts')]: {
      sharedIoAvailabilityRoot: () => rootPath,
      sharedIoResourceKeys: async () => ['\\\\nas\\share'],
    },
  }
  const l = load(mocks)
  const { SharedIoProcessError } = l('src/main/path/sharedIoProcessRuntime.ts')
  const runtime = l('src/main/path/sharedFileSystemRuntime.ts')
  runtime.configureSharedFileExecutor(async () => { throw new SharedIoProcessError('controlled timeout', 'unknown', 'timeout') })
  await assert.rejects(runtime.executeSharedFile({ operation: 'stat', path: rootPath + '\\slow.ttf' }), error => error.reason === 'timeout')
  const defect = rootState.state === 'offline'
  report('C00-B03', defect, { operation: 'stat', reason: 'timeout', rootState: rootState.state, generation: rootState.generation, meaning: defect ? 'single request timeout still owns root offline state' : 'single request timeout no longer changes root state' })

  rootState = { state: 'online', generation: rootState.generation + 1 }
  runtime.configureSharedFileExecutor(async request => ({ result: { ok: false, operation: request.operation, code: 'ENOENT', message: 'missing' } }))
  await assert.rejects(runtime.executeSharedFile({ operation: 'stat', path: rootPath + '\\missing.ttf' }), error => error.code === 'ENOENT')
  assert.equal(rootState.state, 'online', 'ordinary ENOENT must not make the root offline')
  report('C00-C02', false, { operation: 'stat', reason: 'ENOENT', rootState: rootState.state })
}

async function observeActivationNameContract() {
  const compare = load()('src/main/install/fontInstallCompare.ts').createInstallCompareRuntime({ appName: '字体管理器' })
  const item = { id: '46686373be5ba41a580a5c02a3b6711fc6a8ac34', fileName: '方正粗圆_gbk.ttf', fullName: '方正粗圆_GBK' }
  const fileName = compare.safeTemporaryActiveFontName(item)
  const registryName = compare.temporaryActiveRegistryNameFor(item) + ' [fixture-session]'
  assert(fileName.startsWith('字体管理器_ACTIVE_'))
  assert(!registryName.startsWith('字体管理器_ACTIVE_'))
  report('C00-C03', false, {
    managedFileNamePrefix: '字体管理器_ACTIVE_',
    registryName,
    registryUsesManagedFilePrefix: false,
    nativeProof: 'cargo test --test c00_activation_cleanup_contract on Windows',
  })
}

async function observeShutdownResidualClean() {
  const logs = []
  let terminated
  const runtime = load({}, { AbortController })('src/main/app/shutdownCoordinatorRuntime.ts')
  const coordinator = runtime.createShutdownCoordinator({
    log: line => logs.push(line),
    freeze() {},
    closeRenderers: async () => true,
    restore() {},
    cleanup: async () => ({ remaining: 1 }),
    save: async () => undefined,
    confirmLoss: async () => true,
    drainLogs: async () => undefined,
    terminate: outcome => { terminated = outcome },
  })
  await coordinator.request()
  const defect = !terminated
    || terminated.processExitClean !== true
    || terminated.persistenceComplete !== true
    || terminated.localCleanupComplete !== false
    || terminated.cleanupRemaining !== 1
    || terminated.reason !== 'residual'
  report('C00-B04', defect, {
    cleanupRemaining: 1,
    outcome: terminated,
    cleanupLog: logs.find(line => line.includes('phase=cleanup')) || '',
    terminateLog: logs.find(line => line.includes('phase=terminate')) || '',
    meaning: defect ? 'shutdown residual still collapses process/persistence/cleanup into one clean flag' : 'planned residual exit is process-clean and persistence-complete while local cleanup remains incomplete',
  })
}

async function observeRendererClosingAdmission() {
  const cleanups = []
  const windowListeners = new Map()
  const documentListeners = new Map()
  const idleCallbacks = new Map()
  let nextIdleId = 0
  const fakeWindow = {
    setTimeout, clearTimeout, setInterval, clearInterval,
    requestIdleCallback: fn => {
      const id = ++nextIdleId
      idleCallbacks.set(id, fn)
      setImmediate(() => {
        const callback = idleCallbacks.get(id)
        if (!callback) return
        idleCallbacks.delete(id)
        callback({ didTimeout: false, timeRemaining: () => 50 })
      })
      return id
    },
    cancelIdleCallback: id => idleCallbacks.delete(id),
    addEventListener: (name, fn) => windowListeners.set(name, fn),
    removeEventListener: name => windowListeners.delete(name),
  }
  const fakeDocument = {
    visibilityState: 'visible',
    addEventListener: (name, fn) => documentListeners.set(name, fn),
    removeEventListener: name => documentListeners.delete(name),
  }
  const react = {
    useRef: value => ({ current: value }),
    useEffect: fn => { const cleanup = fn(); if (typeof cleanup === 'function') cleanups.push(cleanup) },
  }
  const calls = []
  let sharedCalls = 0
  let closeListener
  let closeCancelledListener
  let backgroundListener
  const hfm = {
    onWindowFlushBeforeClose: cb => { closeListener = cb; return () => { closeListener = undefined } },
    onWindowCloseCancelled: cb => { closeCancelledListener = cb; return () => { closeCancelledListener = undefined } },
    completeWindowCloseFlush: async () => true,
    onBackgroundTasksChanged: cb => { backgroundListener = cb; return () => { backgroundListener = undefined } },
    getCacheArchitecture: async () => { calls.push('cache:getArchitecture'); return {} },
    getBackgroundTaskSchedulerStatus: async () => { calls.push('tasks:getSchedulerStatus'); return {} },
    getSharedMetadataDiagnostics: async () => { calls.push('sharedMetadata:getDiagnostics'); return {} },
    listBackgroundTasks: async () => { calls.push('tasks:list'); return [] },
  }
  const l = load({ react }, { window: fakeWindow, document: fakeDocument })
  const closingLifecycle = l('src/renderer/src/runtime/app/rendererClosingLifecycleRuntime.ts').createRendererClosingLifecycleRuntime()
  const dev = l('src/renderer/src/rendererDeveloperStatusRuntime.ts')
  const refresh = () => dev.refreshDeveloperStatusDetailsRuntime({
    enabled: true,
    hfm,
    setArchitecture() {},
    setSchedulerStatus() {},
    setMigrationDiagnostics() {},
    setSharedMetadataDiagnostics() {},
    setTasks() {},
    appendStatus() {},
    isClosing: closingLifecycle.isClosing,
  })
  l('src/renderer/src/runtime/app/effects/useAppFlushOnUnloadRuntime.ts').useAppFlushOnUnloadRuntime({
    hfm,
    clearDatabaseRefreshTimer() {},
    clearFontListScrollIdleTimer() {},
    clearQueuedFontWriteTimer() {},
    flushFontWriteQueue: async () => true,
    flushLibraryPersistence: async () => true,
    closingLifecycle,
  })
  l('src/renderer/src/runtime/app/effects/useBackgroundTaskEventsRuntime.ts').useBackgroundTaskEventsRuntime({
    enabled: true,
    hfm,
    setLatestBackgroundTaskEvent() {},
    appendDeveloperStatus() {},
    refreshDeveloperStatusDetails: refresh,
    closingLifecycle,
  })
  l('src/renderer/src/runtime/app/effects/useSharedMetadataSyncForegroundRuntime.ts').useSharedMetadataSyncForegroundRuntime({
    enabled: true,
    libraryFoldersKey: 'root',
    indexingActive: false,
    checkSharedMetadataUpdates: async () => { sharedCalls++ },
    closingLifecycle,
  })
  await tick(); await tick()
  assert(calls.length >= 4, 'normal developer diagnostics must remain active before close')
  const normalDeveloperCalls = calls.slice()
  const focus = windowListeners.get('focus')
  assert.equal(typeof focus, 'function')
  focus()
  await tick(); await tick()
  assert(sharedCalls > 0, 'normal shared metadata foreground refresh must remain active before close')
  const sharedBeforeClose = sharedCalls
  calls.length = 0

  assert.equal(typeof closeListener, 'function')
  closeListener({ requestId: 1 })
  await tick()
  assert.equal(closingLifecycle.isClosing(), true)
  assert.equal(typeof backgroundListener, 'function')

  backgroundListener({ eventType: 'scheduler', status: { stopping: true } })
  backgroundListener({ eventType: 'task', task: { id: 'late' }, status: { state: 'finished' } })
  focus()
  await tick(); await tick()
  const postCloseDeveloperCalls = calls.slice()
  const postCloseSharedCalls = sharedCalls - sharedBeforeClose
  assert.equal(postCloseDeveloperCalls.length, 0, 'explicit renderer closing must block late developer diagnostics IPC')
  assert.equal(postCloseSharedCalls, 0, 'explicit renderer closing must block shared metadata foreground refresh')

  assert.equal(typeof closeCancelledListener, 'function')
  closeCancelledListener({ requestId: 1 })
  assert.equal(closingLifecycle.isClosing(), false)
  backgroundListener({ eventType: 'task', task: { id: 'resumed' }, status: { state: 'finished' } })
  focus()
  await tick(); await tick(); await tick()
  assert(calls.length >= 4, 'developer diagnostics must recover after close cancellation')
  assert(sharedCalls > sharedBeforeClose, 'shared metadata foreground refresh must recover after close cancellation')

  report('C00-B05', false, {
    closeSignalReceived: true,
    explicitRendererClosing: true,
    normalDeveloperCalls,
    postCloseDeveloperCalls,
    postCloseSharedCalls,
    resumedDeveloperCalls: calls.slice(),
    sharedForegroundRecovered: sharedCalls > sharedBeforeClose,
    meaning: 'explicit renderer closing admission blocks late developer/shared foreground work and close cancellation restores normal behavior',
  })
  for (const cleanup of cleanups.reverse()) cleanup()
}

async function main() {
  const watchdog = setTimeout(() => {
    console.error('[diagnostics:index-io-activation-shutdown-baseline] exceeded 20s safety budget')
    process.exit(1)
  }, 20000)
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'hfm-c00-baseline-'))
  try {
    await observeRootIndexAccess(dir)
    await observeWatcherRecovery(dir)
    await observeTimeoutOffline()
    await observeActivationNameContract()
    await observeShutdownResidualClean()
    await observeRendererClosingAdmission()
  } finally {
    clearTimeout(watchdog)
    await fsp.rm(dir, { recursive: true, force: true })
  }
  const reportData = {
    mode: current ? 'current-observation' : 'pinned-baseline',
    baseline,
    crlf,
    knownDefects: rows.filter(row => row.status === 'KNOWN_DEFECT').length,
    controls: rows.filter(row => row.status === 'CONTROL_PASS').length,
    rows,
    nativeWindowsObserver: 'cargo test --locked --test c00_activation_cleanup_contract -- --nocapture',
    limitations: ['No real NAS access', 'No real Electron window process', 'Native registry ownership defect is proven by the separate Windows Rust observer'],
    businessCorrectnessPassed: rows.every(row => row.status !== 'KNOWN_DEFECT'),
  }
  console.log(JSON.stringify(reportData, null, 2))
  if (process.argv.includes('--strict') && reportData.knownDefects) process.exitCode = 1
}
main().catch(error => {
  console.error('[diagnostics:index-io-activation-shutdown-baseline]', error.stack || error)
  process.exitCode = 1
})
