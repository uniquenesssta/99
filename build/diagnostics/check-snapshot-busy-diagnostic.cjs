#!/usr/bin/env node
'use strict'

// An opt-in investigation with different busy-handler behavior. This is never
// production correctness or performance acceptance evidence.
const fs = require('node:fs'), fsp = fs.promises, path = require('node:path'), os = require('node:os')
const cp = require('node:child_process'), crypto = require('node:crypto')
const { errorMonitor } = require('node:events')
const FEATURE = 'snapshot-busy-diagnostic', MODE = 'passive-preload-v1'
const BUSY_PREFIX = 'hfm-snapshot-busy: ', PHASE_PREFIX = 'operation-chain: '
const BUSY_KEYS = ['attempt', 'event', 'extendedCode', 'feature', 'outcome', 'phase', 'primaryCode', 'role', 'version'].sort().join(',')
const EVENTS = new Set(['begin', 'phase', 'busy-handler', 'backup-step', 'result'])
const ROLES = new Set(['source', 'destination', 'unknown'])
const PHASES = new Set(['copy', 'source-preflight-start', 'source-preflight-returned', 'before-new', 'before-step', 'after-step', 'after-finish'])
const OUTCOMES = new Set(['done', 'busy', 'locked', 'more', 'sqlite-error', 'other-error', 'ok'])
const TRACE_REASONS = new Set(['command-entered', 'snapshot-target-check', 'snapshot-open-start', 'snapshot-opened',
  'snapshot-target-open-start', 'snapshot-target-opened', 'snapshot-backup-start', 'snapshot-backup-returned',
  'snapshot-integrity-start', 'snapshot-integrity-returned', 'snapshot-target-close-returned', 'snapshot-connection-drop-returned',
  'snapshot-error-map-start', 'snapshot-error-map-returned', 'command-result', 'early-return-no-rollback-claim'])
const FIXTURE_PHASES = new Set(['fixture-setup', 'initial-root-signature', 'initial-worker-page', 'cold-full-root', 'warm-full-root',
  'equivalent-node-schema-initializer', 'old-writer-updatedAt-control', 'schema-version-control', 'native-schema-migration-control',
  'incomplete-enumeration', 'duplicate-directory-writes', 'second-directory-snapshot', 'preflight-regression',
  'fresh-child-regression-control', 'fresh-child-control-recovery', 'inventory-noop', 'inventory-signature-setup-read',
  'inventory-signature-write-close-boundary', 'read-close-boundary:target-stat', 'read-close-boundary:directory-read',
  'read-close-boundary:directory-batch', 'read-close-boundary:outer-directory', 'read-close-boundary:compatibility-entry',
  'validation:cold-directory-write', 'validation:warm-directory-noop', 'validation:changed', 'validation:added', 'validation:deleted',
  'validation:old-writer-updatedAt', 'validation:schema-version', 'validation:schema-migration', 'validation:freshness-control-recovery'])
const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0
const integer = value => Number.isSafeInteger(value) && value >= 0
const optionalCode = value => value === null || (integer(value) && value <= 0x7fffffff)
const digest = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const fixedFailure = code => Object.assign(new Error(code), { diagnosticCode: code })
const COUNT_KEYS = ['workerChildren', 'closedChildren', 'retainedChildren', 'parsedBusy', 'parsedPhases', 'ignoredLines',
  'parseRejected', 'schemaRejected', 'truncatedLines', 'overBudgetBytes', 'stderrBytes', 'droppedChildren', 'droppedEvents',
  'observerErrors', 'spawnFailures']

