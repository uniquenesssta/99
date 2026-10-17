'use strict'

// Opt-in, passive Windows CI observation. The native worker, its SQLite busy
// handler, and the original fixture's deadlines and exit decision are untouched.
const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process')
const { errorMonitor } = require('node:events')
const PREFIX = 'operation-chain: ', LIMIT = 2048, WRITE_LIMIT = 65536
const U64_MAX = '18446744073709551615'
const COUNTERS = ['exitFileTime', 'kernelTime100ns', 'userTime100ns', 'readOperations', 'writeOperations',
  'otherOperations', 'readBytes', 'writeBytes', 'otherBytes']
const REASONS = new Set(['observer-init-failed', 'duplicate-id', 'identity-cap', 'handle-cap', 'open-failed', 'times-failed',
  'identity-mismatch', 'observer-failed', 'not-registered', 'already-exited', 'process-not-exited', 'wait-failed', 'exit-time-unavailable',
  'io-failed', 'close-failed', 'line-too-long', 'invalid-message', 'unfinished'])
const integer = value => Number.isSafeInteger(value) && value >= 0
const pidValue = value => integer(value) && value > 0 && value <= 0xffffffff
const u64 = value => typeof value === 'string' && /^(0|[1-9][0-9]{0,19})$/.test(value)
  && (value.length < 20 || value <= U64_MAX)
const keys = (value, expected) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join(',') === [...expected].sort().join(',')

function lineReader(onLine, counters, prefix) {
  let pending = '', discarded = false, total = 0
  return {
    write(data) {
      const size = Buffer.byteLength(data); total += size; counters[`${prefix}Bytes`] += size
      if (total > 4 * 1024 * 1024) { counters[`${prefix}DroppedBytes`] += size; pending = ''; discarded = true; return }
      for (const char of data.toString('utf8')) {
        if (char === '\n') {
          if (!discarded) onLine(pending.replace(/\r$/, ''))
          pending = ''; discarded = false
        } else if (!discarded) {
          if (pending.length < 8192) pending += char
          else { counters[`${prefix}OversizeLines`]++; pending = ''; discarded = true }
        }
      }
    },
    end() { if (pending && !discarded) onLine(pending.replace(/\r$/, '')); pending = '' },
  }
}

