'use strict'
// Windows CI only. In-memory ports: no real fonts, NAS, registry or user caches.
const assert = require('node:assert/strict')
const path = require('node:path')
const { loader } = require('./check-operation-chain.cjs')
const root = path.resolve(__dirname, '../..')
const at = file => path.join(root, 'src/main', file)
const absent = () => Object.assign(Error('missing'), { code: 'ENOENT' })
const tick = () => new Promise(resolve => setImmediate(resolve))
let cases = 0
const releaseGates = new Set()
const hold = assign => new Promise(resolve => { const release = () => { releaseGates.delete(release); resolve() }; releaseGates.add(release); assign(release) })

async function requestsAndCleanup() {
  const files = new Map(), removed = []
  let denyWrite = false, denyRemove = false
  const fsp = {
    readFile: async name => { if (!files.has(name)) throw absent(); return files.get(name) },
    stat: async () => ({}),
    rm: async name => { if (denyRemove) throw Error('ACK denied'); removed.push(name); files.delete(name) },
  }
  const mocks = {
    [at('path/sharedFileSystemRuntime.ts')]: { sharedFileSystem: fsp, withSharedIoPriority: (_priority, run) => run() },
    [at('path/ioDeadlineRuntime.ts')]: { awaitPhysicalIoClose: async () => {} },
    [at('indexing/root-index/rootIndexFileRuntime.ts')]: { writeJsonAtomic: async (name, value) => { if (denyWrite) throw Error('rename denied'); files.set(name, JSON.stringify(value)) } },
    [at('cache/scan-storage/cacheCleanupLeaseRuntime.ts')]: { withCacheCleanupLocks: async (locks, action) => { assert(locks.length); return action(async targets => targets.map(name => { removed.push(name); files.delete(name); return { path: name, status: 'removed' } })) } },
  }
  const load = loader(mocks)
  const requests = load('src/main/indexing/root-index/rootIndexRebuildRequestRuntime.ts')
  const cacheDir = path.join(root, '.virtual-cache')
  const oldId = await requests.requestRootIndexRebuild(cacheDir)
  const newId = await requests.requestRootIndexRebuild(cacheDir)
  await requests.acknowledgeRootIndexRebuild(cacheDir, oldId)
  assert.equal(await requests.readRootIndexRebuildRequest(cacheDir), newId, 'old completion cannot ACK a newer client request')
  denyWrite = true
  await assert.rejects(requests.requestRootIndexRebuild(cacheDir), /rename denied/)
  assert.equal(await requests.readRootIndexRebuildRequest(cacheDir), newId)
  denyWrite = false; denyRemove = true
  await assert.rejects(requests.acknowledgeRootIndexRebuild(cacheDir, newId), /ACK denied/)
  assert.equal(await requests.readRootIndexRebuildRequest(cacheDir), newId)
  denyRemove = false
  await requests.acknowledgeRootIndexRebuild(cacheDir, newId)
  assert.equal(await requests.readRootIndexRebuildRequest(cacheDir), undefined); cases++

  const folder = path.join(root, '.virtual-root')
  const options = { appendStartupLog() {}, loadLibraryShell: async () => ({ folders: [folder] }),
    legacyScanCachePath: () => path.join(cacheDir, 'legacy-global.json'),
    rootCacheDir: () => cacheDir, rootIndexDbPath: () => path.join(cacheDir, 'db', 'index.sqlite'),
    rootScanCachePath: () => path.join(cacheDir, 'scan.json'), rootLegacyScanCachePath: () => path.join(cacheDir, 'old.json'),
    fallbackCacheRootDir: () => path.join(cacheDir, 'fallback'), fallbackIndexDbPath: () => path.join(cacheDir, 'fallback', 'index.sqlite'),
    fallbackScanCachePath: () => path.join(cacheDir, 'fallback', 'scan.json'), fallbackLegacyScanCachePath: () => path.join(cacheDir, 'fallback', 'old.json'),
  }
  for (const name of ['index.sqlite', 'index.sqlite-wal', 'index.sqlite-shm', 'latest.json', 'manifest.json']) files.set(path.join(cacheDir, name), 'last-good')
  removed.length = 0
  await load('src/main/cache/scan-storage/cacheCleanupRuntime.ts').createCacheCleanupRuntime(options, { getCacheStats: async () => ({}), invalidateCacheStats() {} }).clearScanCache()
  assert(removed.length > 0)
  assert(removed.every(name => !/sqlite|latest|manifest/.test(name)), 'cleanup never deletes a last-good source/pointer family')
  const pending = await requests.readRootIndexRebuildRequest(cacheDir)
  assert(pending)
  // A newly loaded runtime sees the durable request after an interrupted scan.
  const restarted = loader(mocks)('src/main/indexing/root-index/rootIndexRebuildRequestRuntime.ts')
  assert.equal(await restarted.readRootIndexRebuildRequest(cacheDir), pending); cases++
}

