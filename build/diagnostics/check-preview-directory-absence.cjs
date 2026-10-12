#!/usr/bin/env node
const assert = require('node:assert/strict'), path = require('node:path'), fs = require('node:fs')
const { loader } = require('./check-operation-chain.cjs')
const png = require('./fixtures/preview-png.cjs')
const root = path.resolve(__dirname, '../..'), abs = file => path.join(root, file)
const gate = () => { let resolve; return { promise: new Promise(r => { resolve = r }), resolve: value => resolve(value) } }
const missing = () => Object.assign(Error('absent fixture'), { code: 'ENOENT' })
const metadata = { size: 0, mtimeMs: 1, birthtimeMs: 1, isDirectory: true }

async function maintenanceCases() {
  let failure = 'ENOENT', malformed = false, thrown, reads = 0, marks = 0
  const load = loader({
    [abs('src/main/rust-core/rustSharedIoCommandRuntime.ts')]: { sharedIoResourceKeys: async () => ['fixture-root'], sharedIoResourceKeysSnapshot: () => ['fixture-root'], sharedIoAvailabilityRoot: () => '/share' },
    [abs('src/main/path/startupPathAvailabilityRuntime.ts')]: { assertStartupPathRootGuardCurrent() {}, getStartupPathRootState: () => ({ rootId: 'fixture-root', generation: 1, state: 'online' }), markStartupPathRootUnavailable: () => { marks++ } },
  }, { setImmediate })
  load('src/main/path/sharedFileSystemRuntime.ts').configureSharedFileExecutor(async request => {
    reads++
    assert.equal(request.operation, 'directoryMetadata', 'optional directory triggered per-file work or a write')
    if (thrown) throw thrown
    return { result: { operation: request.operation, ok: !failure, code: failure, message: failure, value: malformed ? {} : { stat: metadata, entries: [] } } }
  })
  const readDirectory = load('src/main/path/sharedDirectoryMetadataRuntime.ts').readSharedDirectoryMetadata
  const ProcessError = load('src/main/path/sharedIoProcessRuntime.ts').SharedIoProcessError
  const db = { prepare: () => ({ all: () => [], run: () => { throw Error('absence must not mutate rows') } }) }
  const runtime = load('src/main/maintenance/previewCacheMaintenanceRuntime.ts').createPreviewCacheMaintenanceRuntime({
    previewOkRetentionMs: 1000, openPreviewDb: async () => db, previewSqlitePath: () => '/local/preview.sqlite', previewSqliteSchemaVersion: 1,
    collectPreviewMaintenanceDirs: async () => [{ dirPath: '/share/optional', referenceDbPath: '/share/preview.sqlite' }], normalizePathForCacheCompare: value => value,
  })
  await assert.rejects(readDirectory('/share/optional'), error => error.code === 'ENOENT')
  assert.equal((await runtime.runPreviewCacheMaintenance()).errors.length, 0, 'missing optional cache directory failed startup maintenance')
  assert.equal(reads, 2); assert.equal(marks, 0)
  for (const code of ['EACCES', 'EIO', 'ENETUNREACH', 'ENOTDIR']) {
    failure = code
    assert.equal((await runtime.runPreviewCacheMaintenance()).errors.length, 1, code + ' was hidden as an optional miss')
  }
  assert.equal(marks, 1, 'root outage classification did not reach root availability')
  failure = undefined; malformed = true
  await assert.rejects(readDirectory('/share/optional'), error => error.reason === 'invalid-receipt')
  assert.equal((await runtime.runPreviewCacheMaintenance()).errors.length, 1)
  malformed = false
  for (const reason of ['timeout', 'cancelled', 'stale-generation', 'root-offline']) {
    thrown = new ProcessError(reason, 'unknown', reason)
    await assert.rejects(readDirectory('/share/optional'), error => error === thrown)
    assert.equal((await runtime.runPreviewCacheMaintenance()).errors.length, 1, reason + ' was hidden as an optional miss')
  }
  thrown = undefined
  assert.equal((await runtime.runPreviewCacheMaintenance()).errors.length, 0)
}

