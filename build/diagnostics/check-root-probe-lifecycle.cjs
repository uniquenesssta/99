#!/usr/bin/env node
// Actual availability/probe/pool owners and the exact child script. Only OS ports
// and timers are controlled; the parent-crash child is in shared-filesystem.
const assert = require('node:assert/strict')
const path = require('node:path'), vm = require('node:vm')
const { EventEmitter } = require('node:events')
const { loader } = require('./check-operation-chain.cjs')
const root = path.resolve(__dirname, '../..'), abs = file => path.join(root, file)
const { awaitPhysicalIoClose } = loader({ [abs('src/main/path/sharedFileSystemRuntime.ts')]: { sharedFileSystem: {} } })('src/main/path/ioDeadlineRuntime.ts')
const plain = value => JSON.parse(JSON.stringify(value))
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
const tick = () => new Promise(resolve => setImmediate(resolve))
const sourcePath = '\\\\nas\\share\\font "quoted" root'

function controlledPorts(extra = {}) {
  return {
    [abs('src/main/app/shutdownCoordinatorRuntime.ts')]: { isApplicationClosing: () => false, applicationWorkEpoch: () => 1, onApplicationClosing() {} },
    [abs('src/main/rust-core/rustSharedIoCommandRuntime.ts')]: {
      sharedIoResourceKeys: async () => ['root'], sharedIoAccesses: async () => [{ root: 'root', path: sourcePath, mode: 'read', scope: 'file' }], registerIsolatedRoot() {},
    },
    [abs('src/main/path/pathCanonicalizer.ts')]: { normalizeNativePathText: value => value, normalizePathCompareText: value => String(value).toLowerCase(), mappedDriveTableAsync: async () => new Map() },
    [abs('src/main/path/ioDeadlineRuntime.ts')]: { awaitPhysicalIoClose, rootProbeQueueTimeoutMs: () => 3000, uncRootProbeTimeoutMs: () => 500, unavailableRootTtlMs: () => 30000 },
    ...extra,
  }
}

async function actualCaller() {
  const requests = [], registrations = []
  const ports = controlledPorts({
    [abs('src/main/path/sharedIoProcessRuntime.ts')]: { applicationSharedIoProcessRuntime: () => ({ run: async request => {
      requests.push(request); return { stdout: JSON.stringify({ directory: true, physicalPath: sourcePath }), queuedMs: 410, executionMs: 25 }
    } }) },
  })
  ports[abs('src/main/rust-core/rustSharedIoCommandRuntime.ts')].registerIsolatedRoot = (...args) => registrations.push(args)
  const load = loader(ports, { process: { ...process, platform: 'win32' } })
  assert.equal(await load('src/main/path/startupPathAvailabilityRuntime.ts').ensureStartupPathRootAvailable(sourcePath), true)
  assert.equal(requests.length, 1)
  const request = requests[0]
  assert.equal(request.timeoutMs, 500); assert.equal(request.queueTimeoutMs, 3000)
  assert.equal(request.write, false); assert.equal(request.lane, 'root-probe')
  assert.equal(request.args[0], '-e'); assert.equal(request.args[2], sourcePath)
  assert(!request.args[1].includes(sourcePath), 'Path was interpolated into executable script')
  assert.deepEqual(registrations, [[sourcePath, sourcePath]])
  return request.args[1]
}

function runScript(source, { directory = true, statError, realpathError } = {}) {
  const stat = deferred(), canonical = deferred(), sockets = [], calls = [], kills = [], output = []
  class Socket extends EventEmitter {
    constructor(options) { super(); assert.deepEqual(plain(options), { fd: 3, readable: true, writable: false }); sockets.push(this) }
    resume() { calls.push('resume') }
    unref() { calls.push('unref') }
  }
  const fakeProcess = { pid: 123, argv: ['node', sourcePath], stdout: { write: value => output.push(value) }, kill: pid => kills.push(pid) }
  const fs = { promises: { stat: async file => { assert.equal(file, sourcePath); calls.push('stat'); await stat.promise; if (statError) throw statError; return { isDirectory: () => directory } } },
    realpath: { native: (file, done) => { assert.equal(file, sourcePath); calls.push('realpath'); canonical.promise.then(() => done(realpathError, sourcePath)) } } }
  const completion = vm.runInNewContext(source, { process: fakeProcess, require: id => {
    if (id === 'node:fs') return fs
    if (id === 'node:net') return { Socket }
    throw Error(`Unexpected probe runtime or synchronous dependency: ${id}`)
  } })
  return { stat, canonical, sockets, calls, kills, output, fakeProcess, completion }
}

