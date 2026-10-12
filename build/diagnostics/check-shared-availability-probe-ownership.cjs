#!/usr/bin/env node
// Production status/identity/availability/scheduler owners; only process and
// local-database ports and the clock are controlled. Run on Windows with the
// existing root-probe-lifecycle physical process/pool controls.
const assert = require('node:assert/strict')
const path = require('node:path')
const { EventEmitter } = require('node:events')
const { loader } = require('./check-operation-chain.cjs')
const root = path.resolve(__dirname, '../..'), abs = file => path.join(root, file)
const deadlineRuntime = loader({ [abs('src/main/path/sharedFileSystemRuntime.ts')]: { sharedFileSystem: {} } })('src/main/path/ioDeadlineRuntime.ts')
const plain = value => JSON.parse(JSON.stringify(value))
const flush = () => new Promise(resolve => setImmediate(resolve))
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
const rootA = '\\\\nas\\share\\fonts', rootB = '\\\\nas\\other\\fonts'

function fixture({ roots = [rootA], ttl = 30000, timeout = 500, mode = 'online' } = {}) {
  let now = 0, configured = roots, behavior = mode, mapping = new Map([['Z:', '\\\\nas\\share']])
  let closing = false, epoch = 1, sequence = 0, configurationReads = 0, mapStarts = 0, starts = 0, closes = 0, peak = 0
  const timers = new Map(), probes = [], startsAt = []
  class Clock extends Date { static now() { return now } }
  const setTimer = (run, ms) => { const timer = { id: ++sequence, run, at: now + Math.max(0, ms), unref() {} }; timers.set(timer.id, timer); return timer }
  const clearTimer = timer => { if (timer) timers.delete(timer.id) }
  const normalPath = value => path.win32.normalize(String(value).replaceAll('/', '\\'))
  const load = loader({
    'node:child_process': {
      execFile(_file, args, _options, done) {
        assert.equal(args[0], '--mapped-drive-table'); mapStarts++
        done(null, JSON.stringify([...mapping].map(([drive, remote]) => ({ drive, remote }))))
      },
      spawn() { throw Error('Unexpected uncontrolled process start') },
    },
    [abs('src/main/rust-core/rustCoreWorkerPathRuntime.ts')]: { resolveRustCoreWorkerPath: () => 'fixture-worker.exe' },
    [abs('src/main/path/sharedIoProcessRuntime.ts')]: { SharedIoProcessError: class extends Error { constructor(message, outcome, reason) { super(message); Object.assign(this, { sharedIo: true, outcome, reason }) } } },
    [abs('src/main/app/shutdownCoordinatorRuntime.ts')]: { isApplicationClosing: () => closing, applicationWorkEpoch: () => epoch },
    [abs('src/main/path/ioDeadlineRuntime.ts')]: { ...deadlineRuntime, unavailableRootTtlMs: () => ttl, uncRootProbeTimeoutMs: () => timeout },
    [abs('src/main/path/sharedPathProbeRuntime.ts')]: {
      probeStartupDirectory: (value, rootId, budget, options) => {
        starts++; startsAt.push(now); peak = Math.max(peak, starts - closes)
        assert.equal(budget, timeout); assert.equal(options.registerRoot, false)
        const result = { directory: true, physicalPath: /^[a-z]:/i.test(value) ? rootId : normalPath(value), queuedMs: 0, executionMs: 1 }
        if (behavior !== 'held') {
          closes++
          if (behavior === 'offline') return Promise.reject(Object.assign(Error('offline'), { reason: 'ENETUNREACH' }))
          if (behavior === 'rejected-close') return Promise.reject(Object.assign(Error('offline'), { sharedIo: true, reason: 'ENETUNREACH', closed: Promise.reject(Error('close observation failed')) }))
          if (behavior === 'ordinary-close') return Promise.reject(Object.assign(Error('ordinary failure'), { reason: 'ENETUNREACH', closed: new Promise(() => {}) }))
          if (behavior === 'queue') return Promise.reject(Object.assign(Error('busy'), { reason: 'queue-timeout', queuedMs: 3000, executionMs: 0 }))
          return Promise.resolve(result)
        }
        const logical = deferred(), physical = deferred()
        const probe = { value, rootId, signal: options.signal, closed: false,
          fail(reason = 'timeout') { logical.reject(Object.assign(Error(reason), { sharedIo: true, reason, closed: physical.promise, queuedMs: 0, executionMs: 500 })) },
          close(receipt = result) { assert(!probe.closed); probe.closed = true; closes++; physical.resolve(); logical.resolve(receipt) },
        }
        options.signal?.addEventListener('abort', () => probe.fail('cancelled'), { once: true })
        probes.push(probe)
        return logical.promise
      },
    },
  }, { process: { ...process, platform: 'win32', env: { ...process.env, SystemDrive: 'C:' } }, Date: Clock, setTimeout: setTimer, clearTimeout: clearTimer })
  const availability = load('src/main/path/startupPathAvailabilityRuntime.ts')
  const db = { prepare: sql => ({
    all: () => sql.includes('FROM folders') ? configured.map(path => ({ path })) : [{ name: 'retained' }],
    get: () => undefined,
  }) }
  const read = load('src/main/path/sharedAvailabilityRuntime.ts').createSharedAvailabilityReader(async () => db)
  const scheduler = load('src/main/path/sharedAvailabilityProbeSchedulerRuntime.ts').createSharedAvailabilityProbeScheduler({ readRoots: async () => { configurationReads++; return [...configured] } })
  async function advance(ms) {
    const target = now + ms
    for (let budget = 0; ; budget++) {
      assert(budget < 10000, 'scheduler made no progress on the fake clock')
      const timer = [...timers.values()].filter(timer => timer.at <= target).sort((a, b) => a.at - b.at || a.id - b.id)[0]
      if (!timer) break
      now = timer.at; timers.delete(timer.id); timer.run(); await flush()
    }
    now = target; await flush()
  }
  return { load, availability, read, scheduler, advance, probes, startsAt,
    counts: () => ({ starts, closes, mapStarts, peak, configurationReads, timers: timers.size }),
    setMode: value => { behavior = value }, setRoots: value => { configured = value }, setMapping: value => { mapping = value },
    setClosing: value => { closing = value; epoch++ },
  }
}