function hydrationFixture() {
  const state = { clock: 10000, generation: 1, rootId: 'fixture-root', rootState: 'online', reads: 0, stats: 0, indexes: 0,
    readCode: 'ENOENT', statCode: 'ENOENT', statHold: null, directoryTimedOut: false, status: null, presence: null, persistentPresence: null, signals: [], files: new Map(), legacy: '/share/legacy' }
  const localFs = { ...fs.promises, readFile: async file => { if (!state.files.has(file)) throw missing(); return state.files.get(file) },
    mkdir: async () => {}, writeFile: async (file, bytes) => { state.files.set(file, bytes) },
    rename: async (from, to) => { state.files.set(to, state.files.get(from)); state.files.delete(from) }, unlink: async file => { state.files.delete(file) } }
  const load = loader({
    'node:fs': { ...fs, promises: localFs },
    [abs('src/main/rust-core/rustSharedIoCommandRuntime.ts')]: { sharedIoResourceKeys: async paths => paths.some(file => file.replaceAll('\\', '/').startsWith('/share/')) ? ['fixture-root'] : [], sharedIoAvailabilityRoot: () => '/share' },
    [abs('src/main/path/startupPathAvailabilityRuntime.ts')]: { assertStartupPathRootGuardCurrent() {}, getStartupPathRootState: () => ({ rootId: state.rootId, generation: state.generation, state: state.rootState }), markStartupPathRootUnavailable: () => { state.rootState = 'offline'; state.generation++ } },
  }, { Date: class extends Date { static now() { return state.clock } } })
  load('src/main/path/sharedFileSystemRuntime.ts').configureSharedFileExecutor(async (request, _bytes, signal) => {
    state.signals.push(signal)
    assert(signal, 'directory/PNG read escaped its cancellable hydration lease')
    let code
    if (request.operation === 'readFile') { state.reads++; code = state.readCode }
    else if (request.operation === 'stat') {
      state.stats++; code = state.statCode
      if (state.statHold) await state.statHold.promise
    } else throw Error('unexpected shared mutation: ' + request.operation)
    if (code && typeof code !== 'string') throw code
    return { result: { operation: request.operation, ok: !code, code, message: code, value: metadata }, bytes: code ? undefined : png }
  })
  const share = { storage: 'root', rootPath: '/share', dir: '/share/modern' }, local = { storage: 'local', dir: '/local', shared: share }
  const options = { appendStartupLog() {}, withIoDeadlineResult: async (label, operation) => {
    if (state.directoryTimedOut && label.startsWith('preview-cache-hydrate-directory:')) return { ok: false, timedOut: true, error: missing() }
    try { return { ok: true, value: await operation() } } catch (error) { return { ok: false, error } }
  }, previewCacheStorageToShared: () => share, ensureSharedAvailable: async () => state.rootState !== 'offline',
    readPreviewCacheIndexStatus: async () => { state.indexes++; return state.status }, writePreviewCacheIndex: async () => {},
    legacyRootPreviewCacheDir: () => state.legacy,
    sharedPresence: { getSharedPresence: () => state.presence, forgetSharedPresence: () => { state.presence = null }, rememberSharedPresence: () => { state.presence = 'ok' } },
    sharedPresenceIndex: { getSharedPresenceIndex: async () => state.persistentPresence, forgetSharedPresenceIndex: async () => { state.persistentPresence = null }, rememberSharedPresenceIndex: async () => { state.persistentPresence = 'ok' } },
  }
  const runtime = load('src/main/preview/runtime/previewCacheHydrationRuntime.ts').createPreviewCacheHydrationRuntime(options)
  const row = key => ({ id: key, previewKey: key, outputPath: '/local/' + key + '.png' })
  const read = async item => {
    const outcomes = []
    await runtime.hydratePreviewCacheRows(local, [item], () => true, (_item, outcome) => outcomes.push(outcome))
    assert.equal(outcomes.length, 1)
    return outcomes[0]
  }
  return { state, load, share, runtime, row, read }
}