function decodeBusy(value) {
  if (!value || Array.isArray(value) || Object.keys(value).sort().join(',') !== BUSY_KEYS
    || value.version !== 1 || value.feature !== FEATURE || !EVENTS.has(value.event) || !ROLES.has(value.role)
    || !PHASES.has(value.phase) || !(value.outcome === null || OUTCOMES.has(value.outcome))
    || !(value.attempt === null || value.attempt === 0) || !optionalCode(value.primaryCode) || !optionalCode(value.extendedCode)) return null
  return { version: 1, feature: FEATURE, event: value.event, role: value.role, phase: value.phase,
    attempt: value.attempt, outcome: value.outcome, primaryCode: value.primaryCode, extendedCode: value.extendedCode }
}

// Always drain. Bound retained line text and account for every overflow instead
// of killing a child, extending a deadline, or silently accepting partial data.
function lineReader(onLine, limit, budget = Infinity) {
  const counts = { bytes: 0, overBudgetBytes: 0, truncatedLines: 0 }
  let buffer = '', discarded = false
  return { counts,
    write(data) {
      const size = Buffer.byteLength(data)
      counts.bytes += size
      if (counts.bytes > budget) { counts.overBudgetBytes += size; buffer = ''; discarded = true; return }
      const text = data.toString('utf8')
      for (const char of text) {
        if (char === '\n') {
          if (!discarded) onLine(buffer.replace(/\r$/, ''))
          buffer = ''; discarded = false
        } else if (!discarded) {
          if (buffer.length < limit) buffer += char
          else { counts.truncatedLines++; buffer = ''; discarded = true }
        }
      }
    },
    end() { if (buffer && !discarded) onLine(buffer.replace(/\r$/, '')); buffer = '' },
  }
}

function createCollector() {
  const children = [], counts = Object.fromEntries(COUNT_KEYS.map(key => [key, 0]))
  let eventCount = 0
  const guard = work => { try { work() } catch { counts.observerErrors++ } }
  function attach(child) {
    const started = performance.now()
    const row = { childOrdinal: ++counts.workerChildren, pid: integer(child.pid) ? child.pid : null, snapshotOrdinal: null,
      closed: false, closedMs: null, exitCode: null, signalled: false, events: [] }
    let retained = false, omitted = false
    const retain = () => {
      if (retained || omitted) return retained
      if (children.length >= 1024) { counts.droppedChildren++; omitted = true; return false }
      children.push(row); counts.retainedChildren++; retained = true; return true
    }
    const append = event => {
      if (!retain()) return
      if (row.events.length >= 64 || eventCount >= 32768) { counts.droppedEvents++; return }
      eventCount++; row.events.push({ ...event, receivedMs: Math.max(0, performance.now() - started) })
    }
    const reader = lineReader(line => guard(() => {
      if (line.startsWith(BUSY_PREFIX)) {
        let value
        try { value = JSON.parse(line.slice(BUSY_PREFIX.length)) } catch { counts.parseRejected++; return }
        const event = decodeBusy(value)
        if (!event) { counts.schemaRejected++; return }
        counts.parsedBusy++; append({ kind: 'busy', ...event }); return
      }
      if (line.startsWith(PHASE_PREFIX)) {
        let value
        try { value = JSON.parse(line.slice(PHASE_PREFIX.length)) } catch { counts.parseRejected++; return }
        const trace = value?.trace
        if (trace?.sessionId !== 'private-snapshot-ci' || trace?.domain !== 'sqliteSnapshot') { counts.ignoredLines++; return }
        const ordinal = /^snapshot-([1-9][0-9]*)$/.exec(trace.operationId || '')
        if (!ordinal || !integer(Number(ordinal[1])) || value.backend !== 'rust' || !TRACE_REASONS.has(value.reason)
          || !['backend-start', 'backend-phase', 'backend-result'].includes(value.stage)
          || !integer(value.backendSequence) || value.backendSequence < 1 || !number(value.elapsedMs)) { counts.schemaRejected++; return }
        if (row.snapshotOrdinal !== null && row.snapshotOrdinal !== Number(ordinal[1])) { counts.schemaRejected++; return }
        row.snapshotOrdinal = Number(ordinal[1]); counts.parsedPhases++
        append({ kind: 'phase', reason: value.reason, sequence: value.backendSequence, nativeElapsedMs: value.elapsedMs }); return
      }
      counts.ignoredLines++
    }), 8192, 1024 * 1024)
    child.stderr?.on('data', data => guard(() => reader.write(data)))
    // errorMonitor observes without consuming an error that the original owner
    // did not handle. Never turn an unhandled error into a successful fixture.
    child.once(errorMonitor, () => guard(() => { counts.spawnFailures++; retain() }))
    child.stderr?.once(errorMonitor, () => { counts.observerErrors++ })
    child.once('close', (code, signal) => guard(() => {
      reader.end(); counts.truncatedLines += reader.counts.truncatedLines
      counts.overBudgetBytes += reader.counts.overBudgetBytes; counts.stderrBytes += reader.counts.bytes; counts.closedChildren++
      row.closed = true; row.closedMs = Math.max(0, performance.now() - started)
      row.exitCode = Number.isInteger(code) ? code : null; row.signalled = Boolean(signal)
    }))
  }
  return { attach, counts, snapshot: () => ({ version: 1, feature: FEATURE, scope: 'passive-native-child-events', counts: { ...counts }, children }) }
}

