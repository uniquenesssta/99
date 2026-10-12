'use strict'
// Windows-controlled scheduling/ownership ports. No NAS, installed font or registry mutation.
const assert = require('node:assert/strict')
const path = require('node:path')
const { EventEmitter } = require('node:events')
const { loader } = require('./check-operation-chain.cjs')
const root = path.resolve(__dirname, '../..')
const tick = () => new Promise(resolve => setImmediate(resolve))
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
let cases = 0
function clock() {
  let time = 0, id = 0
  const timers = new Map()
  return {
    now: () => time,
    setTimer(fn, delay) { const handle = { id: ++id, unref() {} }; timers.set(handle, { fn, at: time + delay }); return handle },
    clearTimer(handle) { timers.delete(handle) },
    nextDelay() { return Math.min(...[...timers.values()].map(item => item.at - time)) },
    async advance(ms) {
      const target = time + ms
      for (;;) {
        const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0]
        if (!next || next[1].at > target) break
        time = next[1].at; timers.delete(next[0]); next[1].fn(); await tick()
      }
      time = target; await tick()
    },
    count: () => timers.size,
  }
}
const inventory = (...files) => ({ rootPath: path.resolve(root, '.diagnostic-virtual', 'watch'), complete: true, files: new Map(files.map(([name, size = 1]) => [name, { size, mtimeMs: 1000 }])) })

