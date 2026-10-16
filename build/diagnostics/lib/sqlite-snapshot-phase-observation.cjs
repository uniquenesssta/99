'use strict'

// Private CI observation only. No paths, SQL, stdout payloads or raw stderr are
// retained. Missing phases identify the last observed boundary, never a lock cause.
const assert = require('node:assert/strict')
const { AsyncLocalStorage } = require('node:async_hooks')
const { EventEmitter } = require('node:events')
const REASONS = new Set(['command-entered', 'snapshot-target-check', 'snapshot-open-start', 'snapshot-opened',
  'snapshot-vacuum-start', 'snapshot-vacuum-returned', 'snapshot-connection-drop-returned',
  'snapshot-error-map-start', 'snapshot-error-map-returned', 'command-result', 'early-return-no-rollback-claim'])
const SUCCESS = ['command-entered', 'snapshot-target-check', 'snapshot-open-start', 'snapshot-opened',
  'snapshot-vacuum-start', 'snapshot-vacuum-returned', 'snapshot-connection-drop-returned', 'command-result']
const traceFor = ordinal => ({ version: 1, sessionId: 'private-snapshot-ci', operationId: `snapshot-${ordinal}`,
  attemptId: 'one', batchId: 'one', domain: 'sqliteSnapshot', members: [], omitted: 0 })