// Reconstruct the temporary preload file, too. No arbitrary JSON field can be
// copied into the published artifact even if that private file is malformed.
function decodeObservation(value) {
  const keys = (object, names) => object && !Array.isArray(object)
    && Object.keys(object).sort().join(',') === [...names].sort().join(',')
  if (!keys(value, ['version', 'feature', 'scope', 'counts', 'children']) || value.version !== 1 || value.feature !== FEATURE
    || value.scope !== 'passive-native-child-events' || !keys(value.counts, COUNT_KEYS)
    || !COUNT_KEYS.every(key => integer(value.counts[key])) || !Array.isArray(value.children) || value.children.length > 1024) return null
  const children = []; let total = 0
  for (const row of value.children) {
    if (!keys(row, ['childOrdinal', 'pid', 'snapshotOrdinal', 'closed', 'closedMs', 'exitCode', 'signalled', 'events'])
      || !integer(row.childOrdinal) || row.childOrdinal < 1 || !(row.pid === null || integer(row.pid))
      || !(row.snapshotOrdinal === null || (integer(row.snapshotOrdinal) && row.snapshotOrdinal > 0))
      || typeof row.closed !== 'boolean' || !(row.closedMs === null || number(row.closedMs))
      || !(row.exitCode === null || Number.isSafeInteger(row.exitCode)) || typeof row.signalled !== 'boolean'
      || !Array.isArray(row.events) || row.events.length > 64) return null
    const events = []
    for (const event of row.events) {
      if (++total > 32768 || !number(event?.receivedMs)) return null
      if (event.kind === 'busy') {
        if (!keys(event, [...BUSY_KEYS.split(','), 'kind', 'receivedMs'])) return null
        const busy = decodeBusy(Object.fromEntries(BUSY_KEYS.split(',').map(key => [key, event[key]])))
        if (!busy) return null
        events.push({ kind: 'busy', ...busy, receivedMs: event.receivedMs })
      } else if (event.kind === 'phase' && keys(event, ['kind', 'reason', 'sequence', 'nativeElapsedMs', 'receivedMs'])
        && TRACE_REASONS.has(event.reason) && integer(event.sequence) && event.sequence > 0 && number(event.nativeElapsedMs)) {
        events.push({ kind: 'phase', reason: event.reason, sequence: event.sequence,
          nativeElapsedMs: event.nativeElapsedMs, receivedMs: event.receivedMs })
      } else return null
    }
    children.push({ childOrdinal: row.childOrdinal, pid: row.pid, snapshotOrdinal: row.snapshotOrdinal, closed: row.closed,
      closedMs: row.closedMs, exitCode: row.exitCode, signalled: row.signalled, events })
  }
  return { version: 1, feature: FEATURE, scope: 'passive-native-child-events',
    counts: Object.fromEntries(COUNT_KEYS.map(key => [key, value.counts[key]])), children }
}

