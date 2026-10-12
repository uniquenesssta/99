#!/usr/bin/env node
'use strict'
// Windows-only contracts for diagnostic transparency. No baseline run, worker,
// font fixture, timing target or acceptance-envelope change is performed here.
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { observeDiagnosticSqliteCall, productionHostGlobals } = require('./lib/production-projection-host.cjs')
const { createBaselineContentionObservation, LIMITS, SQLITE_POLICY } = require('./lib/baseline-contention-observation.cjs')
const { CONDITIONS, WATCHDOG_MS, positiveClose, baselineOutcome } = require('./check-baseline-contention.cjs')
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
const tick = () => new Promise(resolve => setImmediate(resolve))
function fakeTimers() {
  const calls = [], clears = []
  return { calls, clears, setTimeout(callback, delay, ...args) {
    const handle = { unrefs: 0, unref() { this.unrefs++; return this }, ref() { return this } }
    calls.push({ callback, delay, args, handle }); return handle
  }, clearTimeout(handle) { clears.push(handle) } }
}
function sqliteContracts() {
  assert.deepEqual(productionHostGlobals(), { setImmediate, clearImmediate, Error })
  const expected = {}, failure = Error('original SQLite failure')
  let operations = 0, observations = 0
  assert.equal(observeDiagnosticSqliteCall(undefined, 'get', 'SELECT', () => { operations++; return expected }), expected)
  assert.equal(operations, 1)
  for (const throwing of [false, true]) {
    operations = 0
    const callback = detail => { observations++; assert.deepEqual(Object.keys(detail).sort(),
      ['category', 'elapsedMs', 'failed', 'finishedAt', 'operation', 'startedAt'].sort()); throw Error('observer failed') }
    const run = () => { operations++; if (throwing) throw failure; return expected }
    if (throwing) assert.throws(() => observeDiagnosticSqliteCall(callback, 'run', 'UPDATE', run), error => error === failure)
    else assert.equal(observeDiagnosticSqliteCall(callback, 'get', 'SELECT', run), expected)
    assert.equal(operations, 1)
  }
  assert.equal(observations, 2)
}
async function observerContracts() {
  const timers = fakeTimers(), originalResult = {}, failure = Error('original callback failure')
  const observation = createBaselineContentionObservation({ timers, getContext: () => ({ stage: 'host-stage' }),
    onObservation() { throw Error('controlled observation failure') } })
  const originalGlobals = productionHostGlobals({ timerGlobals: observation.timerGlobals })
  assert.equal(originalGlobals.setTimeout, observation.timerGlobals.setTimeout)
  const receiver = {}, extra = ['same', originalResult]
  let callbackCalls = 0
  const handle = observation.timerGlobals.setTimeout(function (...args) { callbackCalls++; assert.equal(this, receiver); assert.deepEqual(args, extra); return originalResult }, 500, ...extra)
  const scheduled = timers.calls.at(-1)
  assert.equal(handle, scheduled.handle); assert.equal(scheduled.delay, 500); assert.deepEqual(scheduled.args, extra)
  assert.equal(scheduled.callback.apply(receiver, scheduled.args), originalResult); assert.equal(callbackCalls, 1)
  observation.timerGlobals.clearTimeout(handle); assert.equal(timers.clears.at(-1), handle)
  observation.timerGlobals.setTimeout(() => { throw failure }, 3000)
  assert.throws(() => timers.calls.at(-1).callback(), error => error === failure)

  const child = new EventEmitter(), stdout = new EventEmitter()
  Object.assign(child, { pid: 22, stdout })
  let spawnCalls = 0
  const observer = { childProcess: { spawn(...args) { spawnCalls++; assert.equal(this, observer.childProcess); assert.deepEqual(args, ['worker', ['--read']]); return child } } }
  const originalSpawn = observer.childProcess.spawn, originalChildEmit = child.emit, originalStdoutEmit = stdout.emit
  observation.installProcessObserver(observer)
  assert.equal(observer.childProcess.spawn('worker', ['--read']), child); assert.equal(spawnCalls, 1)
  assert.equal(stdout.listenerCount('data'), 0, 'Observer switched stdout to a flowing data listener')
  child.emit('spawn'); assert.equal(stdout.emit('data', 'private receipt payload'), false)
  child.emit('exit', 0, null); child.emit('close', 0, null)
  assert.equal(child.emit, originalChildEmit); assert.equal(stdout.emit, originalStdoutEmit)
  const processRow = observation.snapshot().rows.processes[0]
  for (const key of ['spawnCallAt', 'spawnReturnAt', 'spawnEventAt', 'firstStdoutAt', 'exitAt', 'closeAt']) assert(Number.isFinite(processRow[key]))
  assert.equal(processRow.firstStdoutLength, 'private receipt payload'.length)
  assert(!JSON.stringify(processRow).includes('private receipt payload'), 'Observer retained stdout content')

  const pending = deferred(), closed = deferred()
  const pool = { run: () => pending.promise }, originalRun = pool.run
  observation.installSelectedSource(file => { assert.equal(file, 'src/main/path/sharedIoProcessRuntime.ts'); return { applicationSharedIoProcessRuntime: () => pool } })
  // The existing workload installs one outer wrapper and restores that wrapper
  // before timing observation. Exercise the same nested restoration order.
  const timingRun = pool.run
  const outerWorkloadRun = function (...args) { return Reflect.apply(timingRun, this, args) }
  pool.run = outerWorkloadRun
  const request = { label: 'read', args: ['--read'], roots: ['root'], timeoutMs: 500, queueTimeoutMs: 3000 }
  assert.equal(pool.run(request), pending.promise, 'Observer replaced the original Promise')
  const timeout = Object.assign(Error('original timeout'), { reason: 'timeout', outcome: 'unknown', closed: closed.promise })
  pending.reject(timeout); await tick()
  const requestRow = observation.snapshot().rows.requests[0]
  assert.equal(requestRow.error.reason, 'timeout'); assert(Number.isFinite(requestRow.timeoutObservedAt))
  assert.equal(requestRow.physicalCloseObservedAt, undefined)
  closed.resolve(); await tick(); assert(Number.isFinite(requestRow.physicalCloseObservedAt))
  observation.runOwner('verifyCommittedBatch-audit', () => observation.onSqlitePort({ operation: 'get', category: 'SELECT', startedAt: 1, finishedAt: 2, elapsedMs: 1, failed: false }))
  assert.equal(observation.snapshot().rows.sqlite[0].owner, 'verifyCommittedBatch-audit')
  assert.equal(observation.snapshot().rows.sqlite[0].conditionPhase, 'setup', 'Host context overwrote diagnostic phase')
  assert(observation.snapshot().observerErrors > 0, 'Controlled observation failures were not retained')
  assert.equal(pool.run, outerWorkloadRun); pool.run = timingRun // meter.restore()
  observation.restore()
  assert.equal(pool.run, originalRun); assert.equal(observer.childProcess.spawn, originalSpawn)
  assert.equal(observation.snapshot().remainingPatches, 0); assert.equal(observation.snapshot().restorationConflicts, 0)
  assert.equal(observation.snapshot().stopped, true)
  const brokenClockTimers = fakeTimers()
  const brokenClock = createBaselineContentionObservation({ timers: brokenClockTimers, clock: { now() { throw Error('clock unavailable') } } })
  const stable = brokenClock.timerGlobals.setTimeout(() => originalResult, 500)
  assert.equal(stable, brokenClockTimers.calls.at(-1).handle)
  assert.equal(brokenClockTimers.calls.at(-1).callback(), originalResult)
  brokenClock.restore(); assert(brokenClock.snapshot().observerErrors > 0)
}
function sqliteRepresentationContracts() {
  const make = getContext => createBaselineContentionObservation({ timers: fakeTimers(), clock: { now: () => 20 }, getContext })
  const detail = (startedAt, elapsedMs = 0.01, failed = false, category = 'SELECT') =>
    ({ operation: 'get', category, startedAt, finishedAt: startedAt + elapsedMs, elapsedMs, failed })
  let ordinal = 0
  const observation = make(() => ({ stage: 'host-stage', lane: ordinal % 2 ? 'browse' : 'metrics', actionId: String(ordinal) }))
  observation.setStage('timed')
  // Exceed the old all-call cap, then force one bounded sample compaction.
  // No database/child/fixture is involved in this synthetic Windows contract.
  const fastCount = SQLITE_POLICY.initialFastStride * (SQLITE_POLICY.fastSampleLimit + 1)
  for (ordinal = 1; ordinal <= fastCount; ordinal++) observation.onSqlitePort(detail(ordinal / 1000))
  observation.runOwner('verifyCommittedBatch-audit', () => observation.onSqlitePort(detail(1249, 301)))
  observation.onSqlitePort(detail(1600, 0.01, true))
  observation.restore()
  const snapshot = observation.snapshot(), coverage = snapshot.sqliteCoverage
  assert.equal(snapshot.version, 2); assert.equal(snapshot.counters.sqliteCalls, fastCount + 2)
  assert.equal(coverage.requiredRepresentationComplete, true); assert(Object.values(coverage.conservation).every(Boolean))
  assert.equal(coverage.allIndividualCallsRetained, false, 'Sampled fast calls were claimed as a complete individual timeline')
  assert.equal(coverage.requiredCalls, 2); assert.equal(coverage.requiredDetailsRetained, 2); assert.equal(coverage.requiredDetailsMissing, 0)
  assert.equal(coverage.fastSampling.compactions, 1); assert.equal(coverage.fastSampling.finalStride, SQLITE_POLICY.initialFastStride * 2)
  assert.equal(coverage.fastSampling.compacted, SQLITE_POLICY.fastSampleLimit / 2)
  assert.equal(coverage.fastSampling.retained, SQLITE_POLICY.fastSampleLimit / 2)
  assert.equal(coverage.fastSampling.omitted, fastCount - coverage.fastSampling.retained)
  assert.equal(coverage.fastSampling.calls, coverage.fastSampling.retained + coverage.fastSampling.neverRetained + coverage.fastSampling.compacted)
  assert(snapshot.rows.sqlite.length <= LIMITS.sqlite); assert(Object.values(snapshot.dropped).every(value => value === 0))
  const sampled = snapshot.rows.sqlite.filter(row => row.retention === 'systematic-fast-sample')
  assert(sampled.every(row => row.fastOrdinal % coverage.fastSampling.finalStride === 0))
  assert(sampled.every(row => row.startedAt === row.fastOrdinal / 1000 && row.actionId === String(row.fastOrdinal) && row.elapsedMs === 0.01),
    'Compaction changed surviving timing/context values')
  assert(sampled[0].fastOrdinal < fastCount / 4 && sampled.at(-1).fastOrdinal > fastCount * 3 / 4, 'Sample retained only the initial prefix')
  assert(snapshot.rows.sqlite.some(row => row.retention === 'failed' && row.startedAt === 1600), 'Late failed call lost behind fast-call flood')
  const slow = snapshot.rows.sqlite.find(row => row.retention === 'slow')
  assert.equal(slow.owner, 'verifyCommittedBatch-audit'); assert.equal(slow.startedAt, 1249); assert.equal(slow.finishedAt, 1550)
  assert.equal(slow.conditionPhase, 'timed'); assert.equal(slow.actionId, String(ordinal))
  const window = snapshot.rows.sqliteWindows.find(row => row.owner === 'verifyCommittedBatch-audit')
  assert.equal(window.windowStartAt, 1000); assert.equal(window.windowEndAt, 1250)
  assert.equal(window.firstStartedAt, 1249); assert.equal(window.lastFinishedAt, 1550); assert.equal(window.elapsedMs, 301)
  for (const group of [...snapshot.sqliteTotals, ...snapshot.rows.sqliteWindows]) {
    assert(!Object.hasOwn(group, 'lane') && !Object.hasOwn(group, 'actionId') && !Object.hasOwn(group, 'stage'), 'First-event context mislabeled a whole aggregate')
  }
  const totals = snapshot.sqliteTotals
  assert.equal(totals.reduce((sum, row) => sum + row.calls, 0), fastCount + 2)
  assert.equal(totals.reduce((sum, row) => sum + row.fastDetailsOmitted, 0), coverage.fastSampling.omitted)

  const overflow = make()
  for (let index = 0; index <= SQLITE_POLICY.requiredDetailLimit; index++) overflow.onSqlitePort(detail(1, 1))
  overflow.restore()
  const lost = overflow.snapshot()
  assert.equal(lost.dropped.sqlite, 1); assert.equal(lost.sqliteCoverage.requiredDetailsMissing, 1)
  assert.equal(lost.sqliteCoverage.requiredRepresentationComplete, false, 'Missing required slow details were treated as planned fast sampling')
  assert.equal(lost.sqliteCoverage.conservation.aggregateCalls, true); assert.equal(lost.sqliteCoverage.conservation.windowCalls, true)

  const windowOverflow = make()
  for (let index = 0; index <= SQLITE_POLICY.windowLimit; index++) windowOverflow.onSqlitePort(detail(index * SQLITE_POLICY.windowMs))
  windowOverflow.restore()
  const lostWindow = windowOverflow.snapshot()
  assert.equal(lostWindow.dropped.sqliteWindows, 1); assert.equal(lostWindow.rows.sqliteWindows.length, SQLITE_POLICY.windowLimit)
  assert.equal(lostWindow.sqliteCoverage.requiredRepresentationComplete, false)
  assert.equal(lostWindow.sqliteCoverage.conservation.aggregateCalls, true); assert.equal(lostWindow.sqliteCoverage.conservation.windowCalls, false)

  const aggregateOverflow = make()
  for (let index = 0; index <= SQLITE_POLICY.aggregateLimit; index++) aggregateOverflow.onSqlitePort(detail(1, 0.01, false, 'category-' + index))
  aggregateOverflow.restore()
  const lostAggregate = aggregateOverflow.snapshot()
  assert.equal(lostAggregate.dropped.sqliteAggregates, 1); assert.equal(lostAggregate.sqliteTotals.length, SQLITE_POLICY.aggregateLimit)
  assert.equal(lostAggregate.sqliteCoverage.requiredRepresentationComplete, false)
  assert.equal(lostAggregate.sqliteCoverage.conservation.aggregateCalls, false)

  const malformed = make()
  for (const input of [detail(1, -1), detail(NaN), { ...detail(1), elapsedMs: Infinity }, { ...detail(1), finishedAt: 0 },
    { ...detail(1), elapsedMs: 20 }, { ...detail(1), failed: undefined }]) malformed.onSqlitePort(input)
  malformed.restore()
  const invalid = malformed.snapshot()
  assert.equal(invalid.counters.sqliteCalls, 6); assert.equal(invalid.observerErrors, 6)
  assert.equal(invalid.sqliteCoverage.requiredRepresentationComplete, false, 'Malformed timing data was declared complete')
}
function declarationContracts() {
  assert.deepEqual(CONDITIONS, [{ id: 'baseline-with-foreground', foreground: true }, { id: 'baseline-without-foreground', foreground: false }])
  assert(Object.isFrozen(CONDITIONS)); assert(CONDITIONS.every(Object.isFrozen))
  assert.equal(WATCHDOG_MS, 900000); assert(Object.values(LIMITS).every(value => Number.isInteger(value) && value > 0 && value <= 32768))
  assert(Object.isFrozen(SQLITE_POLICY)); assert.equal(SQLITE_POLICY.requiredDetailLimit + SQLITE_POLICY.fastSampleLimit, LIMITS.sqlite)
  assert.equal(SQLITE_POLICY.windowMs, 250); assert.equal(SQLITE_POLICY.slowThresholdMs, 1)
  assert.equal(positiveClose({ hostClosed: true, databaseOwnersClosed: true, childrenReaped: true, remainingDatabaseOwners: 0, remainingChildren: 0 }), true)
  assert.equal(positiveClose({ hostClosed: true, databaseOwnersClosed: true, childrenReaped: false, remainingDatabaseOwners: 0, remainingChildren: 1 }), false)
  const outcome = baselineOutcome({ condition: CONDITIONS[1], progress: [{ stage: 'done' }], independentSql: { unknown: 3 },
    summary: { total: 5490, updatedCount: 5490, installedCount: 253, notInstalledCount: 5234, missingCount: 3 } })
  assert.equal(outcome.completed, true); assert.equal(outcome.fullPopulationConfirmed, false); assert.equal(outcome.unknownRows, 3)
  assert.equal(outcome.foregroundCompleted, null)
  const optimistic = baselineOutcome({ condition: CONDITIONS[1], progress: [{ stage: 'done' }],
    independentSql: { total: 5490, installed: 253, notInstalled: 5234, unknown: 3 },
    summary: { total: 5490, updatedCount: 5490, installedCount: 256, notInstalledCount: 5234, missingCount: 0 } })
  assert.equal(optimistic.fullPopulationConfirmed, false, 'Optimistic summary concealed persisted unknown rows')
}
async function main() {
  assert.equal(process.platform, 'win32', 'Diagnostic transparency contracts execute only on Windows')
  sqliteContracts(); declarationContracts(); await observerContracts(); sqliteRepresentationContracts()
  console.log('baseline contention diagnostic: inert defaults, observer isolation, timer/Promise/child identity, physical close, conserved bounded SQL windows and explicit fast sampling passed')
}
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1 })
module.exports = { main }