async function publication() {
  const saved = []
  const load = loader({
    [at('cache/cachePaths.ts')]: { isRootIndexDbPath: () => true },
    [at('indexing/scan-orchestrator/scanOrchestratorUtils.ts')]: { delayToEventLoop: async () => {} },
  })
  const write = load('src/main/indexing/scan-orchestrator/scanRootCacheWriteRuntime.ts').writeRootScanCacheContexts
  const context = (name, complete = true) => ({ rootPath: name, cachePath: name + '.sqlite', storage: 'root', cache: { rebuildRequired: true, rebuildRequestId: name, entries: {} }, seenKeys: new Set(['a.ttf']), nextEntries: { 'a.ttf': { status: 'ok' } }, scanListingComplete: complete })
  const deps = { fontScanCacheVersion: 1, appendStartupLog() {}, saveScanCacheFile: async (...args) => saved.push(args) }
  const result = await write(deps, {}, [context('failed', false), context('ready')], [{ path: 'failed', message: 'read failed' }])
  assert.equal(JSON.stringify(result), JSON.stringify(['ready']), 'one root failure does not block a complete independent root')
  assert.equal(saved.length, 1); assert.equal(saved[0][1].rebuildRequestId, 'ready')
  const partial = context('partial'); partial.scanReadIncomplete = true
  await write(deps, {}, [partial], []); assert.equal(saved.length, 1)
  deps.saveScanCacheFile = async () => { throw Error('activation rename denied') }
  await assert.rejects(write(deps, {}, [context('denied')], []), /activation rename denied/); cases++
}