function install(reportPath, ports = {}) {
  const counts = { matchingChildren: 0, matchingClosed: 0, snapshotCommands: 0, validIdentities: 0,
    registerSent: 0, results: 0, helperUnknown: 0, localUnknown: 0, droppedRows: 0, duplicateCommands: 0,
    observerErrors: 0, spawnFailures: 0, protocolRejected: 0, traceRejected: 0, writeDropped: 0,
    workerBytes: 0, workerDroppedBytes: 0, workerOversizeLines: 0,
    helperBytes: 0, helperDroppedBytes: 0, helperOversizeLines: 0, helperStderrBytes: 0 }
  const rows = new Map(), spawn = ports.spawn || cp.spawn
  const helperState = { started: false, ready: false, closed: false, exitCode: null, signalled: false,
    streamError: false, refUnavailable: false, drainStarted: false, drainExpired: false, finished: null }
  let helper, timer, draining = false, settled = false, fixtureExitCodeAtDrain = null
  const arg = (name, fallback) => { const at = process.argv.indexOf(name); return at < 0 ? fallback : process.argv[at + 1] }
  const sourceRoot = path.resolve(arg('--source-root', process.cwd()))
  const worker = ports.workerPath || path.resolve(arg('--worker', process.env.HFM_TEST_NATIVE_WORKER || path.join(sourceRoot, 'build/native/hfm-core-worker.exe')))
  const guard = action => { try { return action() } catch { counts.observerErrors++ } }
  const unknown = (row, reason) => {
    if (!row.unknown) counts.localUnknown++
    row.unknown ||= reason
  }
  function send(value) {
    if (!helper?.stdin?.writable || helper.stdin.destroyed) { counts.writeDropped++; return false }
    const line = JSON.stringify(value) + '\n'
    if (helper.stdin.writableLength + Buffer.byteLength(line) > WRITE_LIMIT) { counts.writeDropped++; return false }
    try {
      // false means the bounded write was accepted. Never wait for drain or
      // queue a callback that gates the original fixture or worker dispatch.
      helper.stdin.write(line, error => { if (error) helperState.streamError = true })
      return true
    } catch { helperState.streamError = true; counts.writeDropped++; return false }
  }
  function helperLine(line) {
    let value
    try { value = JSON.parse(line) } catch { counts.protocolRejected++; return }
    if (keys(value, ['version', 'event']) && value.version === 1 && value.event === 'ready') {
      if (helperState.ready || helperState.finished) { counts.protocolRejected++; return }
      helperState.ready = true; return
    }
    if (keys(value, ['version', 'event', 'registered', 'completed', 'unknown', 'openHandles', 'cleanupErrors', 'protocolErrors'])
      && value.version === 1 && value.event === 'finished'
      && ['registered', 'completed', 'unknown', 'openHandles', 'cleanupErrors', 'protocolErrors'].every(key => integer(value[key]))) {
      if (helperState.finished) { counts.protocolRejected++; return }
      helperState.finished = { registered: value.registered, completed: value.completed, unknown: value.unknown,
        openHandles: value.openHandles, cleanupErrors: value.cleanupErrors, protocolErrors: value.protocolErrors }; return
    }
    if (keys(value, ['version', 'event', 'id', 'reason']) && value.version === 1 && value.event === 'unknown' && REASONS.has(value.reason)) {
      if (value.id === null) { helperState.streamError = true; counts.helperUnknown++; return }
      const row = rows.get(value.id)
      if (!integer(value.id) || !row?.registerSent || row.reply) { counts.protocolRejected++; return }
      row.reply = 'unknown'; row.helperReason = value.reason; counts.helperUnknown++; return
    }
    if (keys(value, ['version', 'event', 'id', 'pid', 'creationFileTime', ...COUNTERS])
      && value.version === 1 && value.event === 'result' && integer(value.id) && pidValue(value.pid)
      && u64(value.creationFileTime) && COUNTERS.every(key => u64(value[key]))) {
      const row = rows.get(value.id)
      if (!row?.registerSent || row.reply || !row.closed || row.pid !== value.pid || row.creationFileTime !== value.creationFileTime
        || value.exitFileTime === '0') { counts.protocolRejected++; return }
      row.reply = 'result'; row.counters = Object.fromEntries(COUNTERS.map(key => [key, value[key]])); counts.results++; return
    }
    counts.protocolRejected++
  }
  const helperReader = lineReader(line => guard(() => helperLine(line)), counts, 'helper')
  const unrefHelper = () => {
    helper?.unref()
    for (const stream of helper?.stdio || []) stream?.unref?.()
  }
  const stopHelper = () => {
    // This handle belongs only to the observer we spawned. Never signal workers.
    if (helper && !helperState.closed) guard(() => { helper.kill('SIGKILL') })
    for (const stream of helper?.stdio || []) guard(() => stream?.destroy())
    guard(unrefHelper)
  }
  const settle = () => {
    if (settled) return
    settled = true; clearTimeout(timer); guard(unrefHelper)
  }
  try {
    helper = Reflect.apply(ports.helperSpawn || spawn, cp, ['pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-File',
      path.join(__dirname, 'snapshot-process-counters.ps1')], { windowsHide: true, shell: false,
      stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env } }])
    helperState.started = true
    // A failed spawn may have no stdio. Install this owned child's error
    // listener before touching any stream, so observer startup cannot crash
    // the fixture via a later unhandled error event.
    helper.on('error', () => { helperState.streamError = true })
    helper.once('close', (code, signal) => guard(() => {
      helperReader.end(); helperState.closed = true; helperState.exitCode = Number.isInteger(code) ? code : null
      helperState.signalled = Boolean(signal); if (draining) settle()
    }))
    const streams = [helper.stdin, helper.stdout, helper.stderr]
    if (streams.some(stream => !stream || typeof stream.on !== 'function')) {
      helperState.streamError = true; helperState.refUnavailable = true; stopHelper()
    } else {
      for (const stream of streams) stream.on('error', () => { helperState.streamError = true })
      helper.stdout.on('data', data => guard(() => helperReader.write(data)))
      helper.stderr.on('data', data => guard(() => { counts.helperStderrBytes += Buffer.byteLength(data) }))
      if (streams.some(stream => typeof stream.ref !== 'function' || typeof stream.unref !== 'function')) {
        helperState.refUnavailable = true; stopHelper()
      } else unrefHelper()
    }
  } catch { helperState.streamError = true; stopHelper() }

  function attach(child) {
    ports.beforeAttach?.()
    counts.matchingChildren++
    let row, closed = false
    const entered = line => {
      if (!line.startsWith(PREFIX)) return
      let value
      try { value = JSON.parse(line.slice(PREFIX.length)) } catch { counts.traceRejected++; return }
      const trace = value?.trace
      if (value?.reason !== 'command-entered' || trace?.sessionId !== 'private-snapshot-ci' || trace?.domain !== 'sqliteSnapshot') return
      const ordinal = /^snapshot-([1-9][0-9]*)$/.exec(trace.operationId || '')
      if (trace.version !== 1 || !ordinal || !integer(Number(ordinal[1])) || value.backend !== 'rust'
        || value.stage !== 'backend-start' || value.backendSequence !== 1
        || typeof value.elapsedMs !== 'number' || !Number.isFinite(value.elapsedMs) || value.elapsedMs < 0) { counts.traceRejected++; return }
      if (row) { counts.duplicateCommands++; unknown(row, 'duplicate-command'); return }
      const id = ++counts.snapshotCommands
      if (rows.size >= LIMIT) { counts.droppedRows++; return }
      const identity = value.processIdentity
      const valid = keys(identity, ['pid', 'creationFileTime']) && pidValue(child.pid) && identity.pid === child.pid
        && u64(identity.creationFileTime) && identity.creationFileTime !== '0'
      row = { id, snapshotOrdinal: Number(ordinal[1]), pid: pidValue(child.pid) ? child.pid : null,
        creationFileTime: valid ? identity.creationFileTime : 'unknown', registerSent: false, closed,
        exitCode: null, signalled: false, commandToCloseMs: null, unknown: null, reply: null, helperReason: null, counters: null }
      rows.set(id, row)
      row.started = performance.now()
      if (!valid) { unknown(row, 'identity-unavailable'); return }
      counts.validIdentities++
      if (closed) { unknown(row, 'closed-before-register'); return }
      if (!helperState.ready || helperState.closed || helperState.refUnavailable || draining) { unknown(row, 'helper-not-ready'); return }
      if (!send({ version: 1, action: 'register', id, pid: row.pid, creationFileTime: row.creationFileTime })) { unknown(row, 'register-dropped'); return }
      row.registerSent = true; counts.registerSent++
    }
    const reader = lineReader(line => guard(() => entered(line)), counts, 'worker')
    child.stderr?.on('data', data => guard(() => reader.write(data)))
    child.once(errorMonitor, () => { counts.spawnFailures++ })
    child.stderr?.once(errorMonitor, () => { counts.observerErrors++ })
    child.once('close', (code, signal) => guard(() => {
      closed = true; counts.matchingClosed++; reader.end()
      if (!row) return
      row.closed = true; row.exitCode = Number.isInteger(code) ? code : null; row.signalled = Boolean(signal)
      row.commandToCloseMs = Math.max(0, performance.now() - row.started)
      if (row.registerSent && !send({ version: 1, action: 'close', id: row.id })) unknown(row, 'close-dropped')
    }))
  }
  cp.spawn = function(...args) {
    let matched = false
    guard(() => { matched = typeof args[0] === 'string' && path.resolve(args[0]).toLowerCase() === worker.toLowerCase()
      && Array.isArray(args[1]) && args[1][0] === '--shared-file-io' })
    let child
    try { child = Reflect.apply(spawn, this, args) }
    catch (error) { if (matched) counts.spawnFailures++; throw error }
    if (matched) guard(() => attach(child))
    return child
  }
  process.once('beforeExit', () => {
    // Let the fixture's existing beforeExit listener run in this same event
    // turn first. In particular, never restore an earlier zero exit code over
    // a failure it reports. We never assign process.exitCode at all.
    setImmediate(() => guard(() => {
      draining = true; helperState.drainStarted = true
      fixtureExitCodeAtDrain = process.exitCode == null ? 0 : Number.isInteger(process.exitCode) ? process.exitCode : null
      if (!helper || helperState.closed || helperState.refUnavailable) { settle(); return }
      timer = setTimeout(() => {
        helperState.drainExpired = true; stopHelper(); settle()
      }, 4000)
      helper.ref(); for (const stream of helper.stdio) stream.ref()
      send({ version: 1, action: 'finish' }); helper.stdin.end()
    }))
  })
  process.once('exit', code => {
    guard(() => { if (!helperState.closed) stopHelper() })
    guard(() => {
      const snapshots = Array.from(rows.values(), row => ({ id: row.id, snapshotOrdinal: row.snapshotOrdinal,
        pid: row.pid, creationFileTime: row.creationFileTime, registerSent: row.registerSent, closed: row.closed,
        exitCode: row.exitCode, signalled: row.signalled, commandToCloseMs: row.commandToCloseMs,
        unknown: row.unknown || (row.registerSent && !row.reply ? 'helper-reply-missing' : null),
        reply: row.reply, helperReason: row.helperReason, counters: row.counters }))
      const finished = helperState.finished
      const complete = counts.snapshotCommands > 0 && helperState.drainStarted && settled && helperState.ready && helperState.closed && helperState.exitCode === 0
        && !helperState.signalled && !helperState.streamError && !helperState.refUnavailable && !helperState.drainExpired
        && finished?.openHandles === 0 && finished.cleanupErrors === 0 && finished.protocolErrors === 0
        && finished.registered === counts.registerSent && finished.completed === counts.results && finished.unknown === counts.helperUnknown
        && counts.matchingChildren === counts.matchingClosed && counts.results === counts.snapshotCommands
        && ['localUnknown', 'helperUnknown', 'droppedRows', 'duplicateCommands', 'observerErrors', 'spawnFailures', 'protocolRejected',
          'traceRejected', 'writeDropped', 'workerDroppedBytes', 'workerOversizeLines', 'helperDroppedBytes', 'helperOversizeLines']
          .every(key => counts[key] === 0) && snapshots.every(row => row.closed && row.reply === 'result' && !row.unknown)
      const report = { version: 1, purpose: 'passive-process-counters-diagnostic', status: complete ? 'complete-observation' : 'partial-or-unknown',
        fixtureExitCode: code, fixtureExitCodeAtDrain, counts: { ...counts }, helper: { ...helperState }, snapshots,
        interpretation: 'Read-only lifetime totals for an identity-verified native snapshot child. CPU sums all process threads; logical I/O includes pipes and is not physical disk activity. Neither counter is exclusive to Backup. Concurrent PowerShell initialization/Add-Type can perturb this diagnostic run.' }
      fs.mkdirSync(path.dirname(reportPath), { recursive: true }); fs.writeFileSync(reportPath, JSON.stringify(report, null, 2))
    })
  })
}