function collectorComplete(value) {
  return value && value.version === 1 && value.feature === FEATURE && value.scope === 'passive-native-child-events'
    && ['parseRejected', 'schemaRejected', 'truncatedLines', 'overBudgetBytes', 'droppedChildren', 'droppedEvents', 'observerErrors', 'spawnFailures']
      .every(key => value.counts?.[key] === 0)
    && value.counts.workerChildren === value.counts.closedChildren
    && Array.isArray(value.children) && value.children.every(row => row.closed === true)
}

function installPreload() {
  const worker = process.env.HFM_SNAPSHOT_BUSY_WORKER, output = process.env.HFM_SNAPSHOT_BUSY_OUTPUT
  if (!worker || !output || !path.isAbsolute(worker) || !path.isAbsolute(output)) return
  const collector = createCollector(), spawn = cp.spawn
  const matches = args => typeof args[0] === 'string' && path.resolve(args[0]).toLowerCase() === path.resolve(worker).toLowerCase()
    && Array.isArray(args[1]) && args[1][0] === '--shared-file-io'
  cp.spawn = function(...args) {
    let observed = false
    try { observed = matches(args) } catch { collector.counts.observerErrors++ }
    let child
    try { child = Reflect.apply(spawn, this, args) }
    catch (error) { if (observed) collector.counts.spawnFailures++; throw error }
    // Never replace the child, its kill method, streams, returned value, or error.
    if (observed) { try { collector.attach(child) } catch { collector.counts.observerErrors++ } }
    return child
  }
  process.once('exit', () => {
    try { fs.writeFileSync(output, JSON.stringify(collector.snapshot())) } catch { /* Missing output makes the driver inconclusive. */ }
  })
}

function receiptReader() {
  let receipt = null, lines = 0, parseRejected = 0
  const reader = lineReader(line => {
    if (!line.trim()) return
    lines++
    try {
      const value = JSON.parse(line)
      if (lines !== 1 || value?.operation !== 'sqliteSnapshot' || typeof value.ok !== 'boolean') { parseRejected++; return }
      receipt = { ok: value.ok, operation: 'sqliteSnapshot', code: ['EIO', 'EEXIST', 'SQLITE_CORRUPT', 'SQLITE_NOTADB'].includes(value.code) ? value.code : null }
    } catch { parseRejected++ }
  }, 32768, 65536)
  return { reader, snapshot: () => ({ receipt, lines, parseRejected, ...reader.counts }) }
}