async function forcedScanIsolation() {
  let reads = 0
  const oldCache = { version: 1, entries: { 'a.ttf': { status: 'ok' } }, directorySignatures: [] }
  const load = loader({
    [at('path/sharedFileSystemRuntime.ts')]: { sharedFileSystem: { mkdir: async () => {} } },
    [at('indexing/root-index/rootIndexRebuildRequestRuntime.ts')]: { readRootIndexRebuildRequest: async () => 'generation-1' },
    [at('db/sqliteRecoveryPolicy.ts')]: { isRecoverableDerivedSqliteError: () => false },
    [at('path/cachePath.ts')]: { normalizePathForCacheCompare: value => value },
    [at('cache/cachePaths.ts')]: { cacheKeyForPath: value => value, fileCacheSignature: () => 'same' },
    [at('indexing/scan-orchestrator/scanContentHashRuntime.ts')]: { cacheEntryContentHashMatches: () => true, withScanContentHash: value => value },
  })
  const options = {
    fontScanCacheVersion: 1, rootCacheDir: root => root, rootIndexDbPath: root => root + '.sqlite',
    rootIndexDbDir: root => root, rootCacheLockDir: root => root, ensureRootArchitectureDatabases: async () => {},
    resolveActiveRootIndexDbPath: async (dir, db) => db, exists: async () => true,
    readRootIndexSqliteFile: async () => { reads++; return oldCache }, writeRootCacheManifest: async () => {},
    appendStartupLog() {}, recoveryMessage: String,
  }
  const runtime = load('src/main/cache/scan-storage/rootIndexStorageRuntime.ts').createRootIndexStorageRuntime(options, { hideDirectoryOnWindows: async () => {}, readScanCacheFile: async () => oldCache })
  const ordinary = await runtime.ensureRootScanCacheStorage('root')
  assert.equal(ordinary.cache, oldCache, 'tag/folder mutation callers retain old active rows during pending rebuild')
  const candidate = await runtime.ensureRootScanCacheStorage('root', { rebuildRequested: true })
  assert.equal(Object.keys(candidate.cache.entries).length, 0)
  assert.equal(candidate.cache.rebuildRequestId, 'generation-1'); assert.equal(reads, 1)
  const decisions = load('src/main/indexing/scan-orchestrator/scanIncrementalDecisionRuntime.ts').createScanIncrementalDecisionRuntime({
    deps: { scriptDetectionVersion: 1 }, knownFonts: [{ path: 'a.ttf', fileSize: 10, modifiedAt: 100, scripts: ['latin'], scriptVersion: 1 }],
    ensureLegacyCacheLoaded: async () => { throw Error('forced scan must not reuse legacy') },
  })
  const decision = await decisions.decide({ forceParse: true, item: {}, file: 'a.ttf', rootPath: 'root', stat: { size: 10, mtimeMs: 100 }, createdAt: 100, rootCacheKey: 'a.ttf', signature: 'same', cached: { status: 'ok' } })
  assert.equal(decision.action, 'parse'); cases++
}

async function sourceRecovery() {
  let pending, statError, scans = 0, projections = 0, available = true, busy = false, projectionFailure = false, commitBeforeCancel = false
  let result = { errors: [], committedFolders: ['root'] }, scanGate
  const load = loader({
    [at('path/sharedFileSystemRuntime.ts')]: { sharedFileSystem: { stat: async () => { if (statError) throw statError; return {} } } },
    [at('indexing/root-index/rootIndexRebuildRequestRuntime.ts')]: { readRootIndexRebuildRequest: async () => pending },
  })
  const runtime = load('src/main/indexing/root-index/rootIndexSourceRecoveryRuntime.ts').createRootIndexSourceRecoveryRuntime({
    cacheDir: root => root, defaultDbPath: root => root, resolveActiveDbPath: async root => root,
    isClosing: () => false, isScanActive: () => busy, isWatched: async () => true, isRootAvailable: async () => available,
    scanWhenIdle: async () => { scans++; if (scanGate) await scanGate; if (result.committedFolders.includes('root') || commitBeforeCancel) { pending = undefined; if (commitBeforeCancel) statError = undefined } return result },
    syncProjection: async () => { projections++; if (projectionFailure) throw Error('projection unavailable') }, log() {},
  })
  const signal = new AbortController().signal
  await runtime.ensureReady('root', signal); assert.equal(scans, 0)
  statError = Object.assign(Error('deferred'), { code: 'EACCES' })
  await assert.rejects(runtime.ensureReady('root', signal), /deferred/); assert.equal(scans, 0)
  statError = absent(); available = false
  await assert.rejects(runtime.ensureReady('root', signal), /root-offline/); assert.equal(scans, 0)
  available = true; busy = true
  await assert.rejects(runtime.ensureReady('root', signal), /source-recovery-deferred/); assert.equal(scans, 0)
  busy = false; let release; scanGate = hold(resolve => { release = resolve })
  const first = runtime.ensureReady('root', signal); await tick()
  const second = runtime.ensureReady('root', signal); await tick(); assert.equal(scans, 1)
  release(); await Promise.all([first, second]); assert.equal(projections, 1); scanGate = undefined
  result = { errors: [{ message: 'timeout' }], committedFolders: [] }
  await assert.rejects(runtime.ensureReady('root', signal), /unconfirmed/); assert.equal(projections, 1)
  result = { errors: [], committedFolders: [], stats: { cancelled: true } }
  await assert.rejects(runtime.ensureReady('root', signal), /cancelled/)
  const cancelledScans = scans
  for (let i = 0; i < 3; i++) await assert.rejects(runtime.ensureReady('root', signal), /cancelled/)
  assert.equal(scans, cancelledScans, 'polling cannot revive a user-cancelled repair')
  runtime.resume(['root']); result = { errors: [], committedFolders: ['root'] }; pending = 'clear-request'; statError = undefined
  await runtime.ensureReady('root', signal); assert.equal(scans, cancelledScans + 1)
  pending = 'next-request'; projectionFailure = true
  await assert.rejects(runtime.ensureReady('root', signal), /projection unavailable/)
  const committedScans = scans
  projectionFailure = false
  await runtime.ensureReady('root', signal)
  assert.equal(scans, committedScans, 'projection retry must not reparse an already activated source')
  pending = 'cancel-after-commit'; commitBeforeCancel = true; result = { errors: [], committedFolders: [], stats: { cancelled: true } }
  await assert.rejects(runtime.ensureReady('root', signal), /cancelled/)
  await assert.rejects(runtime.ensureReady('root', signal), /cancelled/, 'post-commit cancellation must not disappear behind a healthy source probe')
  const cancelledAfterCommitScans = scans
  runtime.resume(['root']); commitBeforeCancel = false
  await runtime.ensureReady('root', signal)
  assert.equal(scans, cancelledAfterCommitScans, 'resuming post-commit cancellation must settle projection without parsing again')
  cases++
}