async function pureStatus() {
  const f = fixture({ roots: ['Z:\\fonts', rootA, 'C:\\fonts'] })
  for (let i = 0; i < 2000; i++) { await f.advance(1500); const snapshot = await f.read(); assert(snapshot.roots.every(root => root.state === 'checking')) }
  assert.equal(f.counts().starts, 0); assert.equal(f.counts().mapStarts, 0); assert.equal(f.counts().timers, 0)
  let snapshot = await f.read()
  assert.equal(snapshot.roots[0].resourceKeys, undefined, 'unknown mapped drive became proven local')
  assert.deepEqual(plain(snapshot.roots[1].resourceKeys), ['\\\\nas\\share'])
  assert.deepEqual(plain(snapshot.roots[2].resourceKeys), [])
  assert.equal(await f.availability.ensureStartupPathRootAvailable('Z:\\fonts'), true)
  snapshot = await f.read(); assert.deepEqual(plain(snapshot.roots[0].resourceKeys), ['\\\\nas\\share'])
  const before = f.counts()
  for (let i = 0; i < 2000; i++) { await f.advance(1500); snapshot = await f.read() }
  assert.equal(f.counts().starts, before.starts); assert.equal(f.counts().mapStarts, before.mapStarts)
  assert.equal(snapshot.roots[0].resourceKeys, undefined, 'expired mapping was treated as a fresh local proof')
}

async function autonomousRecoveryAndBackoff() {
  for (const mode of ['offline', 'online']) {
    const f = fixture({ mode })
    assert.equal(f.availability.getStartupPathRootState(rootA).state, 'checking')
    f.scheduler.start(); f.scheduler.start(); await f.advance(0)
    assert.equal(f.counts().starts, 1); assert.equal(f.counts().timers, 1)
    await f.advance(510000)
    assert.deepEqual(f.startsAt, [0, 30000, 90000, 210000, 510000], `${mode} did not obey the central adaptive deadline`)
    assert.equal(f.counts().peak, 1); await f.scheduler.stop(); assert.equal(f.counts().timers, 0)
  }
  const f = fixture({ mode: 'offline' })
  f.scheduler.start(); await f.advance(0)
  const offlineGeneration = f.availability.getStartupPathRootState(rootA).generation
  for (let i = 0; i < 5; i++) {
    await f.advance(5000)
    f.availability.markStartupPathRootUnavailable(rootA, Error('same optional failure'))
    assert.equal(f.availability.getStartupPathRootState(rootA).generation, offlineGeneration)
  }
  f.setMode('online'); await f.advance(5000)
  assert.equal(f.counts().starts, 2, 'optional observations continually postponed recovery')
  assert.equal(f.availability.getStartupPathRootState(rootA).state, 'online')
  assert(f.availability.getStartupPathRootState(rootA).generation > offlineGeneration)
  const g = f.availability.getStartupPathRootState(rootA).generation
  await f.advance(2000)
  await f.availability.ensureStartupPathRootAvailable(rootA, undefined, 'shared-watcher-poll', { background: true })
  assert.equal(f.counts().starts, 2, 'background poll forced a foreground-TTL check')
  await f.availability.ensureStartupPathRootAvailable(rootA)
  assert.equal(f.counts().starts, 3, 'expired-online foreground request skipped its fresh probe')
  assert.equal(f.availability.getStartupPathRootState(rootA).generation, g)
  await f.scheduler.stop()
}

