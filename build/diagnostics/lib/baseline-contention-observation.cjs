'use strict'
// Timing-only, opt-in observation for the separate frozen-baseline investigation.
// Never reads a pipe, changes decoding, copies payloads, subtracts observer cost,
// changes deadlines, retries a request or interprets availability/business state.
const { AsyncLocalStorage } = require('node:async_hooks')
const { performance } = require('node:perf_hooks')
const { types: { isPromise } } = require('node:util')
const LIMITS = Object.freeze({ processes: 8192, requests: 8192, timers: 16384, sqlite: 32768, parentLag: 4096 })
const SQLITE_POLICY = Object.freeze({ slowThresholdMs: 1, requiredDetailLimit: 24576, fastSampleLimit: 8192,
  initialFastStride: 128, aggregateLimit: 512, windowMs: 250, windowLimit: 16384,
  elapsedAbsoluteToleranceMs: 0.000001, elapsedRelativeTolerance: 0.000000001 })
const brief = error => ({ name: error?.name, code: error?.code, reason: error?.reason, outcome: error?.outcome })
const durationMatches = (left, right) => Number.isFinite(left) && Number.isFinite(right) && Math.abs(left - right) <=
  Math.max(SQLITE_POLICY.elapsedAbsoluteToleranceMs, SQLITE_POLICY.elapsedRelativeTolerance * Math.max(Math.abs(left), Math.abs(right)))