async function cancellationOwnership() {
  let currentSignal, release, ownerRuns = 0
  const load = loader({
    [at('app/shutdownCoordinatorRuntime.ts')]: { isApplicationClosing: () => false },
    [at('path/fontPathPolicy.ts')]: { normalizeWatchedFontFolders: folders => folders },
    [at('indexing/scan-orchestrator/scanOrchestratorUtils.ts')]: { createFontScanJobId: () => String(++ownerRuns) },
    [at('performance/ioQueue.ts')]: {
      throwIfAborted: signal => { if (signal?.aborted) throw Object.assign(Error('aborted'), { name: 'AbortError' }) },
      isOperationCancelledError: error => error.name === 'AbortError',
    },
  })
  const runtime = load('src/main/indexing/scan-orchestrator/fontScanActiveJobRuntime.ts').createFontScanActiveJobRuntime({
    appendStartupLog() {}, emitFontIndexProgress() {}, recheckGlobalIoQueues() {}, globalIoSnapshot: () => ({}),
  }, async (folders, known, { signal }) => {
    currentSignal = signal
    await hold(resolve => { release = resolve })
    if (signal.aborted) throw Object.assign(Error('aborted'), { name: 'AbortError' })
    return { folders, errors: [], committedFolders: folders }
  })
  const owner = new AbortController()
  const first = runtime.scanFoldersWhenIdle(['root'], owner.signal); await tick()
  owner.abort(); assert(currentSignal.aborted, 'watcher retirement must cancel its actual scan controller')
  release(); assert((await first).stats.cancelled)
  const next = runtime.scanFoldersManaged(['foreground']); await tick()
  assert(!currentSignal.aborted, 'old watcher owner cannot cancel a later foreground scan')
  release(); await next
  const already = new AbortController(); already.abort()
  assert((await runtime.scanFoldersWhenIdle(['root'], already.signal)).stats.cancelled)
  assert.equal(ownerRuns, 2)
  const background = runtime.scanFoldersWhenIdle(['root']).then(value => ({ value }), error => ({ error }))
  await tick()
  const replacement = runtime.scanFoldersManaged(['root'])
  assert(currentSignal.aborted)
  release(); await tick()
  assert.match((await background).error.message, /source-recovery-deferred/, 'superseded background scan must not pause its replacement')
  assert(!currentSignal.aborted)
  release(); await replacement; cases++
}