async function canonicalCoalescingAndRemap() {
  const f = fixture({ mode: 'held' })
  const mapped = f.availability.ensureStartupPathRootAvailable('Z:\\fonts\\.\\')
  const unc = f.availability.ensureStartupPathRootAvailable(rootA)
  await flush(); assert.equal(f.counts().starts, 1)
  const joined = f.availability.ensureStartupPathRootAvailable('z:/fonts', undefined, 'background', { background: true })
  assert.equal(f.availability.getStartupPathRootState('z:/fonts').rootId, f.availability.getStartupPathRootState(rootA).rootId)
  f.probes[0].close(); assert.deepEqual(await Promise.all([mapped, unc, joined]), [true, true, true])
  const resourceOwner = f.load('src/main/rust-core/rustSharedIoCommandRuntime.ts')
  assert.equal(resourceOwner.sharedIoAvailabilityRoot(rootA + '\\cached.png'), 'z:\\fonts', 'verified physical alias escaped the configured logical availability owner')
  const before = f.availability.getStartupPathRootState(rootA)
  f.setMapping(new Map([['Z:', '\\\\nas\\replacement']]))
  await f.advance(31000)
  assert.equal(await f.availability.ensureStartupPathRootAvailable('Z:\\fonts'), false)
  const remapped = f.availability.getStartupPathRootState('Z:\\fonts')
  assert.equal(remapped.rootId, before.rootId); assert.equal(remapped.state, 'offline'); assert(remapped.generation > before.generation)
  assert.equal(f.counts().starts, 1, 'remapped identity started work under the old root')
  const held = fixture()
  await held.availability.ensureStartupPathRootAvailable('Z:\\fonts')
  await held.advance(31000); held.setMode('held')
  const uncPending = held.availability.ensureStartupPathRootAvailable(rootA)
  await flush(); held.setMapping(new Map([['Z:', '\\\\nas\\replacement']]))
  assert.equal(await held.availability.ensureStartupPathRootAvailable('Z:\\fonts'), false, 'mapped caller joined an old UNC promise without checking a remap')
  held.probes[0].close(); assert.equal(await uncPending, false, 'late old-root receipt overwrote the remap rejection')
}

