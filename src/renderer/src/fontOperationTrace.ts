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