async function scheduling() {
  const load = loader()
  const { createSharedFolderReconciliationRuntime: create } = load('src/main/watcher/sharedFolderReconciliationRuntime.ts')
  const clock1 = clock(), walk = deferred(), apply = deferred()
  let collecting = 0, applying = 0
  const monitor = create({ ...clock1, isCurrent: () => true, log() {},
    collect: async () => { collecting++; return collecting === 1 ? await walk.promise : inventory(['a.ttf']) },
    apply: async () => { applying++; return apply.promise },
  })
  monitor.start(); await clock1.advance(0)
  for (let i = 0; i < 100; i++) monitor.requestReconciliation()
  assert.equal(collecting, 1); assert.equal(clock1.count(), 0)
  walk.resolve(inventory(['a.ttf'])); await tick()
  assert.equal(applying, 1)
  for (let i = 0; i < 100; i++) monitor.requestReconciliation()
  await clock1.advance(5000); assert.equal(collecting, 1, 'apply owns root until acknowledged')
  apply.resolve(true); await tick()
  assert.equal(clock1.nextDelay(), 1000, 'events during walk/apply require one follow-up')
  await clock1.advance(1000); assert.equal(collecting, 2); assert.equal(applying, 1, 'unchanged inventory skips index work')
  monitor.close(); assert.equal(clock1.count(), 0); cases++

  const clock2 = clock(); let current = inventory(['a.ttf']), confirmed = true, writes = 0, offline = false
  const retry = create({ ...clock2, isCurrent: () => true, log() {}, collect: async () => { if (offline) throw Error('offline'); return current }, apply: async () => { writes++; return confirmed } })
  retry.start(); await clock2.advance(0); assert.equal(writes, 1)
  current = inventory(['b.ttf']); confirmed = false; retry.requestReconciliation(); await clock2.advance(1000)
  assert.equal(writes, 2); assert.equal(clock2.nextDelay(), 30000)
  // Partial durable writes may exist even if disk later reverts to the prior baseline.
  current = inventory(['a.ttf']); confirmed = true; await clock2.advance(30000)
  assert.equal(writes, 3, 'failed apply must not suppress retry after a disk revert'); cases++
  offline = true; retry.requestReconciliation(); await clock2.advance(1000)
  for (const delay of [30000, 60000, 120000, 240000, 300000]) {
    assert.equal(clock2.nextDelay(), delay)
    retry.requestReconciliation(); assert.equal(clock2.nextDelay(), delay, 'offline events cannot bypass retry budget')
    await clock2.advance(delay)
  }
  assert.equal(writes, 3); assert.equal(retry.status().committed, true, 'offline never erases baseline')
  retry.requestReconciliation(true); assert.equal(clock2.nextDelay(), 1000, 'delivered notification can accelerate reconnection catch-up')
  await clock2.advance(1000); assert.equal(clock2.nextDelay(), 300000)
  retry.requestReconciliation(true); assert.equal(clock2.nextDelay(), 300000, 'notification storms cannot bypass offline retry budget repeatedly')
  offline = false; current = inventory(['reconnected.ttf']); await clock2.advance(clock2.nextDelay())
  assert.equal(writes, 4); assert.equal(retry.status().failures, 0); retry.close(); cases++

  const clock3 = clock(); let attempts = 0
  const initial = create({ ...clock3, isCurrent: () => true, log() {}, collect: async () => inventory(['first.ttf']), apply: async () => ++attempts > 1 })
  initial.start(); await clock3.advance(0); assert.equal(initial.status().committed, false)
  await clock3.advance(30000); assert.equal(attempts, 2); assert.equal(initial.status().committed, true)
  for (const delay of [30000, 60000, 120000, 240000, 300000]) { assert.equal(clock3.nextDelay(), delay); await clock3.advance(delay) }
  initial.requestReconciliation(); assert.equal(clock3.nextDelay(), 1000)
  await clock3.advance(500); initial.requestReconciliation(); assert.equal(clock3.nextDelay(), 500, 'event storm cannot extend debounce')
  initial.close(); cases++

  const clock4 = clock(), blocked = deferred(); let late = 0, signal
  const stopped = create({ ...clock4, isCurrent: () => true, log() {}, collect: async value => { signal = value; return blocked.promise }, apply: async () => { late++; return true } })
  stopped.start(); await clock4.advance(0); stopped.close(); assert(signal.aborted)
  blocked.resolve(inventory(['late.ttf'])); await stopped.whenIdle(); assert.equal(late, 0); assert.equal(clock4.count(), 0); cases++

  for (const rejectClose of [false, true]) {
    const physicalClock = clock(), collection = deferred(), physicalClose = deferred()
    let published = 0, retired = false
    const owned = create({ ...physicalClock, isCurrent: () => true, log() {}, collect: async () => collection.promise, apply: async () => { published++; return true } })
    owned.start(); await physicalClock.advance(0); owned.close()
    const retiredTask = owned.whenIdle().then(() => { retired = true })
    collection.reject(Object.assign(Error('original collection cancellation'), { sharedIo: true, closed: physicalClose.promise })); await tick()
    assert.equal(retired, false, 'cancellation rejection does not release a collecting root before physical close')
    assert.equal(owned.status().lastCheckedAt, null); assert.equal(published, 0); assert.equal(physicalClock.count(), 0)
    if (rejectClose) physicalClose.reject(Error('close receipt failed')); else physicalClose.resolve()
    await retiredTask
    assert.equal(retired, true); assert.equal(published, 0); assert.equal(physicalClock.count(), 0, 'retired collection never retries or ACKs')
  }
  cases++

  const clock5 = clock(), hintedApply = deferred(), verified = []
  const hinted = create({ ...clock5, isCurrent: () => true, log() {}, collect: async () => inventory(['a.ttf'], ['b.ttf']),
    apply: async (_inventory, _signal, paths, progress) => {
      verified.push([...paths]); progress(paths.size)
      return verified.length === 2 ? hintedApply.promise : true
    },
  })
  assert.equal(hinted.status().lastCheckedAt, null)
  hinted.start(); await clock5.advance(0); assert.equal(hinted.status().lastCheckedAt, 0); assert.equal(hinted.status().pendingCount, 0)
  hinted.requestReconciliation(true, ['a.ttf']); await clock5.advance(1000)
  assert.deepEqual(verified[1], ['a.ttf'], 'same metadata plus concrete event must still verify selected content')
  assert.equal(hinted.status().phase, 'applying'); assert.equal(hinted.status().pendingCount, 1); assert.equal(hinted.status().lastCheckedAt, 0, 'parsing start is not successful completion')
  hinted.requestReconciliation(true, ['a.ttf', 'b.ttf']); assert.equal(hinted.status().pendingCount, null)
  hintedApply.resolve(true); await tick(); await clock5.advance(1000)
  assert.deepEqual(verified[2], ['a.ttf', 'b.ttf'], 'same-path hints arriving during apply survive old ACK')
  assert.equal(hinted.status().pendingCount, 0)
  const lastFullAck = hinted.status().lastCheckedAt
  hinted.requestReconciliation(true, Array.from({ length: 100 }, (_, i) => `burst-${i}.ttf`)); await clock5.advance(1000)
  assert.equal(verified[3].length, 64); assert.equal(clock5.nextDelay(), 1000)
  assert.equal(hinted.status().lastCheckedAt, lastFullAck, 'queued hint chunks are not a complete root ACK')
  await clock5.advance(1000); assert.equal(verified[4].length, 36); assert(hinted.status().lastCheckedAt > lastFullAck)
  hinted.close(); cases++
}