async function admissionFreshnessAndScopedWrites() {
  const f = fixture({ roots: [rootA, rootB] })
  await f.availability.ensureStartupPathRootAvailable(rootA)
  f.availability.markStartupPathRootUnavailable(rootB, Error('unrelated offline root'))
  const admit = f.load('src/main/ipc/sharedActionAdmissionRuntime.ts').createSharedActionAdmission(f.read)
  const font = { id: 'fixture-font', path: rootA + '\\a.ttf' }
  await f.advance(2000)
  const before = f.counts().starts
  const first = await admit('fonts:activateFont', [font])
  assert.equal(f.counts().starts, before + 1, 'configured mutation used an expired online DTO as fresh authority')
  assert.equal(f.availability.getStartupPathRootState(rootB).state, 'offline', 'unrelated offline root was probed by a targeted action')
  const after = f.counts().starts
  for (const [channel, args] of [
    ['library:getSharedAvailability', []], ['fonts:queryPage', [{ selectedWatchedFolders: [rootA] }]],
    ['fonts:loadFolderCache', [[rootA]]], ['fonts:renderPreviewImage', [font]],
    ['fonts:setLocalTags', [font, ['local']]], ['library:save', [{ tags: ['retained'], folders: [] }]],
  ]) await admit(channel, args)
  assert.equal(f.counts().starts, after, 'status/cache/preview/local configuration admission forced background probes')

  const queued = deferred()
  let writes = 0
  const pending = f.availability.withStartupPathRootGuard(first, async () => {
    await queued.promise
    f.availability.assertStartupPathRootGuardCurrent()
    writes++
  })
  f.availability.markStartupPathRootUnavailable(rootA, Error('changed before side effect'))
  queued.resolve(); await assert.rejects(pending, /共享位置/); assert.equal(writes, 0)
  await f.advance(30000); await f.availability.ensureStartupPathRootAvailable(rootA)
  const renewed = await admit('fonts:activateFont', [font])
  const committed = await f.availability.withStartupPathRootGuard(renewed, async () => {
    writes++
    f.availability.markStartupPathRootUnavailable(rootA, Error('changed after commit'))
    return { committed: true }
  })
  assert.equal(committed.committed, true, 'late generation change discarded a confirmed write receipt')
  assert.equal(writes, 1)

  let outer = true, inner = true
  const requireOuter = () => assert(outer, 'outer lease stale'), requireInner = () => assert(inner, 'inner lease stale')
  await f.availability.withStartupPathRootGuard(requireOuter, async () => {
    await f.availability.withStartupPathRootGuard(requireInner, async () => {
      await flush(); outer = false
      assert.throws(() => f.availability.assertStartupPathRootGuardCurrent(), /outer lease stale/)
      outer = true; inner = false
      assert.throws(() => f.availability.assertStartupPathRootGuardCurrent(), /inner lease stale/)
      inner = true
    })
    f.availability.assertStartupPathRootGuardCurrent()
  })
  f.availability.assertStartupPathRootGuardCurrent()
  f.setClosing(true)
  const closingStarts = f.counts().starts
  let persisted = 0
  const closeSafe = await admit('library:save', [{ tags: ['retained'], folders: [] }])
  await f.availability.withStartupPathRootGuard(closeSafe, async () => { persisted++; return true })
  assert.equal(persisted, 1, 'unchanged shared tags blocked local shutdown persistence')
  await assert.rejects(admit('library:save', [{ tags: ['changed'], folders: [] }]), /共享位置/)
  f.setRoots([])
  await assert.rejects(admit('library:save', [{ tags: ['changed'], folders: [] }]), /共享位置/)
  assert.equal(f.counts().starts, closingStarts, 'close-safe persistence or rejected shared edits started a probe during shutdown')
}

async function queuedSpawnUsesCapturedScope() {
  const f = fixture()
  await f.availability.ensureStartupPathRootAvailable(rootA)
  const admit = f.load('src/main/ipc/sharedActionAdmissionRuntime.ts').createSharedActionAdmission(f.read)
  const guard = await admit('fonts:activateFont', [{ path: rootA + '\\a.ttf' }])
  const children = []
  const spawn = () => {
    const child = new EventEmitter(), stream = () => Object.assign(new EventEmitter(), { setEncoding() {}, end() {} })
    Object.assign(child, { pid: children.length + 100, stdout: stream(), stderr: stream(), stdin: stream(), stdio: [null, null, null, stream()], kill() { return true } })
    child.once('close', () => { child.closed = true })
    children.push(child); return child
  }
  const poolLoad = loader({
    'node:child_process': { spawn },
    [abs('src/main/app/shutdownCoordinatorRuntime.ts')]: { isApplicationClosing: () => false, onApplicationClosing() {} },
    [abs('src/main/logging/startupLogPolicy.ts')]: { detailedStartupLogsEnabled: () => false },
    [abs('src/main/logging/operationTraceContext.ts')]: { currentOperationTrace() {}, logOperation() {}, recordOperationWork() {} },
  })
  const pool = poolLoad('src/main/path/sharedIoProcessRuntime.ts').createSharedIoProcessRuntime(() => {})
  try {
    const blocker = pool.run({ file: 'fixture.exe', args: [], roots: ['same'], write: true, timeoutMs: 5000 })
    blocker.catch(() => undefined)
    const requested = f.availability.withStartupPathRootGuard(guard, () => pool.run({ file: 'fixture.exe', args: [], roots: ['same'], write: true, timeoutMs: 5000,
      admit: () => { try { f.availability.assertStartupPathRootGuardCurrent(); return true } catch { return false } },
    })).catch(error => error)
    assert.equal(children.length, 1); assert.equal(pool.status().queued, 1)
    f.availability.markStartupPathRootUnavailable(rootA, Error('alias changed while queued'))
    children[0].emit('close', 0, null); await blocker
    const rejected = await requested
    assert.equal(rejected.reason, 'stale-generation'); assert.equal(rejected.outcome, 'not-started')
    assert.equal(children.length, 1, 'queued old-generation writer physically spawned')
    await rejected.closed; await pool.whenIdle()
  } finally { pool.stop(); for (const child of children) if (!child.closed) child.emit('close', 1, null); await pool.whenIdle() }
}