async function runControl(worker, directory, source, name, ordinal) {
  const owned = path.join(directory, name); await fsp.mkdir(owned)
  const input = path.join(owned, 'input.json'), target = path.join(owned, 'snapshot.sqlite')
  await fsp.writeFile(input, JSON.stringify({ operation: 'sqliteSnapshot', path: source, transferPath: target,
    trace: { version: 1, sessionId: 'private-snapshot-ci', operationId: `snapshot-${ordinal}`, attemptId: 'one', batchId: 'one', domain: 'sqliteSnapshot', members: [], omitted: 0 } }))
  const collector = createCollector(), stdout = receiptReader()
  const execution = { closed: false, exitCode: null, signalled: false, timedOut: false, spawnFailed: false, killFailed: false, streamFailed: false }
  let child
  try { child = cp.spawn(worker, ['--shared-file-io', '--input', input], { windowsHide: true, shell: false,
    stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, HFM_PARENT_PID: String(process.pid) } }) }
  catch { execution.spawnFailed = true; collector.counts.spawnFailures++ }
  if (child) {
    collector.attach(child)
    child.stdout.on('data', data => stdout.reader.write(data))
    for (const stream of [child.stdout, child.stderr]) stream.on('error', () => { execution.streamFailed = true })
    // This safety guard has the same 2000ms bound; it never creates a passing
    // control, and the writer stays locked until the actual close receipt.
    const timer = setTimeout(() => {
      execution.timedOut = true
      try { if (!child.kill('SIGKILL')) execution.killFailed = true } catch { execution.killFailed = true }
    }, 2000)
    await new Promise(resolve => {
      child.once('error', () => { execution.spawnFailed = true })
      child.once('close', (code, signal) => {
        clearTimeout(timer); stdout.reader.end(); execution.closed = true
        execution.exitCode = Number.isInteger(code) ? code : null; execution.signalled = Boolean(signal); resolve()
      })
    })
  }
  const observation = collector.snapshot(), output = stdout.snapshot()
  const events = observation.children.flatMap(row => row.events.filter(event => event.kind === 'busy'))
  const callbacks = { source: events.filter(event => event.event === 'busy-handler' && event.role === 'source').length,
    destination: events.filter(event => event.event === 'busy-handler' && event.role === 'destination').length }
  const steps = events.filter(event => event.event === 'backup-step').map(event => event.outcome)
  const featureProven = events.some(event => event.event === 'begin' && event.version === 1 && event.feature === FEATURE)
  const complete = collectorComplete(observation) && output.parseRejected === 0 && output.truncatedLines === 0 && output.overBudgetBytes === 0
    && output.lines === 1 && execution.closed && execution.exitCode === 0 && !execution.signalled
    && !execution.timedOut && !execution.spawnFailed && !execution.killFailed && !execution.streamFailed
  return { target, record: { name, execution, output, observation, featureProven, callbacks, steps, complete } }
}

function watcherOutput() {
  let exactFailure = null, reportedOk = false, parseRejected = 0, contexts = 0
  const reader = () => lineReader(line => {
    const prefix = '[diagnostics:watcher-noop-freshness] context='
    if (line.startsWith(prefix)) {
      contexts++
      try {
        const context = JSON.parse(line.slice(prefix.length)), failure = context?.sqliteSnapshots?.exactFailure
        if (!failure || !integer(failure.ordinal)) { parseRejected++; return }
        exactFailure = { ordinal: failure.ordinal, requestId: integer(failure.requestId) ? failure.requestId : null,
          phase: FIXTURE_PHASES.has(failure.phase) ? failure.phase : 'other',
          queuedMs: number(failure.queuedMs) ? failure.queuedMs : null, executionMs: number(failure.executionMs) ? failure.executionMs : null }
      } catch { parseRejected++ }
    } else if (line.startsWith('[diagnostics:watcher-noop-freshness] {')) {
      try { reportedOk = JSON.parse(line.slice('[diagnostics:watcher-noop-freshness] '.length)).ok === true }
      catch { parseRejected++ }
    }
  }, 1024 * 1024, 8 * 1024 * 1024)
  const stdout = reader(), stderr = reader()
  return { stdout, stderr, snapshot: () => ({ reportedOk, contexts, parseRejected, exactFailure,
    drain: { stdout: { ...stdout.counts }, stderr: { ...stderr.counts } } }) }
}