function createSnapshotPhaseObservation(phase, diagnostics = {}) {
  const scope = new AsyncLocalStorage(), failures = new WeakMap(), recent = [], failed = [], counts = new Map()
  let total = 0, observerErrors = 0, unscopedSharedChildren = 0, successfulTraces = 0, incompleteSuccessfulTraces = 0
  const guard = fn => { try { return fn() } catch { observerErrors++ } }
  const elapsed = row => Math.max(0, performance.now() - row.started)
  const boundary = (row, name) => guard(() => {
    if (typeof diagnostics.owners === 'function') {
      row.ownerBoundaries ||= []
      if (row.ownerBoundaries.length < 4) row.ownerBoundaries.push({ boundary: name, receivedMs: elapsed(row), owners: diagnostics.owners() })
    }
  })
  const retainFailure = row => { failed.push(row); if (failed.length > 8) failed.shift() }
  function reject(row, error) {
    guard(() => {
      row.outcome = 'rejected'; row.settledMs = elapsed(row)
      boundary(row, 'rejected')
      retainFailure(row)
      if (error && (typeof error === 'object' || typeof error === 'function')) failures.set(error, row)
      if (error?.sharedIo === true) {
        for (const key of ['requestId', 'queuedMs', 'executionMs'])
          if (Number.isFinite(error[key]) && error[key] >= 0) row[key] = error[key]
        if (error.closed && typeof error.closed.then === 'function') {
          row.errorClose = 'pending'
          error.closed.then(() => guard(() => { row.errorClose = 'fulfilled' }), () => guard(() => { row.errorClose = 'rejected' }))
        }
      }
    })
  }
  function run(execute, receiver, args, withTrace) {
    if (args[0]?.operation !== 'sqliteSnapshot') return Reflect.apply(execute, receiver, args)
    const row = { ordinal: ++total, phase: guard(() => String(phase()).replace(/[^a-zA-Z0-9_.:-]/g, '').slice(0, 96)) || 'unknown',
      started: performance.now(), outcome: 'pending', events: [], children: [] }
    boundary(row, 'executor-start')
    guard(() => { row.sourceFileId = diagnostics.rememberFile?.(args[0].path, 'snapshot-source') })
    recent.push(row); if (recent.length > 8) recent.shift()
    if (counts.has(row.phase) || counts.size < 64) counts.set(row.phase, (counts.get(row.phase) || 0) + 1)
    const trace = traceFor(row.ordinal)
    let pending
    try {
      pending = scope.run(row, () => withTrace(trace, undefined,
        () => Reflect.apply(execute, receiver, [{ ...args[0], trace }, ...args.slice(1)])))
    } catch (error) { reject(row, error); throw error }
    // Observe the original promise. Neither settlement nor physical cleanup is
    // awaited, retried, extended, or substituted by the observer.
    pending.then(output => guard(() => {
      guard(() => { row.targetFileId = diagnostics.rememberFile?.(output?.snapshotPath, 'snapshot-target') })
      row.outcome = output?.result?.ok === false ? 'failed-receipt' : 'fulfilled'; row.settledMs = elapsed(row)
      if (row.outcome === 'failed-receipt') retainFailure(row)
      if (row.outcome === 'fulfilled') {
        if (row.children.length === 1 && row.children[0].closedMs !== undefined && row.children[0].firstStdoutMs !== undefined
          && row.events.length === SUCCESS.length && row.events.every((event, index) => event.reason === SUCCESS[index] && event.sequence === index + 1)) successfulTraces++
        else incompleteSuccessfulTraces++
      }
    }), error => reject(row, error))
    return pending
  }
  function wrapChildProcess(port) {
    const spawn = port.spawn
    port.spawn = function(...args) {
      const row = scope.getStore(), child = Reflect.apply(spawn, this, args)
      if (!Array.isArray(args[1]) || args[1][0] !== '--shared-file-io') return child
      if (!row) { unscopedSharedChildren++; return child }
      guard(() => {
        const evidence = { spawnReturnedMs: elapsed(row), stderrBytes: 0, stdoutBytes: 0, rejectedLines: 0, droppedEvents: 0 }
        if (row.children.length >= 2) { observerErrors++; return }
        row.children.push(evidence)
        let buffer = '', discarded = false
        const line = text => {
          if (!text.startsWith('operation-chain: ')) return
          let event; try { event = JSON.parse(text.slice(17)) } catch { evidence.rejectedLines++; return }
          const trace = event.trace, expected = traceFor(row.ordinal)
          if (!trace || Object.entries(expected).some(([key, value]) => key !== 'members' && trace[key] !== value)
            || event.backend !== 'rust' || !REASONS.has(event.reason)
            || !['backend-start', 'backend-phase', 'backend-result'].includes(event.stage)
            || !Number.isSafeInteger(event.backendSequence) || event.backendSequence < 1
            || !Number.isFinite(event.elapsedMs) || event.elapsedMs < 0) { evidence.rejectedLines++; return }
          if (row.events.length >= 16) { evidence.droppedEvents++; return }
          if (event.reason === 'snapshot-vacuum-start') boundary(row, 'vacuum-start-received')
          row.events.push({ reason: event.reason, sequence: event.backendSequence, nativeElapsedMs: event.elapsedMs,
            receivedMs: elapsed(row) })
        }
        child.once('spawn', () => guard(() => { evidence.spawnEventMs = elapsed(row) }))
        child.stdout?.on('data', data => guard(() => {
          if (evidence.firstStdoutMs === undefined) evidence.firstStdoutMs = elapsed(row)
          evidence.stdoutBytes += Buffer.byteLength(data)
        }))
        child.stderr?.on('data', data => guard(() => {
          evidence.stderrBytes += Buffer.byteLength(data)
          // Discard oversized lines in their entirety, without retaining a tail
          // that could be mistaken for a new event. Bounded even without newline.
          for (const char of data.toString('utf8')) {
            if (char === '\n') { if (!discarded) line(buffer.replace(/\r$/, '')); buffer = ''; discarded = false }
            else if (!discarded) { if (buffer.length < 8192) buffer += char; else { buffer = ''; discarded = true; evidence.rejectedLines++ } }
          }
        }))
        child.once('close', (code, signal) => guard(() => {
          evidence.closedMs = elapsed(row); evidence.exitCode = Number.isInteger(code) ? code : null
          evidence.signalled = Boolean(signal)
          boundary(row, 'physical-close')
          buffer = ''
        }))
      })
      return child
    }
    return port
  }
  const clean = row => row && { ...row, started: undefined, events: row.events.map(event => ({ ...event })), children: row.children.map(child => ({ ...child })) }
  return { run, wrapChildProcess, snapshot(error) { return { total, retained: recent.length, omitted: total - recent.length,
    observerErrors, unscopedSharedChildren, successfulTraces, incompleteSuccessfulTraces, counts: Object.fromEntries(counts),
    timeOrigin: 'parent times since executor call; native times since input read and strict parse completed',
    interpretation: 'last observed boundary only; spawn-to-first-native includes startup and input handling; drop-return is not a SQLite close receipt',
    exactFailure: clean(error && (typeof error === 'object' || typeof error === 'function') ? failures.get(error) : undefined),
    // This ring survives later successful requests when production handles the
    // original error. It is labelled independently, never attached to another error.
    failed: failed.map(clean), recent: recent.map(clean) } } }
}

