'use strict'
// Timing-only, opt-in observation for the separate frozen-baseline investigation.
// Never reads a pipe, changes decoding, copies payloads, subtracts observer cost,
// changes deadlines, retries a request or interprets availability/business state.
const { AsyncLocalStorage } = require('node:async_hooks')
const { performance } = require('node:perf_hooks')
const { types: { isPromise } } = require('node:util')
const LIMITS = Object.freeze({ processes: 8192, requests: 8192, timers: 16384, sqlite: 32768, parentLag: 4096 })
const brief = error => ({ name: error?.name, code: error?.code, reason: error?.reason, outcome: error?.outcome })

function createBaselineContentionObservation({ getContext = () => ({}), clock = performance,
  timers = { setTimeout, clearTimeout }, onObservation } = {}) {
  const scope = new AsyncLocalStorage(), requestScope = new AsyncLocalStorage()
  const rows = Object.fromEntries(Object.keys(LIMITS).map(key => [key, []]))
  const dropped = Object.fromEntries(Object.keys(LIMITS).map(key => [key, 0]))
  const counters = { processCalls: 0, requests: 0, sqliteCalls: 0, timerCalls: 0, parentLagSamples: 0 }
  const sqliteTotals = new Map(), patches = new Set(), timerRows = new Map()
  let observerErrors = 0, restorationConflicts = 0, sequence = 0, stage = 'setup', stopped = false, lagHandle
  let latestLagMs = 0, largestLagMs = 0, bookkeepingMs = 0
  const now = () => clock.now()
  function safe(run) {
    let start
    try { start = now() } catch { observerErrors++ }
    try { const result = run(); onObservation?.(); return result }
    catch { observerErrors++; return undefined }
    finally { if (start !== undefined) try { bookkeepingMs += Math.max(0, now() - start) } catch { observerErrors++ } }
  }
  function context() { return { ...getContext(), conditionPhase: stage,
    owner: scope.getStore() || (stage === 'timed' ? 'selected-production' : stage) } }
  function row(kind, value) {
    if (rows[kind].length >= LIMITS[kind]) { dropped[kind]++; return undefined }
    const item = { id: ++sequence, ...context(), ...value }; rows[kind].push(item); return item
  }
  function patch(object, key, wrapped) {
    const original = object[key], hadOwn = Object.hasOwn(object, key)
    object[key] = wrapped(original)
    const installed = object[key]
    const restore = () => {
      if (!patches.delete(restore)) return
      if (object[key] !== installed) { restorationConflicts++; return }
      if (hadOwn) object[key] = original; else delete object[key]
    }
    patches.add(restore); return restore
  }
  function observeSpawn(original, receiver, args) {
    let entry
    safe(() => { counters.processCalls++; entry = row('processes', { requestId: requestScope.getStore()?.id,
      command: typeof args[1]?.[0] === 'string' ? args[1][0].slice(0, 100) : undefined,
      spawnCallAt: now(), parentLagAtSpawnMs: latestLagMs }) })
    let child
    try { child = Reflect.apply(original, receiver, args) }
    catch (error) { safe(() => { if (entry) { entry.spawnThrowAt = now(); entry.error = brief(error) } }); throw error }
    safe(() => {
      if (!entry) return
      entry.spawnReturnAt = now(); entry.spawnCallElapsedMs = entry.spawnReturnAt - entry.spawnCallAt; entry.pid = child.pid
      let restoreStdout, restoreChild
      // Observe existing emits, not a data listener/read()/resume()/setEncoding().
      // Return the original emit value and preserve every listener and receiver.
      if (child.stdout) restoreStdout = patch(child.stdout, 'emit', emit => function (event, ...values) {
        if (event === 'data') safe(() => {
          if (entry.firstStdoutAt === undefined) {
            entry.firstStdoutAt = now()
            const value = values[0]
            entry.firstStdoutLength = typeof value === 'string' ? value.length : Buffer.isBuffer(value) ? value.length : undefined
            entry.stdoutLengthUnit = typeof value === 'string' ? 'decoded-characters' : 'bytes'
          }
        })
        return Reflect.apply(emit, this, [event, ...values])
      })
      restoreChild = patch(child, 'emit', emit => function (event, ...values) {
        safe(() => {
          if (event === 'spawn') entry.spawnEventAt = now()
          if (event === 'error') { entry.errorAt = now(); entry.error = brief(values[0]) }
          if (event === 'exit') { entry.exitAt = now(); entry.exitCode = values[0]; entry.exitSignal = values[1] }
          if (event === 'close') {
            entry.closeAt = now(); entry.closeCode = values[0]; entry.closeSignal = values[1]
            restoreStdout?.(); restoreChild?.()
          }
        })
        return Reflect.apply(emit, this, [event, ...values])
      })
    })
    return child
  }
  function installProcessObserver(observer) {
    safe(() => patch(observer.childProcess, 'spawn', original => function (...args) { return observeSpawn(original, this, args) }))
  }
  function installSelectedSource(load) {
    safe(() => {
      const pool = load('src/main/path/sharedIoProcessRuntime.ts').applicationSharedIoProcessRuntime()
      patch(pool, 'run', original => function (request) {
        let entry
        safe(() => { counters.requests++; entry = row('requests', { admittedAt: now(), label: request.label,
          command: request.args?.[0], processLane: request.lane || 'default', timeoutMs: request.timeoutMs,
          queueTimeoutMs: request.queueTimeoutMs ?? 3000, rootCount: request.roots.length }) })
        const result = requestScope.run(entry, () => Reflect.apply(original, this, [request]))
        if (entry && isPromise(result)) {
          Promise.prototype.then.call(result, value => safe(() => {
            entry.resolvedAt = now(); entry.queuedMs = value.queuedMs; entry.executionMs = value.executionMs
          }), error => safe(() => {
            entry.rejectedAt = now(); entry.error = brief(error); entry.queuedMs = error?.queuedMs; entry.executionMs = error?.executionMs
            if (['timeout', 'queue-timeout'].includes(error?.reason)) entry.timeoutObservedAt = entry.rejectedAt
            if (isPromise(error?.closed)) Promise.prototype.then.call(error.closed,
              () => safe(() => { entry.physicalCloseObservedAt = now() }), () => safe(() => { entry.physicalCloseRejected = true }))
          }))
        }
        return result // Preserve native Promise identity and settlement.
      })
    })
  }
  const timerGlobals = {
    setTimeout(callback, delay, ...args) {
      let entry
      safe(() => { counters.timerCalls++; const scheduledAt = now()
        entry = row('timers', { requestId: requestScope.getStore()?.id, scheduledAt,
          requestedDelayMs: typeof delay === 'number' ? delay : undefined,
          // Node clamps <1, NaN and >2^31-1 to 1 and truncates fractional delays.
          scheduledDelayMs: typeof delay === 'number' && delay >= 1 && delay <= 2147483647 ? Math.trunc(delay) : 1 })
        if (entry) entry.dueAt = scheduledAt + entry.scheduledDelayMs
      })
      let handle
      // Invalid callbacks still reach Node unchanged and throw the same error.
      const wrapped = typeof callback !== 'function' ? callback : function (...values) {
        safe(() => { if (entry) { entry.callbackAt = now(); entry.callbackLagMs = Math.max(0, entry.callbackAt - entry.dueAt) }; timerRows.delete(handle) })
        return Reflect.apply(callback, this, values)
      }
      handle = Reflect.apply(timers.setTimeout, timers, [wrapped, delay, ...args])
      safe(() => { if (entry) timerRows.set(handle, entry) })
      return handle // Original .unref/.ref/.refresh/close semantics and identity.
    },
    clearTimeout(handle) {
      safe(() => { const entry = timerRows.get(handle); if (entry) entry.clearedAt = now(); timerRows.delete(handle) })
      return Reflect.apply(timers.clearTimeout, timers, [handle])
    },
  }
  function onSqlitePort(detail) {
    safe(() => {
      counters.sqliteCalls++
      const current = context(), key = [current.conditionPhase, current.owner, detail.operation, detail.category].join('|')
      let total = sqliteTotals.get(key)
      if (!total) {
        if (sqliteTotals.size >= 512) { dropped.sqlite++; return }
        total = { ...current, operation: detail.operation, category: detail.category, calls: 0, failed: 0, elapsedMs: 0, maxMs: 0 }; sqliteTotals.set(key, total)
      }
      total.calls++; total.failed += Number(detail.failed); total.elapsedMs += detail.elapsedMs; total.maxMs = Math.max(total.maxMs, detail.elapsedMs)
      // Fixture seeding performs thousands of tiny calls before the workload.
      // Keep exact all-phase aggregates, but reserve detailed records for timed
      // operations and >=1ms setup/prelude/cleanup calls that can block a parent.
      if (stage === 'timed' || detail.elapsedMs >= 1) row('sqlite', { ...detail, parentLagBeforeMs: latestLagMs })
    })
  }
  function sampleLag() {
    const dueAt = safe(() => now() + 50)
    if (!Number.isFinite(dueAt)) return
    lagHandle = timers.setTimeout(() => {
      if (stopped) return
      safe(() => { const callbackAt = now(); latestLagMs = Math.max(0, callbackAt - dueAt); largestLagMs = Math.max(largestLagMs, latestLagMs)
        counters.parentLagSamples++; row('parentLag', { dueAt, callbackAt, lagMs: latestLagMs }) })
      sampleLag()
    }, 50)
    lagHandle.unref?.()
  }
  function restore() {
    if (stopped) return
    stopped = true; timers.clearTimeout(lagHandle)
    for (const restore of [...patches].reverse()) safe(restore)
    timerRows.clear()
  }
  function snapshot() {
    return { version: 1, diagnosticOnly: true, excludedFromAcceptance: true, limits: LIMITS, counters: { ...counters },
      dropped: { ...dropped }, observerErrors, restorationConflicts, remainingPatches: patches.size, stopped,
      bookkeepingMs, largestParentLagMs: largestLagMs, sqliteTotals: [...sqliteTotals.values()], rows,
      timingScope: 'Parent-process monotonic clock. Includes instrumentation cost; never subtracted. Child wall intervals are not OS I/O duration.',
      pipeScope: 'Existing stdout data emissions only; no data listener, decoding change, read, payload copy or receipt interpretation.',
      sqliteScope: 'Synchronous diagnostic SQLite adapter calls only; native worker SQLite is excluded. iterate() measures iterator creation only, not later iteration. Exact aggregate counts/durations for every phase; detailed rows for timed calls plus >=1ms calls outside timed work. Audit scope surrounds the unchanged verifyCommittedBatch call.',
      timerScope: 'Requested numeric delay, scheduled due-at and actual callback-at separately. Due-at normalization describes ordinary Node timeouts; refreshed timers are not used by the observed shared pool.' }
  }
  sampleLag()
  return { timerGlobals, onSqlitePort, installProcessObserver, installSelectedSource,
    setStage: value => { stage = value }, runOwner: (owner, run) => scope.run(owner, run), snapshot, restore }
}
module.exports = { createBaselineContentionObservation, LIMITS }