function fakeChild() {
  const child = new EventEmitter()
  child.stdin = new EventEmitter(); child.stdin.end = () => {}; child.stdout = new EventEmitter(); child.stdout.setEncoding = () => {}; child.stderr = new EventEmitter()
  child.kills = []; child.kill = signal => { child.kills.push(signal); return true }
  child.receipt = (type, paths = ['controlled.ttf']) => child.stdout.emit('data', JSON.stringify({ protocol: 1, type, ...(type === 'change' ? { paths } : {}) }) + '\n')
  return child
}
async function notifications() {
  const timer = clock(), children = [], logs = []
  const FakeDate = class extends Date { static now() { return timer.now() } }
  const load = loader({}, { Date: FakeDate, setTimeout: timer.setTimer, clearTimeout: timer.clearTimer })
  const create = load('src/main/watcher/sharedFolderNotificationRuntime.ts').createSharedFolderNotificationRuntime
  const manager = create({ getWorkerPath: async () => 'controlled-worker.exe', log: item => logs.push(item), spawnProcess: () => { const child = fakeChild(); children.push(child); return child } })
  let changes = 0
  const watch = manager.watch('controlled-root', () => changes++)
  const ready = watch.ensureStarted(); await tick()
  assert.equal(children.length, 1); children[0].receipt('registered'); await ready
  assert.equal(changes, 0, 'registration alone is not event delivery')
  children[0].receipt('change'); children[0].receipt('overflow'); assert.equal(changes, 2)
  assert(logs.some(item => item.includes('delivery observed')))
  watch.close(); assert.deepEqual(children[0].kills, ['SIGTERM'])
  let physicallyClosed = false; const closed = watch.whenClosed().then(() => { physicallyClosed = true })
  await tick(); assert.equal(physicallyClosed, false)
  children[0].emit('exit', 0); await tick(); assert.equal(physicallyClosed, false, 'exit alone does not release OS/stdio ownership')
  children[0].receipt('change'); assert.equal(changes, 2, 'no publication after stop')
  await timer.advance(1000); assert.deepEqual(children[0].kills, ['SIGTERM', 'SIGKILL'])
  children[0].emit('close'); await closed; await manager.whenClosed(); assert.equal(timer.count(), 0); cases++

  const hung = manager.watch('hung-root', () => changes++)
  const registration = hung.ensureStarted(); await tick(); const blocked = children.at(-1)
  await timer.advance(5000); await registration
  assert.equal(blocked.kills[0], 'SIGTERM')
  const count = children.length; await timer.advance(300000); await hung.ensureStarted()
  assert.equal(children.length, count, 'timed-out child retains its slot and root ownership until physical close')
  blocked.receipt('registered'); assert.equal(blocked.kills.length, 2, 'late registration cannot revive failed child')
  blocked.emit('close'); const restart = hung.ensureStarted(); await tick(); assert.equal(children.length, count + 1)
  children.at(-1).receipt('registered'); await restart; hung.close(); children.at(-1).emit('close'); await hung.whenClosed(); cases++

  const unsupported = create({ getWorkerPath: async () => undefined, log() {}, spawnProcess: () => { throw Error('must not spawn') } }).watch('unsupported', () => {})
  await unsupported.ensureStarted(); await unsupported.ensureStarted(); unsupported.close(); await unsupported.whenClosed(); cases++

  const saturated = [], starts = []
  for (let i = 0; i < 12; i++) { const item = manager.watch('root-' + i, () => {}); saturated.push(item); starts.push(item.ensureStarted()) }
  await tick()
  const running = children.slice(count + 1)
  assert.equal(running.length, 8, 'persistent children have a hard pool cap; excess roots retain polling')
  for (const child of running) child.receipt('registered')
  await Promise.all(starts)
  for (const item of saturated) item.close()
  for (const child of running) child.emit('close')
  await Promise.all(saturated.map(item => item.whenClosed())); await manager.whenClosed(); cases++

  const early = manager.watch('early-exit', () => {})
  const earlyReady = early.ensureStarted(); await tick(); const broken = children.at(-1)
  broken.stdin.emit('error', Object.assign(Error('broken pipe'), { code: 'EPIPE' })); await earlyReady
  assert.equal(broken.kills[0], 'SIGTERM', 'owned pipe errors cannot crash main')
  early.close(); broken.stdout.emit('error', Error('closed pipe')); broken.stderr.emit('error', Error('closed pipe'))
  broken.emit('close'); await early.whenClosed(); cases++

  for (const invalid of ['{"protocol":1,"type":"registered","extra":true}\n', '[]\n', '{broken\n', 'x'.repeat(16385), '{"protocol":1,"type":"change","paths":["../escape.ttf"]}\n']) {
    const malformed = manager.watch('malformed', () => {})
    const pending = malformed.ensureStarted(); await tick(); const child = children.at(-1)
    child.stdout.emit('data', invalid); await pending
    assert.equal(child.kills[0], 'SIGTERM'); malformed.close(); child.emit('close'); await malformed.whenClosed()
  }
  cases++

  const silent = manager.watch('silent-monitor', () => changes++)
  const silentReady = silent.ensureStarted(); await tick(); const silentChild = children.at(-1)
  silentChild.receipt('registered'); await silentReady
  await timer.advance(15000); assert.equal(silentChild.kills[0], 'SIGTERM', 'missing heartbeat falls back without waiting for a filesystem event')
  silent.close(); silentChild.emit('close'); await silent.whenClosed(); cases++
}