async function physicalCloseAndGeneration() {
  const f = fixture({ mode: 'held' })
  let settled = false
  const one = f.availability.ensureStartupPathRootAvailable(rootA).then(value => { settled = true; return value })
  await flush(); f.probes[0].fail(); await flush()
  const duplicate = f.availability.ensureStartupPathRootAvailable(rootA)
  await f.advance(600000)
  assert.equal(settled, false); assert.equal(f.counts().starts, 1, 'logical timeout released the canonical physical owner')
  f.availability.markStartupPathRootUnavailable(rootA, Error('new root evidence'))
  const generation = f.availability.getStartupPathRootState(rootA).generation
  f.probes[0].close(); assert.equal(await one, false); assert.equal(await duplicate, false)
  assert.equal(f.availability.getStartupPathRootState(rootA).generation, generation)
  assert.equal(f.availability.getStartupPathRootState(rootA).state, 'offline')
  const rejected = fixture({ mode: 'rejected-close' })
  assert.equal(await rejected.availability.ensureStartupPathRootAvailable(rootA), false)
  assert.equal(rejected.availability.getStartupPathRootState(rootA).state, 'offline', 'close rejection discarded original outage evidence')
  const ordinary = fixture({ mode: 'ordinary-close' })
  assert.equal(await ordinary.availability.ensureStartupPathRootAvailable(rootA), false, 'unbranded arbitrary closed property became a physical ownership wait')
  const queued = fixture({ mode: 'queue' })
  assert.equal(await queued.availability.ensureStartupPathRootAvailable(rootA), false)
  assert.equal(queued.availability.getStartupPathRootState(rootA).state, 'checking', 'not-started queue failure became an outage')
}

async function stopResumeAndConfiguration() {
  const f = fixture({ mode: 'held' })
  f.scheduler.start(); await f.advance(0); assert.equal(f.counts().starts, 1)
  f.setClosing(true); let stopped = false
  const stopping = f.scheduler.stop().then(() => { stopped = true })
  await flush(); assert(f.probes[0].signal.aborted); assert.equal(stopped, false)
  f.setClosing(false); f.scheduler.start(); f.scheduler.start(); await f.advance(10000)
  assert.equal(f.counts().starts, 1, 'resume launched a replacement before physical close')
  f.probes[0].close(); await stopping
  assert.equal(f.availability.getStartupPathRootState(rootA).state, 'checking', 'stale shutdown receipt published online')
  await f.advance(5000); assert.equal(f.counts().starts, 2); assert.equal(f.counts().peak, 1)
  f.setRoots([]); await f.advance(5000); assert(f.probes[1].signal.aborted, 'removed root retained its scheduled owner')
  f.probes[1].close(); await flush(); assert.equal(f.availability.getStartupPathRootState(rootA).state, 'checking')
  f.setMode('online'); f.setRoots([rootB]); await f.advance(5000)
  assert.equal(f.availability.getStartupPathRootState(rootB).state, 'online', 'added root did not initialize without a status poll')
  await f.scheduler.stop(); assert.equal(f.counts().starts, f.counts().closes); assert.equal(f.counts().timers, 0)
}

async function differingDeadlinesDoNotSpin() {
  const f = fixture({ ttl: 100, timeout: 5000 })
  f.scheduler.start(); await f.advance(20000)
  assert(f.counts().configurationReads <= 12, 'short background delay repeatedly read the local DB before online freshness expired')
  assert(f.counts().starts <= 5); await f.scheduler.stop()
  const rejected = fixture()
  let attempts = 0
  rejected.availability.ensureStartupPathRootAvailable = async () => { attempts++; throw Error('unexpected owner rejection') }
  rejected.scheduler.start(); await rejected.advance(20000)
  assert(attempts <= 5, 'an unadvanced owner deadline created a zero-delay rejection loop')
  await rejected.scheduler.stop()
}

async function main() {
  await pureStatus(); await autonomousRecoveryAndBackoff(); await canonicalCoalescingAndRemap()
  await physicalCloseAndGeneration(); await stopResumeAndConfiguration(); await differingDeadlinesDoNotSpin()
  await admissionFreshnessAndScopedWrites(); await queuedSpawnUsesCapturedScope()
  console.log('[diagnostics:shared-availability-probe-ownership] pure status, cached identity, autonomous adaptive recovery, foreground freshness, alias/remap, physical close, stop/resume and configuration changes passed')
}
const watchdog = setTimeout(() => { console.error('availability ownership diagnostic did not reach its terminal receipt'); process.exitCode = 1 }, 30000)
main().then(() => clearTimeout(watchdog), error => { clearTimeout(watchdog); console.error(error); process.exitCode = 1 })