async function observationControls() {
  const observer = createSnapshotPhaseObservation(() => 'control', { owners: () => ({ scope: 'control', owners: [] }) }), child = new EventEmitter()
  child.stdout = new EventEmitter(); child.stderr = new EventEmitter()
  const port = observer.wrapChildProcess({ spawn: () => child }), receiver = {}, request = { operation: 'sqliteSnapshot', path: 'private-source' }
  let reject, close
  const closed = new Promise(resolve => { close = resolve }), pending = new Promise((_, fail) => { reject = fail })
  const error = Object.freeze(Object.assign(Error('private-error'), { sharedIo: true, requestId: 1, closed }))
  const traceScope = new AsyncLocalStorage()
  const withTrace = (trace, _append, run) => traceScope.run(trace, run)
  const returned = observer.run(function(input) {
    assert.equal(this, receiver); assert.equal(input.path, request.path); assert.equal(traceScope.getStore(), input.trace)
    assert.equal(port.spawn('private-worker', ['--shared-file-io']), child)
    return pending
  }, receiver, [request], withTrace)
  assert.equal(returned, pending, 'SNAPSHOT_OBSERVER_PROMISE'); assert.equal(request.trace, undefined)
  child.emit('spawn')
  const event = reason => JSON.stringify({ trace: traceFor(1), backend: 'rust', stage: 'backend-phase', reason, backendSequence: 1, elapsedMs: 0 })
  child.stderr.emit('data', Buffer.from('operation-chain: ' + event('snapshot-open-start') + '\n'))
  child.stderr.emit('data', Buffer.from('operation-chain: ' + event('private-source') + '\n'))
  child.stderr.emit('data', Buffer.from('x'.repeat(20000) + '\n'))
  reject(error)
  await assert.rejects(returned, value => value === error)
  assert.equal(observer.snapshot(error).exactFailure.errorClose, 'pending', 'SNAPSHOT_OBSERVER_CLOSE')
  child.stderr.emit('data', Buffer.from('operation-chain: ' + event('snapshot-opened') + '\n'))
  child.stdout.emit('data', Buffer.from('private-output'))
  child.emit('close', null, 'SIGTERM'); close(); await closed
  const view = observer.snapshot(error)
  assert.deepEqual(view.exactFailure.ownerBoundaries.map(row => row.boundary), ['executor-start', 'rejected', 'physical-close'])
  assert.equal(view.exactFailure.errorClose, 'fulfilled')
  assert.equal(view.exactFailure.children[0].signalled, true)
  assert.equal(view.exactFailure.events.length, 2, 'SNAPSHOT_OBSERVER_LATE_PHASE')
  assert.equal(view.exactFailure.children[0].rejectedLines, 2)
  assert.equal(view.exactFailure.children[0].stdoutBytes, 14)
  assert(!JSON.stringify(view).includes('private-source') && !JSON.stringify(view).includes('private-output') && !JSON.stringify(view).includes('private-error'))
  assert.equal(observer.snapshot(Error('private-error')).exactFailure, undefined, 'SNAPSHOT_OBSERVER_IDENTITY')
  for (let i = 0; i < 12; i++) await observer.run(() => Promise.resolve({ result: { ok: true } }), null, [request], withTrace)
  assert.equal(observer.snapshot().retained, 8); assert.equal(observer.snapshot().omitted, 5)
  assert.equal(observer.snapshot(error).exactFailure.ordinal, 1, 'SNAPSHOT_OBSERVER_FAILURE_RETENTION')
  assert.equal(observer.snapshot().failed[0].ordinal, 1, 'SNAPSHOT_OBSERVER_HANDLED_FAILURE_RETENTION')
  assert.equal(observer.snapshot().observerErrors, 0)
  const throwing = createSnapshotPhaseObservation(() => 'control', { owners: () => { throw error }, rememberFile: () => { throw error } })
  const originalValue = { result: { ok: true } }, original = Promise.resolve(originalValue)
  assert.equal(throwing.run(() => original, null, [request], withTrace), original)
  assert.equal(await original, originalValue)
  assert(throwing.snapshot().observerErrors > 0)
}