async function hydrationCases() {
  const h = hydrationFixture(), { state, row, read } = h
  for (let i = 0; i < 16; i++) assert.equal(await read(row('absent-' + i)), 'miss')
  assert.deepEqual([state.reads, state.stats, state.indexes], [1, 1, 16], 'sibling PNG misses repeated probes or skipped independent primary index checks')
  state.clock += 5001
  assert.equal(await read(row('expired')), 'miss'); assert.equal(state.reads, 2); assert.equal(state.stats, 2)
  state.generation++
  assert.equal(await read(row('reconnected')), 'miss'); assert.equal(state.reads, 3)
  state.rootId = 'replacement-root'
  assert.equal(await read(row('replaced')), 'miss'); assert.equal(state.reads, 4)
  state.legacy = '/share/other-legacy'
  assert.equal(await read(row('other-directory')), 'miss'); assert.equal(state.reads, 5)
  h.runtime.forgetSharedDirectoryMiss(h.share)
  assert.equal(await read(row('published-directory')), 'miss'); assert.equal(state.reads, 6)
  // A cached directory miss must not become a fresh 30s per-file negative.
  state.readCode = undefined; state.statCode = undefined; state.clock += 5001
  assert.equal(await read(row('absent-1')), 'hydrated', 'directory miss outlived its own short TTL')

  const sibling = hydrationFixture()
  sibling.state.statCode = undefined
  assert.equal(await sibling.read(sibling.row('missing-file')), 'miss')
  sibling.state.readCode = undefined
  assert.equal(await sibling.read(sibling.row('present-sibling')), 'hydrated', 'one missing file hid its directory siblings')
  assert.equal(sibling.state.reads, 2); assert.equal(sibling.state.stats, 1)

  for (const evidence of ['index', 'persistent-presence']) {
    const recovered = hydrationFixture()
    recovered.state.legacy = recovered.share.dir
    assert.equal(await recovered.read(recovered.row('before-' + evidence)), 'miss')
    assert.equal(recovered.state.reads, 1)
    if (evidence === 'index') recovered.state.status = 'ok'
    else recovered.state.persistentPresence = 'ok'
    recovered.state.readCode = undefined
    assert.equal(await recovered.read(recovered.row('after-' + evidence)), 'hydrated', evidence + ' was suppressed by obsolete directory absence')
    assert.equal(recovered.state.reads, 2)
  }

  for (const code of ['EACCES', 'EIO', 'ENETUNREACH', 'timeout', 'cancelled', 'invalid-receipt']) {
    const broken = hydrationFixture()
    const ProcessError = broken.load('src/main/path/sharedIoProcessRuntime.ts').SharedIoProcessError
    broken.state.statCode = ['timeout', 'cancelled', 'invalid-receipt'].includes(code) ? new ProcessError(code, 'unknown', code) : code
    const item = broken.row('retry-' + code)
    const outcome = await broken.read(item)
    assert.notEqual(outcome, 'miss', code + ' became confirmed absence')
    broken.state.statCode = undefined; broken.state.readCode = undefined; broken.state.rootState = 'online'
    assert.equal(await broken.read(item), 'hydrated', code + ' poisoned retry')
    assert.equal(broken.state.reads, 2)
  }

  const budget = hydrationFixture(), budgetRow = budget.row('budget')
  budget.state.directoryTimedOut = true
  assert.equal(await budget.read(budgetRow), 'timeout', 'response timeout became directory absence')
  budget.state.directoryTimedOut = false; budget.state.readCode = undefined
  assert.equal(await budget.read(budgetRow), 'hydrated', 'response timeout left negative evidence')

  const pending = hydrationFixture(), hold = gate()
  pending.state.statHold = hold
  const first = pending.read(pending.row('pending'))
  // Observe entry to the async directory probe without depending on timers.
  for (let i = 0; !pending.state.stats && i < 100; i++) await Promise.resolve()
  assert.equal(pending.state.stats, 1)
  pending.runtime.forgetSharedDirectoryMiss(pending.share)
  hold.resolve(); await first
  pending.state.statHold = null
  assert.equal(await pending.read(pending.row('after-publication')), 'miss')
  assert.equal(pending.state.reads, 2, 'late directory miss restored invalidated publication evidence')
  assert.equal(pending.state.stats, 2)

  const concurrent = hydrationFixture(), together = gate()
  concurrent.state.statHold = together
  const pair = [concurrent.read(concurrent.row('owner-a')), concurrent.read(concurrent.row('owner-b'))]
  for (let i = 0; concurrent.state.stats < 2 && i < 200; i++) await Promise.resolve()
  assert.equal(concurrent.state.stats, 2, 'independent cancellable owners were merged')
  assert.equal(new Set(concurrent.state.signals).size, 2, 'owners lost independent abort signals')
  together.resolve(); assert.deepEqual(await Promise.all(pair), ['miss', 'miss'])
  concurrent.state.statHold = null
  assert.equal(await concurrent.read(concurrent.row('owner-c')), 'miss')
  assert.equal(concurrent.state.reads, 2, 'settled directory evidence was not reused')

  const cancelled = hydrationFixture(), blocked = gate()
  cancelled.state.statHold = blocked
  const item = cancelled.row('cancelled-owner'), task = cancelled.read(item)
  for (let i = 0; !cancelled.state.stats && i < 100; i++) await Promise.resolve()
  assert.equal(cancelled.state.stats, 1)
  const render = cancelled.load('src/main/preview/runtime/previewImageCommitRuntime.ts').claimPreviewImage(item.outputPath, 'render')
  assert(cancelled.state.signals.at(-1).aborted)
  blocked.resolve(); assert.equal(await task, 'cancelled'); await render.release()
  cancelled.state.statHold = null; cancelled.state.readCode = undefined; cancelled.state.statCode = undefined
  assert.equal(await cancelled.read(item), 'hydrated', 'cancelled owner left negative evidence')
  assert.equal(cancelled.state.reads, 2)
}

async function main() {
  await maintenanceCases(); await hydrationCases()
  console.log('PASS optional directory ENOENT, maintenance failure distinctions, bounded sibling probe reuse, generation/path/TTL/publication invalidation and cancellation ownership')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
