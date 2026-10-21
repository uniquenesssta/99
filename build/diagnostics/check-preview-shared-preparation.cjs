#!/usr/bin/env node
// Windows diagnostic. Production preparation, publication, physical-deadline
// owner and scheduler run together; the OS filesystem and child process are ports.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { EventEmitter } = require('node:events')
const { AsyncLocalStorage } = require('node:async_hooks')
const { loader } = require('./check-operation-chain.cjs')
const png = require('./fixtures/preview-png.cjs')
const base = 'src/main/preview/runtime/'
const tick = () => new Promise(resolve => setImmediate(resolve))
const gate = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }
async function flush() { for (let i = 0; i < 12; i++) await tick() }
async function observedAdmissionAndExecution() {
  const h = harness(), observations = []
  try {
    const scope = h.load('src/main/path/sharedIoSchedulingScope.ts')
    const reader = h.read(h.roots.a)
    const writer = scope.withSharedIoObservation(value => observations.push(value), () => h.pool.run({
      file: 'fake-worker', args: ['owned-write'], roots: [h.roots.a], write: true, timeoutMs: 5000,
      accesses: [{ root: h.roots.a, path: h.roots.a.toLowerCase().replaceAll('/', '\\'), mode: 'write', scope: 'tree' }],
    }))
    writer.catch(() => {})
    assert.equal(observations.length, 1)
    assert.equal(observations[0].phase, 'queued')
    assert.equal(observations[0].blocker, 'resource-conflict')
    assert(Number.isSafeInteger(observations[0].blockedBy))
    h.children[0].emit('close', 0, null); await reader; await flush()
    assert.equal(observations[1].phase, 'executing')
    assert.equal(observations[1].requestId, observations[0].requestId)
    assert.equal(observations[1].blockedBy, undefined, 'executing evidence retained a former queue blocker')
    h.children[1].stdout.emit('data', JSON.stringify({ ok: false, message: '[HFM_PREVIEW_CACHE:missing] absent database' }))
    h.children[1].emit('close', 2, null)
    await assert.rejects(writer, error => error.phase === 'executing' && error.requestId === observations[0].requestId && !!error.closed)
    const unaffected = scope.withSharedIoObservation(() => { throw Error('observer only') }, () => h.read(h.roots.b))
    h.children[2].emit('close', 0, null); await unaffected
  } finally { await h.dispose() }
}
async function watched(promise, label) {
  let timer
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Unsettled ownership: ' + label)), 10000) })]) }
  finally { clearTimeout(timer) }
}
async function waitFor(predicate, label) {
  const deadline = Date.now() + 10000
  while (!predicate()) {
    assert(Date.now() < deadline, 'Unsettled readiness: ' + label)
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}
function harness({ concurrency = 1 } = {}) {
  const scheduling = loader()('src/main/path/sharedIoSchedulingScope.ts')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hfm-shared-preparation-'))
  const roots = { a: path.join(dir, 'root-a'), b: path.join(dir, 'root-b') }
  const local = path.join(dir, 'local.png'); fs.writeFileSync(local, png)
  let now = 10000, closing = false, epoch = 1, nextTimer = 0, nextPid = 0, pool
  let mkdirFailure, mkdirHold, badIndex = false, mkdirCalls = 0, failMkdirAt = 0
  const timers = new Map(), listeners = new Set(), children = [], events = [], logs = [], states = new Map(), signals = new AsyncLocalStorage()
  for (const root of Object.values(roots)) states.set(root, { rootId: root, generation: 1, state: 'online' })
  const state = root => states.get(root)
  const canonical = p => p.toLowerCase().replaceAll('/', '\\')
  const resource = p => Object.values(roots).find(root => p === root || p.startsWith(root + path.sep))
  class Clock extends Date { static now() { return now } }
  function child() {
    const value = new EventEmitter(); value.pid = ++nextPid
    value.stdin = new EventEmitter(); value.stdin.end = () => {}
    value.stdout = new EventEmitter(); value.stdout.setEncoding = () => {}
    value.stderr = new EventEmitter(); value.stderr.setEncoding = () => {}
    value.stdio = [value.stdin, value.stdout, value.stderr, new EventEmitter()]
    value.kill = () => { value.kills = (value.kills || 0) + 1; return true }
    children.push(value); return value
  }
  const sharedFs = { ...fs.promises,
    mkdir: async (...args) => {
      events.push(['mkdir', args[0]])
      mkdirCalls++
      if (failMkdirAt === mkdirCalls) throw Object.assign(Error('new reader won admission'), { sharedIo: true, reason: 'queue-timeout', phase: 'queued', blocker: 'resource-conflict', blockedBy: 77, closed: Promise.resolve() })
      if (args[0].startsWith(roots.a) && mkdirHold) await mkdirHold.promise
      if (args[0].startsWith(roots.a) && mkdirFailure) throw mkdirFailure
      return fs.promises.mkdir(...args)
    },
  }
  const mocks = {
    'node:child_process': { spawn: child },
    '../../path/sharedFileSystemRuntime': {
      sharedFileSystem: sharedFs,
      withSharedIoPriority: scheduling.withSharedIoPriority,
      withSharedIoQueueTimeout: scheduling.withSharedIoQueueTimeout,
      withSharedIoSignal: (signal, fn) => signals.run(signal, fn),
      withoutSharedIoSignal: fn => signals.run(undefined, fn),
    },
    '../../path/startupPathAvailabilityRuntime': {
      assertStartupPathRootGuardCurrent() {}, withStartupPathRootGuard: (guard, fn) => { guard(); return fn() }, getStartupPathRootState: state, ensureStartupPathRootAvailable: async root => state(root).state === 'online',
    },
    '../../app/shutdownCoordinatorRuntime': {
      applicationWorkEpoch: () => epoch, isApplicationClosing: () => closing,
      onApplicationClosing: fn => { listeners.add(fn); return () => listeners.delete(fn) },
    },
    '../../rust-core/rustSharedIoCommandRuntime': {
      // Files themselves use the local test FS. The preparation admission gets
      // real precise resource descriptions and uses the real pool observer.
      sharedIoResourceKeys: async paths => paths.some(p => p.endsWith('.publish.lock')) ? [] : [...new Set(paths.map(resource).filter(Boolean))],
      sharedIoAccesses: async paths => paths.map(access => ({ ...access, root: resource(access.path), path: canonical(access.path) })),
    },
    '../../path/sharedIoProcessRuntime': { applicationSharedIoProcessRuntime: () => pool },
    '../logging/startupLogPolicy': { detailedStartupLogsEnabled: () => false },
    '../logging/operationTraceContext': { currentOperationTrace: () => undefined, logOperation() {}, recordOperationWork() {} },
  }
  for (const [key, relative] of [['../../path/sharedFileSystemRuntime', 'src/main/path/sharedFileSystemRuntime.ts'], ['../../path/startupPathAvailabilityRuntime', 'src/main/path/startupPathAvailabilityRuntime.ts'], ['../../app/shutdownCoordinatorRuntime', 'src/main/app/shutdownCoordinatorRuntime.ts']]) mocks[path.resolve(__dirname, '../..', relative)] = mocks[key]
  const globals = { process: { ...process, env: { ...process.env, HFM_PREVIEW_PUBLISH_MAX_IN_FLIGHT: String(concurrency) } }, Date: Clock, setTimeout: (fn, ms) => { const id = ++nextTimer; timers.set(id, { fn, at: now + ms }); return id }, clearTimeout: id => timers.delete(id) }
  const load = loader(mocks, globals)
  // Load the production scheduler directly; its import spelling is separate
  // from the preparation's application-pool port above.
  pool = load('src/main/path/sharedIoProcessRuntime.ts').createSharedIoProcessRuntime(line => logs.push(line))
  const deadline = load('src/main/path/ioDeadlineRuntime.ts')
  const prepare = load(base + 'previewSharedPreparationRuntime.ts').createPreviewSharedPreparationRuntime({
    rootPreviewCacheDir: root => path.join(root, 'cache'), rootPreviewImageDir: root => path.join(root, 'cache', 'images'), rootPreviewDbPath: root => path.join(root, 'cache', 'db', 'preview.sqlite'),
    hideDirectoryOnWindows: async root => events.push(['hide', root]),
    writeRootPreviewCacheManifest: async (_cache, root) => events.push(['manifest', root]),
    ensureRootAvailable: async root => { events.push(['available', root]); return state(root).state === 'online' },
    appendStartupLog: line => logs.push(line),
  })
  const publish = load(base + 'previewCachePublishRuntime.ts').createPreviewCachePublishRuntime({
    appendStartupLog: line => logs.push(line), withIoDeadlineResult: deadline.withIoDeadlineResult,
    previewCacheStorageToShared: storage => storage, ensureSharedAvailable: prepare.ensurePrepared,
    writePreviewCacheIndex: async (storage, key) => {
      if (badIndex) { badIndex = false; throw Object.assign(Error('missing index directory'), { code: 'ENOENT' }) }
      events.push(['index', storage.rootPath, key])
    },
  })
  return { dir, roots, local, timers, children, events, logs, prepare, publish, pool, states, load,
    get now() { return now },
    async advance(ms) {
      now += ms
      // Drain only already-due callbacks. Newly scheduled retry deadlines remain
      // at least 1s ahead, so a long clock jump never fabricates extra retries.
      for (let i = 0; i < 100; i++) {
        const due = [...timers].filter(([, timer]) => timer.at <= now).sort((a, b) => a[1].at - b[1].at)
        if (!due.length) break
        for (const [id, timer] of due) if (timers.delete(id)) timer.fn()
        await flush()
      }
      await flush()
    },
    enqueue(root, key) { publish.enqueuePreviewCachePublish({ storage: 'root', rootPath: root, dir: path.join(root, 'cache', 'images') }, { previewKey: key, localOutputPath: local, fontSignature: 'source-version', textHash: 'text', fontSize: 44, width: 1, height: 1 }) },
    read(root) { const promise = pool.run({ file: 'fake-worker', args: ['tree-read'], roots: [root], accesses: [{ root, path: canonical(root), mode: 'read', scope: 'tree' }], write: false, verifiedReadOnly: true, timeoutMs: 120000, priority: 'foreground' }); promise.catch(() => {}); return promise },
    setFailure(error) { mkdirFailure = error }, setHold(value) { mkdirHold = value }, raceNextPublishMkdir() { failMkdirAt = mkdirCalls + 3 }, failIndexOnce() { badIndex = true },
    close() { closing = true; epoch++; for (const fn of listeners) fn() },
    async dispose() { closing = true; for (const fn of listeners) fn(); mkdirHold?.resolve(); mkdirHold = undefined; pool.stop(); for (const child of children) child.emit('close', 0, null); await watched(Promise.all([publish.whenIdle(), prepare.whenIdle(), pool.whenIdle()]), 'fixture physical cleanup'); fs.rmSync(dir, { recursive: true, force: true }) },
  }
}
async function blockedReadersAndRecovery() {
  const h = harness()
  try {
    const read = h.read(h.roots.a)
    for (let i = 0; i < 16; i++) h.enqueue(h.roots.a, 'a' + i)
    h.enqueue(h.roots.b, 'healthy')
    assert(h.events.length === 0, 'enqueue blocked the local preview success path')
    await h.advance(7000)
    await waitFor(() => h.events.some(event => event[0] === 'index' && event[1] === h.roots.b), 'healthy other root publication')
    for (let i = 0; i < 65; i++) await h.advance(1000)
    assert.equal(h.events.filter(event => event[0] === 'mkdir' && event[1].startsWith(h.roots.a)).length, 0, 'distinct preview keys repeatedly admitted blocked preparation')
    assert.equal(h.states.get(h.roots.a).state, 'online')
    const evidence = h.logs.filter(line => line.startsWith('preview cache preparation:'))
    assert(evidence.some(line => /phase=admission, blocker=resource-conflict, processPhase=queued/.test(line)))
    assert(evidence.every(line => !line.includes(h.roots.a) && !line.includes('source-version')), 'causal evidence leaked private content')
    assert(evidence.length <= 2, 'one blocked root produced unbounded evidence')
    h.children[0].emit('close', 0, null); await watched(read, 'reader close'); await h.advance(1000); await watched(h.publish.whenIdle(), 'sixteen retained publications')
    assert.equal(h.events.filter(event => event[0] === 'index' && event[1] === h.roots.a).length, 16, 'retained publications did not recover exactly once')
    assert.equal(h.events.filter(event => event[0] === 'manifest' && event[1] === h.roots.a).length, 1, 'cross-key root preparation was not reused')
    assert(fs.readFileSync(h.local).equals(png), 'optional work damaged the local result')
    assert.equal(h.timers.size, 0, 'completed recovery retained polling timers')
  } finally { await h.dispose() }
}
async function physicalCloseAndGeneration() {
  const h = harness(), close = gate()
  try {
    h.setFailure(Object.assign(Error('executing timeout'), { sharedIo: true, reason: 'timeout', phase: 'executing', requestId: 9, closed: close.promise }))
    h.enqueue(h.roots.a, 'old'); h.enqueue(h.roots.b, 'healthy')
    await h.advance(7000)
    assert.equal(h.events.filter(event => event[0] === 'mkdir').length, 1)
    await h.advance(5000)
    assert(!h.events.some(event => event[0] === 'index'), 'logical rejection released the configured publication slot before physical close')
    h.states.set(h.roots.a, { rootId: h.roots.a, generation: 2, state: 'online' })
    h.setFailure(undefined); close.resolve(); await watched(h.publish.whenIdle(), 'new root after retired physical owner')
    assert(h.events.some(event => event[0] === 'index' && event[1] === h.roots.b))
    assert(!h.events.some(event => event[0] === 'index' && event[2] === 'old'), 'old generation publication was replayed')
    h.enqueue(h.roots.a, 'new'); await h.advance(7000); await watched(h.publish.whenIdle(), 'new-generation publication')
    assert(h.events.some(event => event[0] === 'index' && event[2] === 'new'))
    assert(h.logs.some(line => line.includes('phase=mkdir-images') && line.includes('processPhase=executing') && line.includes('request=9')))
  } finally { close.resolve(); await h.dispose() }
}
async function overlappingGenerationsAndMkdirRace() {
  const h = harness({ concurrency: 2 }), close = gate()
  try {
    h.setFailure(Object.assign(Error('old owner closing'), { sharedIo: true, reason: 'timeout', phase: 'executing', closed: close.promise }))
    h.enqueue(h.roots.a, 'retired'); await h.advance(7000)
    h.states.set(h.roots.a, { rootId: h.roots.a, generation: 2, state: 'online' })
    h.enqueue(h.roots.a, 'current'); await h.advance(7000)
    assert.equal(h.events.filter(event => event[0] === 'mkdir').length, 1, 'new generation bypassed the old physical preparation owner')
    h.setFailure(undefined); close.resolve(); await watched(h.publish.whenIdle(), 'overlapping generation publication')
    assert(!h.events.some(event => event[0] === 'index' && event[2] === 'retired'))
    assert.equal(h.events.filter(event => event[0] === 'index' && event[2] === 'current').length, 1, 'new generation inherited retired false/success')
  } finally { close.resolve(); await h.dispose() }
  const race = harness()
  try {
    race.raceNextPublishMkdir(); race.enqueue(race.roots.a, 'race'); await race.advance(7000)
    await waitFor(() => race.logs.some(line => line.includes('phase=publish-mkdir')), 'post-hint mkdir deferral')
    assert(!race.events.some(event => event[0] === 'index'))
    assert(race.logs.some(line => line.includes('phase=publish-mkdir') && line.includes('blocker=resource-conflict') && line.includes('blockedBy=77')))
    await race.advance(1000); await watched(race.publish.whenIdle(), 'post-hint retry publication')
    assert.equal(race.events.filter(event => event[0] === 'index' && event[2] === 'race').length, 1, 'post-hint mkdir contention dropped a valid local publication')
  } finally { await race.dispose() }
}
async function preparationBoundaries() {
  const h = harness()
  try {
    const held = gate(); h.setHold(held)
    let settled = false
    const first = h.prepare.ensurePrepared(h.roots.a).then(value => { settled = true; return value })
    const joined = h.prepare.ensurePrepared(h.roots.a)
    first.catch(() => {}); joined.catch(() => {})
    await flush(); assert.equal(h.events.filter(event => event[0] === 'mkdir').length, 1)
    await h.advance(6000); assert.equal(settled, false, 'outer response timeout freed physical preparation')
    held.resolve(); h.setHold(undefined)
    await assert.rejects(first, error => error.name === 'PreviewSharedPreparationDeferred')
    await assert.rejects(joined, error => error.name === 'PreviewSharedPreparationDeferred')
    assert(h.logs.some(line => line.includes('blocker=response-timeout') && line.includes('processPhase=preparing')), 'setup timeout lost its observed phase')
    await h.advance(1000); assert.equal(await h.prepare.ensurePrepared(h.roots.a), true)
    const count = h.events.filter(event => event[0] === 'manifest').length
    const reader = h.read(h.roots.a)
    assert.equal(await h.prepare.ensurePrepared(h.roots.a), true, 'ready preparation requested write admission behind a reader')
    h.children[0].emit('close', 0, null); await reader
    assert.equal(await h.prepare.ensurePrepared(h.roots.a), true)
    assert.equal(h.events.filter(event => event[0] === 'manifest').length, count)
    await h.advance(30001); assert.equal(await h.prepare.ensurePrepared(h.roots.a), true)
    assert.equal(h.events.filter(event => event[0] === 'manifest').length, count + 1, 'ready flag became permanent')
    h.setFailure(Object.assign(Error('missing directory'), { code: 'ENOENT' }))
    await assert.rejects(h.prepare.ensurePrepared(h.roots.a, true), error => error.name === 'PreviewSharedPreparationDeferred' && error.detail.blocker === 'ENOENT')
    h.setFailure(undefined); await h.advance(1000); assert.equal(await h.prepare.ensurePrepared(h.roots.a), true)
    h.setFailure(Object.assign(Error('private access error'), { code: 'EACCES' }))
    assert.equal(await h.prepare.ensurePrepared(h.roots.a, true), false)
    assert.equal(h.states.get(h.roots.a).state, 'online', 'permission failure marked source offline')
    assert(h.logs.some(line => line.includes('blocker=access-denied')))
    assert(!h.logs.some(line => line.includes('private access error')))
  } finally { await h.dispose() }
}
async function missingParentAndExpiry() {
  const h = harness()
  try {
    h.failIndexOnce(); h.enqueue(h.roots.a, 'repair'); await h.advance(7000); await waitFor(() => h.logs.some(line => line.includes('phase=publish-lock')), 'missing parent deferral'); await h.advance(1000); await watched(h.publish.whenIdle(), 'missing parent recovery')
    assert.equal(h.events.filter(event => event[0] === 'index' && event[2] === 'repair').length, 1)
    assert.equal(h.events.filter(event => event[0] === 'manifest').length, 2, 'missing index parent did not invalidate ready preparation')
    h.prepare.invalidate()
    const read = h.read(h.roots.a); h.enqueue(h.roots.a, 'expires'); await h.advance(7000)
    await h.advance(5 * 60 * 1000)
    assert(h.logs.some(line => line.includes('optional-publication-expired')))
    assert(fs.readFileSync(h.local).equals(png))
    h.children[0].emit('close', 0, null); await read.catch(() => {}); await flush()
    h.enqueue(h.roots.a, 'expires'); await h.advance(7000); await watched(h.publish.whenIdle(), 'rescheduled expired publication')
    assert.equal(h.events.filter(event => event[0] === 'index' && event[2] === 'expires').length, 1, 'later render could not reschedule an expired optional publication')
  } finally { await h.dispose() }
}
async function shutdownAndMissingLocal() {
  const h = harness(), held = gate()
  try {
    h.setHold(held); h.enqueue(h.roots.a, 'cancelled'); await h.advance(7000); h.close()
    held.resolve(); await watched(Promise.all([h.publish.whenIdle(), h.prepare.whenIdle()]), 'shutdown preparation retirement')
    assert(!h.events.some(event => event[0] === 'manifest' || event[0] === 'index'), 'shutdown allowed stale preparation continuation')
    assert.equal(h.timers.size, 0)
  } finally { held.resolve(); await h.dispose() }
  const missing = harness()
  try {
    fs.unlinkSync(missing.local); missing.enqueue(missing.roots.a, 'pruned'); await missing.advance(7000); await watched(missing.publish.whenIdle(), 'pruned local publication')
    assert(!missing.events.some(event => event[0] === 'index'))
    assert.equal(missing.timers.size, 0, 'pruned local source retried indefinitely')
  } finally { await missing.dispose() }
}
async function noFalseOfflineAndQueuedCancellation() {
  const h = harness()
  try {
    const availability = h.load(base + 'previewCacheRootAvailabilityRuntime.ts').createPreviewCacheRootAvailabilityRuntime()
    assert.equal(await availability.ensureRootPreviewCacheAvailable(h.roots.a), true)
    for (const code of ['ENOENT', 'ENOTDIR', 'queue-timeout', 'cancelled']) availability.markRootPreviewCacheUnavailable(h.roots.a, Object.assign(Error(code), { code, reason: code }))
    assert.equal(availability.isRootPreviewCacheUnavailable(h.roots.a), false, 'missing optional cache or queue/cancel poisoned root availability')
    availability.markRootPreviewCacheUnavailable(h.roots.a, Object.assign(Error('denied'), { code: 'EACCES' }))
    assert.equal(availability.isRootPreviewCacheUnavailable(h.roots.a), true, 'actual access denial lost its unavailable distinction')
    assert.equal(h.states.get(h.roots.a).state, 'online', 'cache permission failure changed source-root state')
    h.enqueue(h.roots.b, 'stale-before-admission')
    h.states.set(h.roots.b, { rootId: h.roots.b, generation: 2, state: 'online' })
    await h.advance(7000); await watched(h.publish.whenIdle(), 'stale queued publication')
    assert.equal(h.events.length, 0, 'queued work recaptured a newer source generation')
  } finally { await h.dispose() }
}
async function registeredIdentityFootprints() {
  const roots = [String.raw`Z:\fonts`, String.raw`\\nas\share\fonts`, String.raw`R:\unverified`, String.raw`Q:\unknown`]
  let mappings = 0, filesystem = 0
  const hints = [], logs = []
  const mocks = {
    '../path/pathCanonicalizer': {
      normalizeNativePathText: value => value,
      mappedDriveTableSnapshot: () => null,
      mappedDriveTableAsync: async () => { mappings++; return null },
    },
    '../../path/sharedFileSystemRuntime': { sharedFileSystem: { mkdir: async () => { filesystem++ } }, withSharedIoPriority: (_p, fn) => fn(), withSharedIoQueueTimeout: (_ms, fn) => fn(), withSharedIoSignal: (_s, fn) => fn() },
    '../../path/startupPathAvailabilityRuntime': { getStartupPathRootState: root => ({ rootId: root, generation: 1, state: 'online' }), withStartupPathRootGuard: (guard, fn) => { guard(); return fn() } },
    '../../app/shutdownCoordinatorRuntime': { applicationWorkEpoch: () => 1, isApplicationClosing: () => false, onApplicationClosing() {} },
    '../../path/sharedIoProcessRuntime': { applicationSharedIoProcessRuntime: () => ({ inspectAdmission: target => { hints.push(target); return { ready: false, phase: 'queued', blocker: 'resource-conflict', blockedBy: 1 } } }) },
  }
  for (const [key, relative] of [['../../path/sharedFileSystemRuntime', 'src/main/path/sharedFileSystemRuntime.ts'], ['../../path/startupPathAvailabilityRuntime', 'src/main/path/startupPathAvailabilityRuntime.ts'], ['../../app/shutdownCoordinatorRuntime', 'src/main/app/shutdownCoordinatorRuntime.ts']]) mocks[path.resolve(__dirname, '../..', relative)] = mocks[key]
  const load = loader(mocks, { process: { ...process, platform: 'win32', env: { ...process.env, SystemDrive: 'C:' } } })
  const identity = load('src/main/rust-core/rustSharedIoCommandRuntime.ts')
  identity.registerIsolatedRoot(roots[0], roots[1]); identity.registerIsolatedRoot(roots[1], roots[1]); identity.registerIsolatedRoot(roots[2])
  const prepare = load(base + 'previewSharedPreparationRuntime.ts').createPreviewSharedPreparationRuntime({
    rootPreviewCacheDir: root => path.win32.join(root, 'cache'), rootPreviewImageDir: root => path.win32.join(root, 'cache', 'images'), rootPreviewDbPath: root => path.win32.join(root, 'cache', 'db', 'preview.sqlite'),
    hideDirectoryOnWindows: async () => { filesystem++ }, writeRootPreviewCacheManifest: async () => { filesystem++ }, ensureRootAvailable: async () => { throw Error('blocked preparation started a root availability probe') }, appendStartupLog: line => logs.push(line),
  })
  for (const root of roots.slice(0, 3)) await assert.rejects(prepare.ensurePrepared(root), error => error.name === 'PreviewSharedPreparationDeferred')
  assert.equal(mappings, 0, 'registered mapped/UNC/unverified footprints refreshed drive discovery')
  assert.equal(filesystem, 0)
  assert.deepEqual(JSON.parse(JSON.stringify(hints[0].roots)), JSON.parse(JSON.stringify(hints[1].roots)))
  assert.deepEqual(JSON.parse(JSON.stringify(hints[0].accesses)), JSON.parse(JSON.stringify(hints[1].accesses)))
  assert.equal(hints[2].accesses, undefined, 'unverified alias invented a precise access footprint')
  assert(hints[2].roots[0].startsWith('configured-root:'))
  assert.equal(await prepare.ensurePrepared(roots[3]), false, 'unknown drive identity admitted optional preparation')
  assert.equal(mappings, 1); assert.equal(filesystem, 0); assert.equal(hints.length, 3)
}
async function run() {
  await observedAdmissionAndExecution(); await registeredIdentityFootprints(); await noFalseOfflineAndQueuedCancellation(); await blockedReadersAndRecovery(); await physicalCloseAndGeneration(); await overlappingGenerationsAndMkdirRace(); await preparationBoundaries(); await missingParentAndExpiry(); await shutdownAndMissingLocal()
  console.log('PASS optional shared preparation: real admission conflict, 16-key coalescing, healthy-root progress, retained publication recovery, physical close, generation, finite ready reuse, missing/denied, expiry and shutdown')
}
module.exports = { run }
if (require.main === module) watched(run(), 'complete shared preparation diagnostic').catch(error => { console.error(error); process.exitCode = 1 })