async function nativeControls({ workerPath, directory }) {
  const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process'), crypto = require('node:crypto')
  const { DatabaseSync } = require('node:sqlite')
  const root = path.join(directory, 'snapshot-phase-controls'); fs.mkdirSync(root)
  const source = path.join(root, 'source.sqlite'), db = new DatabaseSync(source)
  try { db.exec('CREATE TABLE proof(value TEXT); INSERT INTO proof VALUES (\'original\')') } finally { db.close() }
  const digest = () => crypto.createHash('sha256').update(fs.readFileSync(source)).digest('hex'), before = digest()
  const results = []
  const run = (request, name) => {
    const input = path.join(root, `${name}.json`); fs.writeFileSync(input, JSON.stringify(request))
    return new Promise((resolve, reject) => {
      let stdout = '', stderr = '', originalError
      const child = cp.spawn(workerPath, ['--shared-file-io', '--input', input], {
        windowsHide: true, env: { ...process.env, HFM_PARENT_PID: String(process.pid) }, stdio: ['ignore', 'pipe', 'pipe'] })
      // A test liveness guard only; production's shared-pool 2s deadline remains
      // exercised unchanged in the actual host below. Never settle before close.
      const timer = setTimeout(() => { originalError ||= Error('SQLITE_PHASE_NATIVE_CONTROL_DEADLINE'); child.kill('SIGKILL') }, 10000)
      child.on('error', error => { originalError ||= error })
      for (const [stream, assign] of [[child.stdout, text => { stdout += text }], [child.stderr, text => { stderr += text }]])
        stream.on('data', data => { if (stdout.length + stderr.length + data.length > 32768) { originalError ||= Error('SQLITE_PHASE_NATIVE_CONTROL_OUTPUT'); child.kill('SIGKILL') } else assign(data.toString('utf8')) })
      child.once('close', code => {
        clearTimeout(timer)
        if (originalError) return reject(originalError)
        try {
          assert.equal(code, 0, 'SQLITE_PHASE_NATIVE_CONTROL_EXIT')
          const receipt = JSON.parse(stdout.trim())
          const events = stderr.split(/\r?\n/).filter(line => line.startsWith('operation-chain: ')).map(line => JSON.parse(line.slice(17)))
          assert(!stderr.includes(root), 'SQLITE_PHASE_NATIVE_PATH_REDACTION')
          resolve({ receipt, events })
        } catch (error) { reject(error) }
      })
    })
  }
  for (const [index, trace] of [undefined, 'invalid-diagnostic-only', traceFor(1)].entries()) {
    const target = path.join(root, `copy-${index}.sqlite`)
    const { receipt, events } = await run({ operation: 'sqliteSnapshot', path: source, transferPath: target, trace }, `success-${index}`)
    assert.deepEqual(receipt, { ok: true, operation: 'sqliteSnapshot', value: null }, 'SQLITE_PHASE_RESULT_IDENTITY')
    const read = new DatabaseSync(target, { readOnly: true })
    try { assert.equal(read.prepare('SELECT value FROM proof').get().value, 'original') } finally { read.close() }
    assert.deepEqual(events.map(event => event.reason), index === 2 ? SUCCESS : [], 'SQLITE_PHASE_OPT_IN')
    if (index === 2) for (const [at, event] of events.entries()) {
      assert.equal(event.backendSequence, at + 1)
      assert(Number.isFinite(event.elapsedMs) && event.elapsedMs >= 0)
      assert.equal(event.trace.operationId, 'snapshot-1')
    }
    results.push(index === 2 ? 'traced-copy' : index === 1 ? 'invalid-trace-silent' : 'untraced-copy')
  }
  for (const kind of ['existing-target', 'missing-source', 'invalid-database']) {
    const target = path.join(root, `${kind}.sqlite`), badSource = path.join(root, 'invalid.sqlite')
    if (kind === 'existing-target') fs.writeFileSync(target, 'retain-target')
    if (kind === 'invalid-database') fs.writeFileSync(badSource, 'invalid SQLite bytes')
    const { receipt, events } = await run({ operation: 'sqliteSnapshot', path: kind === 'missing-source' ? path.join(root, 'absent.sqlite') : kind === 'invalid-database' ? badSource : source,
      transferPath: target, trace: traceFor(1) }, kind)
    assert.equal(receipt.ok, false, 'SQLITE_PHASE_ERROR_PRESERVED')
    const reasons = events.map(event => event.reason)
    assert.equal(reasons.at(-1), 'command-result')
    assert.deepEqual(reasons.slice(-3), ['snapshot-error-map-start', 'snapshot-error-map-returned', 'command-result'], 'SQLITE_PHASE_ERROR_MAPPING')
    assert.equal(reasons.includes('snapshot-open-start'), kind !== 'existing-target')
    assert.equal(reasons.includes('snapshot-vacuum-start'), kind === 'invalid-database')
    assert.equal(reasons.includes('snapshot-vacuum-returned'), kind === 'invalid-database')
    assert.equal(reasons.includes('snapshot-connection-drop-returned'), kind === 'invalid-database')
    if (kind === 'existing-target') {
      assert.equal(fs.readFileSync(target, 'utf8'), 'retain-target')
      const untraced = await run({ operation: 'sqliteSnapshot', path: source, transferPath: target }, 'existing-target-untraced')
      assert.equal(JSON.stringify(untraced.receipt) === JSON.stringify(receipt), true, 'SQLITE_PHASE_ERROR_RECEIPT_IDENTITY')
      assert.equal(untraced.events.length, 0)
    }
    if (kind === 'missing-source') assert.equal(fs.existsSync(path.join(root, 'absent.sqlite')), false)
    results.push(kind)
  }
  assert.equal(digest(), before, 'SQLITE_PHASE_SOURCE_UNCHANGED')
  return { cases: results, sourceUnchanged: true, childrenClosed: true,
    interpretation: 'last reached native phase; no SQLite-lock or physical-I/O-duration inference' }
}

module.exports = { createSnapshotPhaseObservation, observationControls, nativeControls, SUCCESS, traceFor }