async function watcherAvailability() {
  let callback, delay, time = 0, available = true, applies = 0
  const create = loader()('src/main/watcher/sharedFolderReconciliationRuntime.ts').createSharedFolderReconciliationRuntime
  const watcher = create({
    now: () => time, setTimer: (fn, wait) => { callback = fn; delay = wait; return { unref() {} } }, clearTimer() {},
    isCurrent: () => true, log() {}, ensureSourceReady: async () => { if (!available) throw Error('source-recovery-unconfirmed') },
    collect: async () => ({ files: new Map([['a.ttf', { size: 1, mtimeMs: 1 }]]) }), apply: async () => { applies++; return true },
  })
  watcher.start(); callback(); await tick(); assert.equal(applies, 1)
  const checked = watcher.status().lastCheckedAt
  available = false
  for (const backoff of [30000, 60000, 120000]) {
    time += delay; callback(); await tick()
    assert.equal(delay, backoff); assert.equal(watcher.status().lastCheckedAt, checked)
    assert.equal(watcher.status().phase, 'error', 'unchanged folder cannot ACK unavailable source')
  }
  available = true; time += delay; callback(); await tick()
  assert.equal(watcher.status().phase, 'idle'); assert.equal(applies, 1, 'restored source does not force unnecessary inventory rewrite')
  watcher.close(); cases++
}

async function sharedCancellationClassification() {
  for (const reason of ['cancelled', 'timeout', 'font-parse-total-timeout']) {
    let releaseRequest, releaseClose, settled = false
    const requestGate = hold(release => { releaseRequest = release })
    const closed = hold(release => { releaseClose = release })
    const failure = Object.assign(Error(reason), { sharedIo: true, reason, closed })
    const load = loader({
      [at('app/shutdownCoordinatorRuntime.ts')]: { isApplicationClosing: () => false },
      [at('path/fontPathPolicy.ts')]: { normalizeWatchedFontFolders: folders => folders },
      [at('indexing/scan-orchestrator/scanOrchestratorUtils.ts')]: { createFontScanJobId: () => 'shared-cancel' },
      [at('performance/ioQueue.ts')]: { throwIfAborted() {}, isOperationCancelledError: () => false },
    })
    const runtime = load('src/main/indexing/scan-orchestrator/fontScanActiveJobRuntime.ts').createFontScanActiveJobRuntime({
      appendStartupLog() {}, emitFontIndexProgress() {}, recheckGlobalIoQueues() {}, globalIoSnapshot: () => ({}),
    }, async () => { await requestGate; throw failure })
    const owner = new AbortController()
    const outcome = runtime.scanFoldersWhenIdle(['root'], owner.signal).then(value => { settled = true; return { value } }, error => { settled = true; return { error } })
    await tick(); owner.abort(); releaseRequest(); await tick()
    if (reason === 'cancelled') {
      assert.equal(settled, false, 'confirmed shared cancellation retired before physical close')
      releaseClose(); assert((await outcome).value.stats.cancelled)
    } else {
      assert.equal((await outcome).error, failure, 'aborted owner must not disguise a timeout as cancellation')
      releaseClose()
    }
  }
  cases++
}

async function main() {
  assert.equal(process.platform, 'win32', 'HFM verification is Windows-only')
  try { await requestsAndCleanup(); await publication(); await forcedScanIsolation(); await sourceRecovery(); await cancellationOwnership(); await watcherAvailability(); await sharedCancellationClassification() }
  finally { for (const release of releaseGates) release() }
  console.log(`scan rebuild recovery passed: ${cases} controlled groups`)
}
if (require.main === module) {
  const watchdog = setTimeout(() => { console.error('scan rebuild recovery timed out before all groups settled'); process.exit(1) }, 30000)
  main().catch(error => { console.error(error); process.exitCode = 1 }).finally(() => clearTimeout(watchdog))
}
module.exports = { main }