// These controls prove observer isolation only. Their protocol is synthetic;
// real Windows process API/handle semantics are checked by the PS -SelfTest.
function selfTestCase(name, reportPath) {
  const assert = require('node:assert/strict'), { EventEmitter } = require('node:events'), { PassThrough } = require('node:stream')
  const actualSpawn = cp.spawn, originalError = Error('controlled-spawn-error')
  let originalChild
  const helper = new EventEmitter()
  helper.stdio = [new PassThrough(), new PassThrough(), new PassThrough()]
  ;[helper.stdin, helper.stdout, helper.stderr] = helper.stdio
  for (const stream of helper.stdio) { stream.ref = () => stream; stream.unref = () => stream }
  helper.ref = () => helper; helper.unref = () => helper; helper.kill = () => true
  helper.stdin.end = () => { helper.emit('close', 0, null) }
  if (name === 'missing-streams') {
    helper.stdio = []; delete helper.stdin; delete helper.stdout; delete helper.stderr
    process.nextTick(() => helper.emit('error', Error('controlled-helper-startup-error')))
  }
  if (name === 'backpressure') Object.defineProperty(helper.stdin, 'writableLength', { get: () => WRITE_LIMIT })
  const source = "process.stderr.write('operation-chain: '+JSON.stringify({trace:{version:1,sessionId:'private-snapshot-ci',domain:'sqliteSnapshot',operationId:'snapshot-1'},reason:'command-entered',stage:'backend-start',backend:'rust',backendSequence:1,elapsedMs:0,processIdentity:{pid:process.pid,creationFileTime:'1'}})+'\\n')"
  install(reportPath, { workerPath: process.execPath, helperSpawn: () => name === 'missing-helper'
    ? actualSpawn(path.join(path.dirname(reportPath), 'missing-observer.exe'), [], { windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] }) : helper,
    beforeAttach: () => { if (name === 'observer-error') throw Error('controlled-observer-error') },
    spawn(command, args, options) {
      if (command === 'controlled-spawn-error') throw originalError
      originalChild = Reflect.apply(actualSpawn, cp, [command, ['-e', source], options]); return originalChild
    } })
  if (!['not-ready', 'missing-helper', 'missing-streams'].includes(name)) helper.stdout.write('{"version":1,"event":"ready"}\n')
  if (name === 'invalid-message') helper.stdout.write('not-json\n')
  assert.throws(() => cp.spawn('controlled-spawn-error'), error => error === originalError)
  const child = cp.spawn(process.execPath, ['--shared-file-io'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  assert.equal(child, originalChild)
  child.stdout.resume(); child.stderr.resume()
  child.once('error', () => { process.exitCode = 9 })
  child.once('close', code => { process.exitCode = code === 0 ? 7 : 9 })
}

async function selfTest() {
  const assert = require('node:assert/strict'), os = require('node:os')
  assert.equal(process.platform, 'win32')
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hfm-process-counter-controls-'))
  const cases = ['not-ready', 'observer-error', 'backpressure', 'invalid-message', 'missing-helper', 'missing-streams'], evidence = []
  try {
    for (const name of cases) {
      const reportPath = path.join(directory, name + '.json')
      const child = cp.spawn(process.execPath, [__filename, '--self-test-case', name, reportPath], {
        windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] })
      child.stdout.resume(); child.stderr.resume()
      const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve) })
      assert.equal(code, 7)
      const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'))
      assert.equal(report.fixtureExitCode, 7); assert.equal(report.status, 'partial-or-unknown')
      if (name === 'not-ready') { assert.equal(report.helper.ready, false); assert.equal(report.snapshots[0].unknown, 'helper-not-ready') }
      if (name === 'observer-error') assert(report.counts.observerErrors > 0)
      if (name === 'backpressure') { assert(report.counts.writeDropped > 0); assert.equal(report.snapshots[0].unknown, 'register-dropped') }
      if (name === 'invalid-message') assert(report.counts.protocolRejected > 0)
      if (name === 'missing-helper') { assert.equal(report.helper.streamError, true); assert.equal(report.helper.closed, true) }
      if (name === 'missing-streams') { assert.equal(report.helper.streamError, true); assert.equal(report.helper.refUnavailable, true) }
      evidence.push({ case: name, fixtureExitCode: code, originalChildAndErrorPreserved: true, observation: report.status })
    }
    console.log(JSON.stringify({ version: 1, ok: true, scope: 'observer-isolation-controls-only', cases: evidence }))
  } finally { fs.rmSync(directory, { recursive: true, force: true }) }
}

if (require.main === module && process.argv[2] === '--self-test') {
  selfTest().catch(() => { console.log(JSON.stringify({ version: 1, ok: false, scope: 'observer-isolation-controls-only' })); process.exitCode = 1 })
} else if (require.main === module && process.argv[2] === '--self-test-case') {
  try { selfTestCase(process.argv[3], process.argv[4]) } catch { process.exitCode = 9 }
} else if (process.env.HFM_SNAPSHOT_PROCESS_COUNTERS === '1' && process.platform === 'win32') {
  const report = process.env.HFM_SNAPSHOT_PROCESS_COUNTERS_REPORT
  if (report && path.isAbsolute(report)) {
    try { install(report) } catch {
      process.once('exit', code => {
        try {
          fs.mkdirSync(path.dirname(report), { recursive: true })
          fs.writeFileSync(report, JSON.stringify({ version: 1, purpose: 'passive-process-counters-diagnostic',
            status: 'partial-or-unknown', fixtureExitCode: code, reason: 'observer-install-failed' }))
        } catch { /* Missing output is unknown; the fixture's exit decision remains its own. */ }
      })
    }
  }
}