async function runWatcher(worker, directory) {
  const output = path.join(directory, 'passive-events.json'), capture = watcherOutput()
  const result = { state: 'running', executions: 1, closed: false, exitCode: null, signalled: false, spawnFailed: false, streamFailed: false }
  let child
  try { child = cp.spawn(process.execPath, ['--experimental-sqlite', '--require', __filename,
    path.join(__dirname, 'check-watcher-noop-freshness.cjs'), '--worker', worker], {
    windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env,
      HFM_SNAPSHOT_BUSY_MODE: MODE, HFM_SNAPSHOT_BUSY_WORKER: worker, HFM_SNAPSHOT_BUSY_OUTPUT: output },
  }) } catch { result.spawnFailed = true; result.state = 'spawn-failed'; return result }
  child.stdout.on('data', data => capture.stdout.write(data)); child.stderr.on('data', data => capture.stderr.write(data))
  for (const stream of [child.stdout, child.stderr]) stream.on('error', () => { result.streamFailed = true })
  await new Promise(resolve => {
    child.once('error', () => { result.spawnFailed = true })
    child.once('close', (code, signal) => {
      capture.stdout.end(); capture.stderr.end(); result.closed = true; result.state = 'closed'
      result.exitCode = Number.isInteger(code) ? code : null; result.signalled = Boolean(signal); resolve()
    })
  })
  result.capture = capture.snapshot()
  try {
    const stat = await fsp.stat(output)
    if (stat.size > 8 * 1024 * 1024) throw fixedFailure('COLLECTOR_SIZE_LIMIT')
    result.observation = decodeObservation(JSON.parse(await fsp.readFile(output, 'utf8')))
    if (!result.observation) throw fixedFailure('COLLECTOR_SCHEMA')
  } catch { result.collectorUnavailable = true; result.collectorReadRejected = 1; delete result.observation }
  const ordinal = result.capture.exactFailure?.ordinal
  const matches = result.observation?.children?.filter(row => row.snapshotOrdinal === ordinal) || []
  result.correlation = { snapshotOrdinal: ordinal ?? null, matchedChildren: matches.length,
    childOrdinals: matches.map(row => row.childOrdinal), pids: matches.map(row => row.pid) }
  return result
}