async function folderIntegration() {
  const timer = clock(), trace = [], callback = { close: false }
  let applyCount = 0, snapshotCount = 0, mergedCount = 0, projectionCount = 0
  let current = { 'a.ttf': [1, '1000000000'] }, fail = true, closing = false
  const mocks = {
    electron: { BrowserWindow: { getAllWindows: () => [{ isDestroyed: () => false, webContents: { send: (_channel, value) => { projectionCount++; trace.push(value) } } }] } },
    [path.join(root, 'src/main/logging/operationTraceContext.ts')]: { withOperationWork: (_kind, _log, work) => work() },
    [path.join(root, 'src/main/app/shutdownCoordinatorRuntime.ts')]: { isApplicationClosing: () => closing, onApplicationResumed() {} },
    [path.join(root, 'src/main/rust-core/rustSharedIoCommandRuntime.ts')]: { sharedIoResourceKeys: async () => ['controlled-share'] },
    [path.join(root, 'src/main/path/sharedFileSystemRuntime.ts')]: { withSharedIoSignal: (_signal, work) => work(), sharedFileSystem: {}, executeSharedFile: async (_request, _bytes, signal) => { assert(!signal.aborted); snapshotCount++; return { result: { value: current } } } },
    [path.join(root, 'src/main/path/startupPathAvailabilityRuntime.ts')]: { ensureStartupPathRootAvailable: async () => true },
    [path.join(root, 'src/main/path/cachePath.ts')]: { normalizePathForCacheCompare: value => value.toLowerCase().replaceAll('\\', '/') },
    [path.join(root, 'src/main/watcher/sharedFolderNotificationRuntime.ts')]: { createSharedFolderNotificationRuntime: () => ({ watch: (_folder, changed) => { callback.changed = changed; return { ensureStarted: async () => { trace.push('armed') }, invalidate() {}, close() { callback.close = true }, whenClosed: async () => {} } }, whenClosed: async () => {} }) },
  }
  const FakeDate = class extends Date { static now() { return timer.now() } }
  const create = loader(mocks, { Date: FakeDate, setTimeout: timer.setTimer, clearTimeout: timer.clearTimer })('src/main/watcher/folderWatcherRuntime.ts').createFolderWatcherRuntime
  const options = { appendStartupLog() {}, isIgnoredWatcherPath: () => false, verboseLogs: false, startupGraceMs: 0, flushDebounceMs: 0, closeRuntimeDatabases() {},
    watcherChangeBatchLooksUnchanged: async () => { throw Error('inventory must skip separate preflight') },
    applyWatchedFolderChangesToIndex: async (_changes, _replay, context) => {
      applyCount++; assert(context.inventory.complete); assert.equal(trace[0], 'armed'); context.assertCurrent()
      if (fail) throw Error('controlled apply failure')
      return { source: 'watcher', at: new Date().toISOString(), upserts: [], deletes: [], errors: [] }
    },
    syncMergedIndexForRootSnapshot: async () => { mergedCount++ },
  }
  const runtime = create(options)
  await runtime.startWatchingFolders([inventory().rootPath]); await timer.advance(0)
  assert.equal(snapshotCount, 1); assert.equal(applyCount, 1); assert.equal(projectionCount, 0)
  fail = false; await timer.advance(30000)
  assert.equal(snapshotCount, 2); assert.equal(applyCount, 2, 'same initial inventory retries after failed apply')
  assert.equal(mergedCount, 1, 'failed apply projection is repaired once')
  await timer.advance(30000); assert.equal(snapshotCount, 3); assert.equal(applyCount, 2)
  const before = projectionCount; closing = true; runtime.stopFolderWatchers(); callback.changed(); await runtime.awaitFolderWatchersClosed()
  assert(callback.close); await timer.advance(300000); assert.equal(projectionCount, before); assert.equal(timer.count(), 0); cases++

  closing = false; trace.length = 0
  const clean = create(options)
  await clean.startWatchingFolders([inventory().rootPath]); await timer.advance(0)
  assert.equal(mergedCount, 2, 'startup repairs checkpoint rows whose prior process never published the merged projection')
  assert.equal(projectionCount, before + 1, 'startup projection repair publishes one invalidation')
  assert.equal(clean.getSharedWatchStatus().roots[0].pendingCount, 0)
  await timer.advance(30000); assert.equal(mergedCount, 2, 'subsequent unchanged polls perform no merged rewrite')
  clean.stopFolderWatchers(); await clean.awaitFolderWatchersClosed(); cases++

  const parsed = deferred(); let manualActive = false, writes = 0
  const preempted = create({ ...options, isScanActive: () => manualActive,
    applyWatchedFolderChangesToIndex: async (_changes, _replay, context) => {
      context.assertCurrent(); await parsed.promise; context.assertCurrent(); writes++
      return { source: 'watcher', at: new Date().toISOString(), upserts: [], deletes: [], errors: [] }
    },
  })
  await preempted.startWatchingFolders([inventory().rootPath]); await timer.advance(0)
  manualActive = true; parsed.resolve(); await tick()
  assert.equal(writes, 0, 'manual scan starting after watcher admission preempts commit')
  assert.equal(mergedCount, 2); assert.equal(preempted.getSharedWatchStatus().roots[0].lastCheckedAt, null)
  manualActive = false; await timer.advance(30000)
  assert.equal(writes, 1); assert.equal(mergedCount, 3, 'fresh reconciliation resumes after manual scan')
  preempted.stopFolderWatchers(); await preempted.awaitFolderWatchersClosed(); cases++

  for (const rejectClose of [false, true]) {
    const applying = deferred(), physicalClose = deferred(); let retired = false
    const ownedApply = create({ ...options, applyWatchedFolderChangesToIndex: async () => applying.promise })
    await ownedApply.startWatchingFolders([inventory().rootPath]); await timer.advance(0)
    ownedApply.stopFolderWatchers()
    const retiredTask = ownedApply.awaitFolderWatchersClosed().then(() => { retired = true })
    applying.reject(Object.assign(Error('original apply cancellation'), { sharedIo: true, closed: physicalClose.promise })); await tick()
    assert.equal(retired, false, 'flush retirement must await an isolated parser/read child physical close')
    const sent = projectionCount, merged = mergedCount
    if (rejectClose) physicalClose.reject(Error('close receipt failed')); else physicalClose.resolve()
    await retiredTask
    assert.equal(retired, true); assert.equal(projectionCount, sent); assert.equal(mergedCount, merged); assert.equal(timer.count(), 0)
  }
  cases++
}

function receipts() {
  const decode = loader().call(null, 'src/main/watcher/sharedWatcherInventoryRuntime.ts').sharedWatcherInventory
  const value = decode('controlled-root', { 'family\\font.ttf': [100, '1000123456'], 'before.ttf': [2, '-1234567'] })
  assert.equal(value.files.get('family/font.ttf').mtimeMs, 1000.123456)
  assert.equal(value.files.get('before.ttf').mtimeMs, -1.234567)
  for (const invalid of [{ '../escape.ttf': [1, '1'] }, { 'A.ttf': [1, '1'], 'a.ttf': [1, '1'] }, { 'a.ttf': [1, 'bad'] }, { 'a.ttf': [Number.MAX_SAFE_INTEGER + 1, '1'] }]) assert.throws(() => decode('controlled-root', invalid))
  cases++
}

async function main() { await scheduling(); await notifications(); await folderIntegration(); receipts(); console.log(`shared watcher reconciliation diagnostics: ${cases} cases passed`) }
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1 })
module.exports = { main }
