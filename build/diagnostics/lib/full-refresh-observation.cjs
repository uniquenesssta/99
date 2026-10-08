'use strict'
// Diagnostic observers only: no I/O, retries, deadline changes or payload copies.
// Node 24: https://nodejs.org/docs/latest-v24.x/api/perf_hooks.html
// Use APIs present before Node 24 (not the newer ELU alias/samplePerIteration).
const { AsyncLocalStorage } = require('node:async_hooks')
const { types: { isPromise } } = require('node:util')
const defaults = Object.freeze({ phases: 512, deadlines: 512, availability: 512, roots: 512, admissions: 8192, projections: 64, stages: 16 })
const text = (value, limit = 160) => typeof value === 'string' ? value.slice(0, limit) : undefined
const number = value => typeof value === 'number' && Number.isFinite(value) ? value : undefined
const errorSummary = error => ({ name: text(error?.name), code: text(error?.code), reason: text(error?.reason), outcome: text(error?.outcome), message: text(error?.message, 240) })
const countKeys = ['all', 'total', 'installed', 'notInstalled', 'unknown', 'installedCount', 'notInstalledCount', 'installStatusMissingCount', 'capturedAt', 'count', 'rootCount', 'requestSequence', 'startedAt', 'finishedAt', 'elapsedMs']
const categoryKeys = ['workerMode', 'allWorkerMode', 'installedWorkerMode', 'notInstalledWorkerMode', 'method', 'sidebarPage', 'activeFilter', 'stage', 'lane', 'actionId']
function counts(value) {
  if (!value || typeof value !== 'object') return undefined
  const result = {}
  for (const key of countKeys) if (number(value[key]) !== undefined) result[key] = value[key]
  for (const key of categoryKeys) if (text(value[key]) !== undefined) result[key] = text(value[key])
  return result
}
function createFullRefreshObservation({ getScope = () => undefined, limits: requestedLimits = {}, perfHooks = require('node:perf_hooks'), processInfo = process } = {}) {
  const { performance } = perfHooks, nesting = new AsyncLocalStorage()
  const limits = Object.fromEntries(Object.entries(defaults).map(([key, cap]) => [key, Number.isInteger(requestedLimits[key]) ? Math.max(0, Math.min(cap, requestedLimits[key])) : cap]))
  const rows = Object.fromEntries(Object.keys(defaults).map(key => [key, []]))
  const dropped = Object.fromEntries(Object.keys(defaults).map(key => [key, 0]))
  const patches = [], rootStates = new Map(), hooks = []
  let observerDepth = 0
  let stage = 'setup', stopped = false, observerErrors = 0, bookkeepingMs = 0, sequence = 0, rootRevision = 0, restorationConflicts = 0, lateCompletions = 0, installed = false, histogramEnabled = false, histogramDisabled = false, histogram
  const now = () => performance.now()
  function guard(work) {
    let start
    const outer = observerDepth++ === 0
    if (outer) try { start = now() } catch { observerErrors++ }
    try { return work() }
    catch { observerErrors++; return undefined }
    finally {
      observerDepth--
      if (outer && start !== undefined) try { bookkeepingMs += Math.max(0, now() - start) } catch { observerErrors++ }
    }
  }
  function histogramView() {
    if (!histogram) return undefined
    const sampled = Number(histogram.count || 0)
    return { sampleCount: sampled, maxMs: sampled ? number(histogram.max / 1e6) : undefined,
      meanMs: sampled ? number(histogram.mean / 1e6) : undefined, p99Ms: sampled ? number(histogram.percentile(99) / 1e6) : undefined,
      scope: 'case/global-stage histogram; overlapping actions are not isolated' }
  }
  function systemView() {
    const memory = processInfo.memoryUsage()
    return { rssBytes: number(memory.rss), heapUsedBytes: number(memory.heapUsed), heapTotalBytes: number(memory.heapTotal), eventLoopDelay: histogramView() }
  }
  function scopeView() {
    const current = getScope()
    return { stage: text(current?.stage) || stage, lane: text(current?.lane), actionId: text(current?.actionId) }
  }
  function add(kind, detail = {}) {
    if (rows[kind].length >= limits[kind]) { dropped[kind]++; return undefined }
    const row = { id: ++sequence, parentId: nesting.getStore()?.id, ...scopeView(), startedAt: now(), ...detail }
    rows[kind].push(row)
    return row
  }
  function begin(kind, detail) {
    const row = add(kind, detail)
    if (!row) return undefined
    row.systemAtStart = guard(systemView)
    const cpu = guard(() => processInfo.cpuUsage()), elu = guard(() => performance.eventLoopUtilization())
    return { row, cpu, elu }
  }
  function finish(entry, value, error, rejected) {
    if (!entry) return
    guard(() => {
      const row = entry.row, cpu = guard(() => processInfo.cpuUsage())
      row.finishedAt = now(); row.elapsedMs = row.finishedAt - row.startedAt
      row.outcome = rejected ? 'rejected' : 'returned'
      if (rejected) row.error = errorSummary(error)
      if (row.kind === 'deadline' && !rejected) {
        row.ok = value?.ok === true; row.timedOut = value?.timedOut === true
        if (value?.ok === false) row.error = errorSummary(value.error)
      }
      if (row.kind === 'phase' && Buffer.isBuffer(value)) row.returnedBytes = value.length
      if (row.kind === 'availability' && typeof value === 'boolean') row.available = value
      if (cpu && entry.cpu) { row.cpuUserMs = number((cpu.user - entry.cpu.user) / 1000); row.cpuSystemMs = number((cpu.system - entry.cpu.system) / 1000) }
      const elu = entry.elu && guard(() => performance.eventLoopUtilization(entry.elu))
      if (elu) row.eventLoopUtilization = { idleMs: number(elu.idle), activeMs: number(elu.active), utilization: number(elu.utilization) }
      row.systemAtFinish = guard(systemView)
      if (stopped) { row.completedAfterRestore = true; lateCompletions++ }
    })
  }
  function wrap(original, kind, describe) {
    const wrapped = function (...args) {
      if (stopped) return Reflect.apply(original, this, args)
      const entry = guard(() => begin(kind, describe(args)))
      let result
      try { result = entry ? nesting.run({ id: entry.row.id }, () => Reflect.apply(original, this, args)) : Reflect.apply(original, this, args) }
      catch (error) { finish(entry, undefined, error, true); throw error }
      // Native Promise identity is preserved, including promises from a VM.
      // Do not assimilate arbitrary thenables or inspect/hash returned payloads.
      if (isPromise(result)) guard(() => { Promise.prototype.then.call(result, value => finish(entry, value, undefined, false), error => finish(entry, undefined, error, true)) })
      else finish(entry, result, undefined, false)
      return result
    }
    guard(() => Object.defineProperty(wrapped, 'length', { value: original.length }))
    return wrapped
  }
  function patch(module, key, make) {
    guard(() => {
      if (typeof module[key] !== 'function') throw Error('Missing selected-source observation hook')
      const original = module[key], wrapped = make(original)
      module[key] = wrapped
      patches.push({ module, key, original, wrapped }); hooks.push(key)
    })
  }
  function observeRoot(value) {
    if (!value || typeof value.rootId !== 'string') return
    const rootId = value.rootId
    const next = { state: text(value.state), generation: number(value.generation), lastError: text(value.lastError, 240),
      lastProbeQueuedMs: number(value.lastProbeQueuedMs), lastProbeExecutionMs: number(value.lastProbeExecutionMs) }
    const old = rootStates.get(rootId)
    if (old && Object.keys(next).every(key => next[key] === old[key])) return
    if (!old && rootStates.size >= 64) { dropped.roots++; return }
    rootStates.set(rootId, next); rootRevision++
    add('roots', { rootId: text(rootId, 512), rootRevision, ...next })
  }
  function installSelectedSource(load) {
    if (stopped || installed) return
    installed = true
    const deadline = guard(() => load('src/main/path/ioDeadlineRuntime.ts'))
    if (deadline) patch(deadline, 'withIoDeadlineResult', original => wrap(original, 'deadlines', args => ({ kind: 'deadline', label: text(args[0]), requestedTimeoutMs: number(args[2]) })))
    const preview = guard(() => load('src/main/preview/runtime/previewTraceRuntime.ts'))
    if (preview) patch(preview, 'tracePreviewPhase', original => wrap(original, 'phases', args => ({ kind: 'phase', label: text(args[0]) })))
    const availability = guard(() => load('src/main/path/startupPathAvailabilityRuntime.ts'))
    if (availability) {
      patch(availability, 'ensureStartupPathRootAvailable', original => wrap(original, 'availability', args => ({ kind: 'availability', rootId: text(args[0], 512), label: text(args[2]) })))
      patch(availability, 'getStartupPathRootState', original => function (...args) {
        const result = Reflect.apply(original, this, args)
        if (!stopped) guard(() => observeRoot(result))
        return result
      })
    }
  }
  function wrapAdmission(original, metadata = {}) {
    if (typeof original !== 'function') return original
    return function (...args) {
      if (stopped) return Reflect.apply(original, this, args)
      const row = guard(() => add('admissions', { label: text(metadata.label), command: text(metadata.command), requestOrdinal: number(metadata.requestOrdinal), rootRevisionBefore: rootRevision }))
      let result
      try { result = Reflect.apply(original, this, args) }
      catch (error) { guard(() => { if (row) { row.finishedAt = now(); row.outcome = 'threw'; row.error = errorSummary(error); row.rootRevisionAfter = rootRevision } }); throw error }
      guard(() => { if (row) { row.finishedAt = now(); row.result = typeof result === 'boolean' ? result : undefined; row.outcome = 'returned'; row.rootRevisionAfter = rootRevision } })
      return result
    }
  }
  function recordProjection(input) {
    if (stopped) return
    guard(() => {
      const value = typeof input === 'function' ? input() : input
      const detail = { label: text(value.label), startedAt: number(value.startedAt), finishedAt: number(value.finishedAt), expected: counts(value.expected),
        rawSql: counts(value.rawSql), independentSql: counts(value.independentSql), pages: counts(value.pages), metrics: counts(value.metrics),
        rawSqlScope: text(value.rawSqlScope), independentSqlScope: text(value.independentSqlScope), nativeScope: text(value.nativeScope), nativeIntervalScope: text(value.nativeIntervalScope),
        nativeCount: number(value.nativeCount), nativeOverflow: number(value.nativeOverflow), nativeIntervalCount: number(value.nativeIntervalCount), nativeIntervalOverflow: number(value.nativeIntervalOverflow) }
      if (value.error) detail.error = errorSummary(value.error)
      for (const field of ['native', 'nativeInterval']) if (Array.isArray(value[field])) {
        detail[field] = value[field].slice(0, 32).map(item => ({ ...counts(item), inputCategory: counts(item.inputCategory), context: counts(item.context) }))
        if (value[field].length > 32) dropped.projections += value[field].length - 32
      }
      add('projections', detail)
    })
  }
  function setStage(next) {
    if (stopped || next === stage) return
    guard(() => { add('stages', { label: stage, finishedAt: now(), system: systemView() }); histogram?.reset() })
    stage = text(next) || 'unknown'
  }
  function restore() {
    if (stopped) return
    setStage('restored'); stopped = true
    for (const saved of patches.reverse()) guard(() => {
      if (saved.module[saved.key] !== saved.wrapped) { restorationConflicts++; return }
      saved.module[saved.key] = saved.original
    })
    guard(() => { if (histogram) { histogram.disable(); histogramDisabled = true } })
  }
  guard(() => { histogram = perfHooks.monitorEventLoopDelay({ resolution: 20 }); histogram.enable(); histogramEnabled = true })
  return { installSelectedSource, setStage, wrapAdmission, recordProjection, restore, noteError: () => { observerErrors++ },
    snapshot: () => guard(() => ({ version: 1, stage, stopped, hooks: [...hooks], limits: { ...limits }, dropped: { ...dropped }, observerErrors, restorationConflicts, lateCompletions, histogramEnabled, histogramDisabled,
      bookkeepingMs, bookkeepingScope: 'Guarded observation sections only; excludes wrapper/AsyncLocalStorage overhead and does not estimate total observer cost.', timingScope: 'Bookkeeping is included in original workload times; never subtracted. CPU/ELU span concurrent process work.',
      histogramScope: 'One native 20ms sampler per case/global stage; scoped validation may overlap timed work.',
      rows, lastObservedRoots: [...rootStates].map(([rootId, value]) => ({ rootId: text(rootId, 512), ...value })),
      system: guard(systemView) })) }
}
module.exports = { createFullRefreshObservation }