async function main() {
  const arg = name => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1] }
  const reportPath = path.resolve(arg('--report') || 'artifacts/snapshot-busy-diagnostic.json')
  const commit = arg('--commit') || process.env.GITHUB_SHA || ''
  const report = { version: 1, purpose: 'diagnostic-not-acceptance', feature: FEATURE, status: 'incomplete',
    interpretation: 'Fail-fast busy handlers change lock-wait behavior. These events are not production timing or acceptance evidence.',
    commit: /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(commit) ? commit : null, workerSha256: null,
    controls: [], watcher: { state: 'not-run', executions: 0 }, failure: null }
  const writeReport = async () => { await fsp.mkdir(path.dirname(reportPath), { recursive: true }); await fsp.writeFile(reportPath, JSON.stringify(report, null, 2)) }
  let directory, db, locked = false
  try {
    await writeReport()
    if (process.platform !== 'win32') throw fixedFailure('WINDOWS_REQUIRED')
    if (!arg('--worker') || !report.commit) throw fixedFailure('PROVENANCE_REQUIRED')
    const worker = path.resolve(arg('--worker')); report.workerSha256 = digest(worker)
    directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'hfm-snapshot-busy-diagnostic-'))
    const { DatabaseSync } = require('node:sqlite'), source = path.join(directory, 'control-source.sqlite')
    db = new DatabaseSync(source)
    db.exec("PRAGMA journal_mode=DELETE; CREATE TABLE proof(value TEXT); INSERT INTO proof VALUES ('snapshot-control')")
    const journalMode = db.prepare('PRAGMA journal_mode').get().journal_mode
    if (journalMode !== 'delete') throw fixedFailure('DELETE_JOURNAL_REQUIRED')
    const sourceHash = digest(source)
    const negative = await runControl(worker, directory, source, 'unlocked-negative', 1)
    report.controls.push(negative.record)
    let targetValid = false
    if (negative.record.output.receipt?.ok === true) {
      try {
        const target = new DatabaseSync(negative.target, { readOnly: true })
        try { targetValid = target.prepare('SELECT value FROM proof').get().value === 'snapshot-control' } finally { target.close() }
      } catch { negative.record.targetReadFailed = true }
    }
    negative.record.targetValid = targetValid
    negative.record.passed = negative.record.complete && negative.record.featureProven && targetValid
      && negative.record.steps.length === 1 && negative.record.steps[0] === 'done'
      && negative.record.callbacks.source === 0 && negative.record.callbacks.destination === 0
    if (!negative.record.passed) throw fixedFailure('NEGATIVE_CONTROL_FAILED')
    db.exec('BEGIN EXCLUSIVE'); locked = true
    let positive
    try { positive = await runControl(worker, directory, source, 'exclusive-source-positive', 2); report.controls.push(positive.record) }
    finally { db.exec('ROLLBACK'); locked = false }
    positive.record.writer = { journalMode: 'delete', transaction: 'exclusive', releaseAfterChildClose: positive.record.execution.closed }
    const positiveEvents = positive.record.observation.children.flatMap(row => row.events.filter(event => event.kind === 'busy'))
    const positiveResults = positiveEvents.filter(event => event.event === 'result')
    // The source-size read now encounters EXCLUSIVE before Backup is created.
    // Require that exact boundary and the original SQLite BUSY code; do not
    // manufacture a backup-step receipt or infer lock ownership from text.
    positive.record.passed = positive.record.complete && positive.record.featureProven && positive.record.output.receipt?.ok === false
      && positive.record.steps.length === 0 && positive.record.callbacks.source > 0 && positive.record.callbacks.destination === 0
      && positiveEvents.filter(event => event.event === 'phase').map(event => event.phase).join(',') === 'source-preflight-start'
      && positiveResults.length === 1 && positiveResults[0].outcome === 'sqlite-error'
      && positiveResults[0].primaryCode === 5 && Number.isInteger(positiveResults[0].extendedCode)
      && (positiveResults[0].extendedCode & 255) === 5
    report.sourceUnchanged = digest(source) === sourceHash
    if (!positive.record.passed || !report.sourceUnchanged) throw fixedFailure('POSITIVE_CONTROL_FAILED')
    db.close(); db = undefined
    report.status = 'controls-passed-watcher-pending'; await writeReport()
    report.watcher = await runWatcher(worker, directory)
    report.workerUnchanged = digest(worker) === report.workerSha256
    const watcher = report.watcher, drain = watcher.capture?.drain
    const outputComplete = drain && [drain.stdout, drain.stderr].every(row => row.overBudgetBytes === 0 && row.truncatedLines === 0)
      && watcher.capture.parseRejected === 0
    const correlatedFailure = !watcher.capture?.exactFailure || watcher.correlation?.matchedChildren === 1
    const complete = report.workerUnchanged && watcher.closed && !watcher.spawnFailed && !watcher.signalled && !watcher.streamFailed
      && collectorComplete(watcher.observation) && outputComplete && correlatedFailure
      && (watcher.exitCode === 0 ? watcher.capture.reportedOk : Boolean(watcher.capture.exactFailure))
    report.status = complete ? 'complete-diagnostic-not-acceptance' : 'inconclusive'
    if (!complete || watcher.exitCode !== 0) process.exitCode = 1
  } catch (error) {
    report.status = 'inconclusive'
    report.failure = ['WINDOWS_REQUIRED', 'PROVENANCE_REQUIRED', 'DELETE_JOURNAL_REQUIRED', 'NEGATIVE_CONTROL_FAILED', 'POSITIVE_CONTROL_FAILED']
      .includes(error?.diagnosticCode) ? error.diagnosticCode : 'DRIVER_FAILED'
    process.exitCode = 1
  } finally {
    try { if (db) { if (locked) db.exec('ROLLBACK'); db.close() } } catch { report.cleanupFailed = true; report.status = 'inconclusive'; process.exitCode = 1 }
    try { if (directory) await fsp.rm(directory, { recursive: true, force: true }) } catch { report.cleanupFailed = true; report.status = 'inconclusive'; process.exitCode = 1 }
    await writeReport()
  }
}

if (process.env.HFM_SNAPSHOT_BUSY_MODE === MODE && require.main !== module) installPreload()
else if (require.main === module) main().catch(() => { process.exitCode = 1 })