function createBaselineContentionObservation({ getContext = () => ({}), clock = performance,
  timers = { setTimeout, clearTimeout }, onObservation } = {}) {
  const scope = new AsyncLocalStorage(), requestScope = new AsyncLocalStorage()
  const rows = Object.fromEntries(Object.keys(LIMITS).map(key => [key, []]))
  const dropped = { ...Object.fromEntries(Object.keys(LIMITS).map(key => [key, 0])), sqliteAggregates: 0, sqliteWindows: 0 }
  const counters = { processCalls: 0, requests: 0, sqliteCalls: 0, timerCalls: 0, parentLagSamples: 0 }
  const sqliteTotals = new Map(), sqliteWindows = new Map(), patches = new Set(), timerRows = new Map()
  let fastSamples = [], fastStride = SQLITE_POLICY.initialFastStride
  const sqliteMeasured = { calls: 0, failed: 0, elapsedMs: 0 }
  const fastSampling = { calls: 0, elapsedMs: 0, admissions: 0, neverRetained: 0, neverRetainedElapsedMs: 0,
    compacted: 0, compactedElapsedMs: 0, compactions: 0 }
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
  function row(kind, value, limit = LIMITS[kind]) {
    if (rows[kind].length >= limit) { dropped[kind]++; return undefined }
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
      if (![detail.startedAt, detail.finishedAt, detail.elapsedMs].every(Number.isFinite) || detail.startedAt < 0 ||
        detail.finishedAt < detail.startedAt || detail.elapsedMs < 0 || typeof detail.failed !== 'boolean' ||
        !durationMatches(detail.finishedAt - detail.startedAt, detail.elapsedMs)) throw Error('Invalid SQLite timing observation')
      sqliteMeasured.calls++; sqliteMeasured.failed += Number(detail.failed); sqliteMeasured.elapsedMs += detail.elapsedMs
      const current = context(), dimensions = { conditionPhase: current.conditionPhase, owner: current.owner,
        operation: detail.operation, category: detail.category }
      const key = JSON.stringify(Object.values(dimensions))
      let total = sqliteTotals.get(key)
      if (!total) {
        if (sqliteTotals.size >= SQLITE_POLICY.aggregateLimit) { dropped.sqliteAggregates++; return }
        // Do not attribute a whole aggregate to its first event's lane/action.
        total = { aggregateId: sqliteTotals.size + 1, ...dimensions, calls: 0, failed: 0, elapsedMs: 0, maxMs: 0,
          requiredCalls: 0, requiredElapsedMs: 0, fastCalls: 0, fastElapsedMs: 0 }; sqliteTotals.set(key, total)
      }
      total.calls++; total.failed += Number(detail.failed); total.elapsedMs += detail.elapsedMs; total.maxMs = Math.max(total.maxMs, detail.elapsedMs)
      const windowStartAt = Math.floor(detail.startedAt / SQLITE_POLICY.windowMs) * SQLITE_POLICY.windowMs
      const windowKey = total.aggregateId + ':' + windowStartAt
      let window = sqliteWindows.get(windowKey)
      if (!window && sqliteWindows.size < SQLITE_POLICY.windowLimit) {
        window = { aggregateId: total.aggregateId, ...dimensions, windowStartAt, windowEndAt: windowStartAt + SQLITE_POLICY.windowMs,
          calls: 0, failed: 0, elapsedMs: 0, maxMs: 0, firstStartedAt: detail.startedAt, lastFinishedAt: detail.finishedAt }
        sqliteWindows.set(windowKey, window)
      }
      if (!window) dropped.sqliteWindows++
      else {
        window.calls++; window.failed += Number(detail.failed); window.elapsedMs += detail.elapsedMs; window.maxMs = Math.max(window.maxMs, detail.elapsedMs)
        window.firstStartedAt = Math.min(window.firstStartedAt, detail.startedAt); window.lastFinishedAt = Math.max(window.lastFinishedAt, detail.finishedAt)
      }
      if (detail.failed || detail.elapsedMs >= SQLITE_POLICY.slowThresholdMs) {
        total.requiredCalls++; total.requiredElapsedMs += detail.elapsedMs
        row('sqlite', { ...detail, aggregateId: total.aggregateId, retention: detail.failed ? 'failed' : 'slow',
          parentLagBeforeMs: latestLagMs }, SQLITE_POLICY.requiredDetailLimit)
        return
      }
      total.fastCalls++; total.fastElapsedMs += detail.elapsedMs
      fastSampling.calls++; fastSampling.elapsedMs += detail.elapsedMs
      const ordinal = fastSampling.calls
      if (ordinal % fastStride === 0 && fastSamples.length >= SQLITE_POLICY.fastSampleLimit) {
        fastStride *= 2; fastSampling.compactions++
        fastSamples = fastSamples.filter(entry => {
          if (entry.fastOrdinal % fastStride === 0) return true
          fastSampling.compacted++; fastSampling.compactedElapsedMs += entry.elapsedMs; return false
        })
      }
      if (ordinal % fastStride !== 0) { fastSampling.neverRetained++; fastSampling.neverRetainedElapsedMs += detail.elapsedMs; return }
      fastSamples.push({ id: ++sequence, ...current, ...detail, aggregateId: total.aggregateId,
        retention: 'systematic-fast-sample', fastOrdinal: ordinal, parentLagBeforeMs: latestLagMs })
      fastSampling.admissions++
    })
  }
  function sqliteSnapshot() {
    const details = [...rows.sqlite, ...fastSamples].sort((left, right) => left.startedAt - right.startedAt || left.id - right.id)
    const windows = [...sqliteWindows.values()].sort((left, right) => left.windowStartAt - right.windowStartAt || left.aggregateId - right.aggregateId)
    const retained = new Map(), windowTotals = new Map()
    for (const detail of details) {
      let entry = retained.get(detail.aggregateId)
      if (!entry) { entry = { required: 0, requiredElapsedMs: 0, fast: 0, fastElapsedMs: 0 }; retained.set(detail.aggregateId, entry) }
      const kind = detail.retention === 'systematic-fast-sample' ? 'fast' : 'required'
      entry[kind]++; entry[kind + 'ElapsedMs'] += detail.elapsedMs
    }
    for (const window of windows) {
      let total = windowTotals.get(window.aggregateId)
      if (!total) { total = { calls: 0, failed: 0, elapsedMs: 0 }; windowTotals.set(window.aggregateId, total) }
      total.calls += window.calls; total.failed += window.failed; total.elapsedMs += window.elapsedMs
    }
    const totals = [...sqliteTotals.values()].map(total => {
      const detail = retained.get(total.aggregateId) || { required: 0, requiredElapsedMs: 0, fast: 0, fastElapsedMs: 0 }
      const window = windowTotals.get(total.aggregateId) || { calls: 0, failed: 0, elapsedMs: 0 }
      return { ...total, requiredDetailsRetained: detail.required, requiredDetailsMissing: total.requiredCalls - detail.required,
        requiredDetailsElapsedMs: detail.requiredElapsedMs,
        requiredDetailsMissingElapsedMs: total.requiredCalls === detail.required ? 0 : total.requiredElapsedMs - detail.requiredElapsedMs,
        fastDetailsRetained: detail.fast, fastDetailsOmitted: total.fastCalls - detail.fast,
        fastDetailsElapsedMs: detail.fastElapsedMs, fastDetailsOmittedElapsedMs: total.fastCalls === detail.fast ? 0 : total.fastElapsedMs - detail.fastElapsedMs,
        windowCalls: window.calls, windowFailed: window.failed, windowElapsedMs: window.elapsedMs }
    })
    const sum = (values, field) => values.reduce((result, value) => result + value[field], 0)
    const aggregateCalls = sum(totals, 'calls'), aggregateElapsedMs = sum(totals, 'elapsedMs')
    const windowCalls = sum(windows, 'calls'), windowElapsedMs = sum(windows, 'elapsedMs')
    const requiredCalls = sum(totals, 'requiredCalls'), requiredElapsedMs = sum(totals, 'requiredElapsedMs')
    const fastRetainedElapsedMs = sum(fastSamples, 'elapsedMs'), requiredRetainedElapsedMs = sum(rows.sqlite, 'elapsedMs')
    const conservation = {
      observedCalls: counters.sqliteCalls === sqliteMeasured.calls,
      aggregateCalls: aggregateCalls === sqliteMeasured.calls, aggregateElapsedMs: durationMatches(aggregateElapsedMs, sqliteMeasured.elapsedMs),
      aggregateFailures: sum(totals, 'failed') === sqliteMeasured.failed,
      windowCalls: windowCalls === sqliteMeasured.calls, windowElapsedMs: durationMatches(windowElapsedMs, sqliteMeasured.elapsedMs),
      windowFailures: sum(windows, 'failed') === sqliteMeasured.failed,
      partitionCalls: requiredCalls + fastSampling.calls === sqliteMeasured.calls,
      partitionElapsedMs: durationMatches(requiredElapsedMs + fastSampling.elapsedMs, sqliteMeasured.elapsedMs),
      requiredDetails: rows.sqlite.length === requiredCalls && durationMatches(requiredRetainedElapsedMs, requiredElapsedMs),
      requiredFailures: rows.sqlite.reduce((sum, detail) => sum + Number(detail.failed), 0) === sqliteMeasured.failed,
      fastAdmissions: fastSampling.admissions === fastSamples.length + fastSampling.compacted,
      fastCalls: fastSampling.calls === fastSamples.length + fastSampling.compacted + fastSampling.neverRetained,
      fastElapsedMs: durationMatches(fastSampling.elapsedMs, fastRetainedElapsedMs + fastSampling.compactedElapsedMs + fastSampling.neverRetainedElapsedMs),
      groups: totals.every(total => total.calls === total.requiredCalls + total.fastCalls &&
        durationMatches(total.elapsedMs, total.requiredElapsedMs + total.fastElapsedMs)),
      windowGroups: totals.every(total => total.windowCalls === total.calls && total.windowFailed === total.failed &&
        durationMatches(total.windowElapsedMs, total.elapsedMs)),
      requiredGroups: totals.every(total => total.requiredDetailsMissing === 0 && durationMatches(total.requiredDetailsElapsedMs, total.requiredElapsedMs)),
    }
    return { details, windows, totals, coverage: { policy: SQLITE_POLICY, measured: { ...sqliteMeasured }, aggregateCalls, aggregateElapsedMs,
      windowCalls, windowElapsedMs, requiredCalls, requiredDetailsRetained: rows.sqlite.length, requiredDetailsMissing: requiredCalls - rows.sqlite.length,
      requiredElapsedMs, requiredDetailsElapsedMs: requiredRetainedElapsedMs,
      requiredDetailsMissingElapsedMs: rows.sqlite.length === requiredCalls ? 0 : requiredElapsedMs - requiredRetainedElapsedMs,
      fastSampling: { ...fastSampling, finalStride: fastStride, retained: fastSamples.length, retainedElapsedMs: fastRetainedElapsedMs,
        omitted: fastSampling.neverRetained + fastSampling.compacted,
        omittedElapsedMs: fastSampling.neverRetainedElapsedMs + fastSampling.compactedElapsedMs },
      allIndividualCallsRetained: details.length === sqliteMeasured.calls && counters.sqliteCalls === sqliteMeasured.calls,
      conservation, requiredRepresentationComplete: dropped.sqlite === 0 && dropped.sqliteAggregates === 0 && dropped.sqliteWindows === 0 &&
        Object.values(conservation).every(Boolean) } }
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
    const sqlite = sqliteSnapshot()
    return { version: 2, diagnosticOnly: true, excludedFromAcceptance: true, limits: LIMITS, counters: { ...counters },
      dropped: { ...dropped }, observerErrors, restorationConflicts, remainingPatches: patches.size, stopped,
      bookkeepingMs, largestParentLagMs: largestLagMs, sqliteTotals: sqlite.totals, sqliteCoverage: sqlite.coverage,
      rows: { ...rows, sqlite: sqlite.details, sqliteWindows: sqlite.windows },
      timingScope: 'Parent-process monotonic clock. Includes instrumentation cost; never subtracted. Child wall intervals are not OS I/O duration.',
      pipeScope: 'Existing stdout data emissions only; no data listener, decoding change, read, payload copy or receipt interpretation.',
      sqliteScope: 'Synchronous diagnostic SQLite adapter calls only; native worker SQLite is excluded. iterate() measures iterator creation only. Inclusive call durations can overlap through nested port/UDF calls; sums are not exclusive parent blocking time or native I/O duration. Exact all-phase groups use only phase/owner/operation/category, never the first event lane/action. Audit scope surrounds unchanged verifyCommittedBatch.',
      sqliteWindowScope: 'Fixed 250ms parent-monotonic start-time windows, with full inclusive duration assigned to the start window, even if a call crosses its end. First-start/last-finish expose those spans. Exact count/duration/failure conservation is required; no inference of uniformly distributed work within a window.',
      sqliteDetailScope: 'All >=1ms or failed calls require reserved detail storage. Successful sub-ms calls use a global-index systematic sample; stride doubles and earlier samples are compacted when full. Planned fast omissions are counted, not complete individual timelines. Samples may alias periodic work; do not infer quantiles or per-group proportions from them. Fixed windows carry burst attribution. Any required-detail/aggregate/window overflow invalidates collection.',
      timerScope: 'Requested numeric delay, scheduled due-at and actual callback-at separately. Due-at normalization describes ordinary Node timeouts; refreshed timers are not used by the observed shared pool.' }
  }
  sampleLag()
  return { timerGlobals, onSqlitePort, installProcessObserver, installSelectedSource,
    setStage: value => { stage = value }, runOwner: (owner, run) => scope.run(owner, run), snapshot, restore }
}
module.exports = { createBaselineContentionObservation, LIMITS, SQLITE_POLICY }
