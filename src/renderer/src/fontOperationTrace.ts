import { cleanOperationTrace, encodeOperationTraceEvent, type OperationTrace, type OperationTraceEvent } from '../../shared/operationTrace'

// Weak keys follow the existing queue entry lifetime; no second domain queue/store.
const identities = new WeakMap<object, OperationTrace>()
let sequence = 0
const sessionId = `renderer-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
let inFlight = 0
let dropped = 0
function targetDigest(entry: object): string {
  const value = entry as { item?: { id?: string }; font?: { id?: string } }
  const id = value.item?.id || value.font?.id || ''
  let hash = 2166136261
  for (let i = 0; i < id.length; i++) hash = Math.imul(hash ^ id.charCodeAt(i), 16777619)
  return `id-${(hash >>> 0).toString(16)}:${id.length}`
}
const nextId = (): string => `${sessionId}:${++sequence}`

export function reportFontOperation(event: OperationTraceEvent): void {
  let reserved = false
  try {
    if (typeof window === 'undefined' || typeof window.hfm?.reportPerformanceEvent !== 'function') return
    if (inFlight >= 256) { dropped++; return }
    const encoded = encodeOperationTraceEvent({ ...event, dropped })
    if (!encoded) { dropped++; return }
    dropped = 0
    inFlight++
    reserved = true
    Promise.resolve(window.hfm.reportPerformanceEvent({ kind: 'operation-chain', details: { event: encoded } }))
      .catch(() => { dropped++ }).finally(() => { inFlight-- })
  } catch { if (reserved) inFlight--; dropped++ }
}

export function trackFontWrite<T extends object>(entry: T, domain: string, previous?: object): T {
  const old = previous && identities.get(previous)
  if (old) reportFontOperation({ trace: old, stage: 'cancel', reason: 'superseded-before-dispatch' })
  const id = nextId()
  const trace: OperationTrace = { version: 1, sessionId, operationId: id, attemptId: id, batchId: id, domain, target: targetDigest(entry), rendererGeneration: sequence, members: [id], omitted: 0 }
  identities.set(entry, trace)
  reportFontOperation({ trace, stage: 'queued' })
  return entry
}

export function dispatchFontWrites(entries: object[]): OperationTrace | undefined {
  const traces = entries.map(entry => identities.get(entry)).filter((trace): trace is OperationTrace => Boolean(trace))
  if (!traces.length) return undefined // Legacy callers have no renderer intent evidence.
  const batchId = nextId()
  const attemptId = nextId()
  for (const entry of entries) {
    const previous = identities.get(entry)
    if (!previous) continue
    const trace = { ...previous, batchId, attemptId }
    identities.set(entry, trace)
    reportFontOperation({ trace, stage: 'dispatch' })
  }
  return cleanOperationTrace({ ...traces[0], operationId: batchId, batchId, attemptId, members: traces.map(trace => trace.operationId), omitted: entries.length - traces.length })
}

export function settleFontWrites<T extends object>(entries: T[], failed: Set<string>, idOf: (entry: T) => string): void {
  for (const entry of entries) {
    const trace = identities.get(entry)
    if (trace) reportFontOperation({ trace, stage: failed.has(idOf(entry)) ? 'retry' : 'queue-settled', outcome: failed.has(idOf(entry)) ? 'unconfirmed' : 'acknowledged' })
  }
}

export function cancelFontWrite(entry: object, reason: string): void {
  const trace = identities.get(entry)
  if (trace) reportFontOperation({ trace, stage: 'cancel', reason })
}

export function fontWriteTrace(entry: object): OperationTrace | undefined {
  return identities.get(entry)
}

export function createFontOperationTrace(domain: string): OperationTrace {
  const id = nextId()
  return { version: 1, sessionId, operationId: id, attemptId: nextId(), batchId: id, domain, members: [id], omitted: 0 }
}

export async function traceDirectFontOperation<T>(domain: string, run: (trace: OperationTrace) => Promise<T>): Promise<T> {
  const id = nextId()
  const trace: OperationTrace = { version: 1, sessionId, operationId: id, attemptId: nextId(), batchId: id, domain, members: [id], omitted: 0 }
  reportFontOperation({ trace, stage: 'intent' })
  reportFontOperation({ trace, stage: 'dispatch' })
  try {
    const result = await run(trace)
    reportFontOperation({ trace, stage: 'operation-result', outcome: 'returned' })
    return result
  } catch (error) {
    reportFontOperation({ trace, stage: 'operation-result', outcome: 'unknown', reason: 'direct-operation-rejected' })
    throw error
  }
}


// Recovery refresh evidence follows the existing query sequence owner. These
// weak associations never choose data, invalidate queries, or affect acceptance.
type PageSequence = { current: number }
type PageObservation = { trace: OperationTrace; owner: PageSequence; sequence: number; scope: string; started: number; request?: number; accepted?: object }
let refreshTrace: OperationTrace | undefined
const pageScopes = new WeakMap<PageSequence, string>()
const pageObservations = new WeakMap<PageSequence, PageObservation>()
const acceptedPages = new WeakMap<object, PageObservation>()
export function withFontRefreshTrace<T>(trace: OperationTrace, refresh: () => T): T {
  const previous = refreshTrace; refreshTrace = trace
  try { return refresh() } finally { refreshTrace = previous }
}
export function cancelFontRefreshObservation(owner: PageSequence, reason: string, expected?: PageObservation): void {
  const observation = pageObservations.get(owner)
  if (!observation || expected && expected !== observation) return
  pageObservations.delete(owner)
  if (observation.accepted) acceptedPages.delete(observation.accepted)
  reportFontOperation({ trace: observation.trace, stage: 'page-observation-ended', outcome: 'unobserved', reason, elapsedMs: performance.now() - observation.started })
}
export function noteFontRefreshRequest(owner: PageSequence, endedReason?: string): void {
  cancelFontRefreshObservation(owner, endedReason || 'superseded-refresh')
  if (!refreshTrace) return
  if (endedReason) { reportFontOperation({ trace: refreshTrace, stage: 'page-observation-ended', outcome: 'unobserved', reason: endedReason }); return }
  const scope = pageScopes.get(owner)
  if (!scope) { reportFontOperation({ trace: refreshTrace, stage: 'page-observation-ended', outcome: 'unobserved', reason: 'no-query' }); return }
  pageObservations.set(owner, { trace: refreshTrace, owner, scope, sequence: owner.current, started: performance.now() })
  reportFontOperation({ trace: refreshTrace, stage: 'page-refresh-requested' })
}
export function noteFontQueryScope(owner: PageSequence, scope?: string): void {
  const observation = pageObservations.get(owner)
  if (observation && observation.scope !== scope) cancelFontRefreshObservation(owner, scope ? 'view-scope-changed' : 'no-query')
  if (scope) pageScopes.set(owner, scope)
  else pageScopes.delete(owner)
}
export function bindFontRefreshQuery(owner: PageSequence, request: number, scope: string): PageObservation | undefined {
  const observation = pageObservations.get(owner)
  if (!observation) return undefined
  if (observation.request !== undefined || observation.sequence + 1 !== request || observation.scope !== scope) {
    cancelFontRefreshObservation(owner, 'superseded-request'); return undefined
  }
  observation.request = request
  return observation
}
export function dispatchFontRefreshQuery(observation?: PageObservation): void {
  if (observation && pageObservations.get(observation.owner) === observation)
    reportFontOperation({ trace: observation.trace, stage: 'page-query-dispatched', queuedMs: performance.now() - observation.started })
}
export function finishFontRefreshQuery(observation: PageObservation | undefined, result?: object, reason = 'query-rejected'): void {
  if (!observation || pageObservations.get(observation.owner) !== observation) return
  if (!result || observation.owner.current !== observation.request) { cancelFontRefreshObservation(observation.owner, reason, observation); return }
  observation.accepted = result; acceptedPages.set(result, observation)
  reportFontOperation({ trace: observation.trace, stage: 'page-query-accepted', elapsedMs: performance.now() - observation.started })
}
export function observeFontRefreshPage(result: object | null | undefined, ready: boolean): void {
  const observation = result && acceptedPages.get(result)
  if (!observation || pageObservations.get(observation.owner) !== observation) return
  if (!ready || observation.owner.current !== observation.request) { cancelFontRefreshObservation(observation.owner, 'view-not-current', observation); return }
  acceptedPages.delete(result!); pageObservations.delete(observation.owner)
  reportFontOperation({ trace: observation.trace, stage: 'page-view-observed', outcome: 'observed', reason: 'react-commit-observation', elapsedMs: performance.now() - observation.started })
}
