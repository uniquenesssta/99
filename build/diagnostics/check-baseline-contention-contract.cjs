#!/usr/bin/env node
'use strict'
// Windows-only contracts for diagnostic transparency. No baseline run, worker,
// font fixture, timing target or acceptance-envelope change is performed here.
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { observeDiagnosticSqliteCall, productionHostGlobals } = require('./lib/production-projection-host.cjs')
const { createBaselineContentionObservation, LIMITS } = require('./lib/baseline-contention-observation.cjs')
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
function declarationContracts() {
  assert.deepEqual(CONDITIONS, [{ id: 'baseline-with-foreground', foreground: true }, { id: 'baseline-without-foreground', foreground: false }])
  assert(Object.isFrozen(CONDITIONS)); assert(CONDITIONS.every(Object.isFrozen))
  assert.equal(WATCHDOG_MS, 900000); assert(Object.values(LIMITS).every(value => Number.isInteger(value) && value > 0 && value <= 32768))
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
  sqliteContracts(); declarationContracts(); await observerContracts()
  console.log('baseline contention diagnostic: inert defaults, observer exception isolation, exact timer/Promise/child semantics, no pipe consumption, physical close and separate outcomes passed')
}
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1 })
module.exports = { main }