async function scriptLifecycle(source) {
  for (const directory of [true, false]) {
    const state = runScript(source, { directory })
    assert.deepEqual(state.calls, ['resume', 'unref', 'stat'], 'Probe starts a second runtime or keeps guard referenced')
    assert.equal(state.output.length, 0)
    state.stat.resolve(); await tick()
    assert.deepEqual(state.calls, ['resume', 'unref', 'stat', 'realpath'])
    assert.equal(state.output.length, 0, 'Directory published before native realpath completed')
    state.canonical.resolve(); await state.completion
    assert.deepEqual(JSON.parse(state.output[0]), { directory, physicalPath: sourcePath })
    assert.equal(state.fakeProcess.exitCode, undefined)
  }
  for (const stage of ['stat', 'realpath']) {
    const state = runScript(source, { [stage + 'Error']: Error('unavailable') })
    state.stat.resolve(); state.canonical.resolve(); await state.completion
    assert.equal(state.fakeProcess.exitCode, 1); assert.equal(state.output.length, 0)
    if (stage === 'stat') assert(!state.calls.includes('realpath'))
  }
  for (const stage of ['stat', 'realpath']) for (const event of ['end', 'error']) {
    const state = runScript(source)
    if (stage === 'realpath') { state.stat.resolve(); await tick() }
    state.sockets[0].emit(event, event === 'error' ? Error('parent gone') : undefined)
    assert.deepEqual(state.kills, [123], `Parent ${event} did not terminate pending ${stage}`)
    assert.equal(state.output.length, 0)
  }
}

async function cancellationAndTimeout() {
  for (const reason of ['cancelled', 'timeout']) {
    const children = [], timers = [], registrations = []
    const spawn = () => {
      const child = new EventEmitter(), stream = () => Object.assign(new EventEmitter(), { setEncoding() {}, end() {} })
      Object.assign(child, { pid: 321, stdin: stream(), stdout: stream(), stderr: stream(), stdio: [null, null, null, stream()], kills: [] })
      child.kill = signal => { child.kills.push(signal); return true }; children.push(child); return child
    }
    const ports = controlledPorts({ 'node:child_process': { spawn } })
    ports[abs('src/main/rust-core/rustSharedIoCommandRuntime.ts')].registerIsolatedRoot = (...args) => registrations.push(args)
    const load = loader(ports, { process: { ...process, platform: 'win32' },
      setTimeout: (run, ms) => { const timer = { run, ms, cleared: false }; timers.push(timer); return timer }, clearTimeout: timer => { timer.cleared = true } })
    const probe = load('src/main/path/sharedPathProbeRuntime.ts'), pool = load('src/main/path/sharedIoProcessRuntime.ts').applicationSharedIoProcessRuntime()
    const controller = new AbortController()
    const pending = probe.probeStartupDirectory(sourcePath, 'root', 500, { signal: controller.signal }).catch(error => error)
    await tick(); assert.equal(children.length, 1); assert.equal(pool.status().activeRootProbe, 1)
    assert(timers.some(timer => timer.ms === 3000 && timer.cleared), 'Queue budget changed')
    const execution = timers.find(timer => timer.ms === 500 && !timer.cleared); assert(execution, 'Execution budget changed')
    if (reason === 'cancelled') controller.abort(); else execution.run()
    const failure = await pending
    assert.equal(failure.reason, reason); assert.equal(failure.outcome, 'unknown')
    let closed = false; failure.closed.then(() => { closed = true }); await tick()
    assert.equal(closed, false); assert.equal(pool.status().activeRootProbe, 1, 'Logical failure released physical owner')
    assert.deepEqual(children[0].kills, ['SIGTERM'])
    children[0].stdout.emit('data', JSON.stringify({ directory: true, physicalPath: sourcePath }))
    children[0].emit('close', 0, null); await failure.closed; await pool.whenIdle()
    assert.equal(closed, true); assert.equal(pool.status().activeRootProbe, 0)
    assert.deepEqual(registrations, [], 'Late code-0 receipt was accepted after cancellation/timeout')
    assert.equal(children.length, 1, 'Unknown outcome retried the probe')
    pool.stop()
  }
}

async function main() {
  const source = await actualCaller()
  await scriptLifecycle(source); await cancellationAndTimeout()
  console.log('[diagnostics:root-probe-lifecycle] actual caller, unchanged budgets, single runtime, async stat/native realpath, parent pipe, errors, cancellation, timeout and physical close passed')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
