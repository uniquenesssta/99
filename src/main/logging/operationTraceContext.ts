import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { cleanOperationTrace, encodeOperationTraceEvent, type OperationTrace, type OperationTraceEvent } from '../../shared/operationTrace'
import { detailedStartupLogsEnabled } from './startupLogPolicy'

type TraceScope = { trace?: OperationTrace; append?: (message: string) => void }
const scope = new AsyncLocalStorage<TraceScope>()
let bytes = 0
let dropped = 0
const MAX_SESSION_BYTES = 16 * 1024 * 1024
const TAG_DELETE_STAGES = new Set(['tag-delete-intent', 'tag-delete-wait', 'tag-delete-blocked', 'tag-delete-dispatch', 'tag-delete-result'])

export function currentOperationTrace(): OperationTrace | undefined { return scope.getStore()?.trace }
export function withOperationTrace<T>(trace: unknown, append: TraceScope['append'], run: () => T): T {
  return scope.run({ trace: cleanOperationTrace(trace), append }, run)
}
export function logOperation(event: OperationTraceEvent, append = scope.getStore()?.append): void {
  try {
    if (!append) return
    const trace = cleanOperationTrace(Object.hasOwn(event, 'trace') ? event.trace : currentOperationTrace())
    // User-confirmed catalog deletion is auditable in normal startup logs too.
    // Keep generic high-volume operation tracing behind the existing debug gate.
    const tagDelete = (trace?.domain === 'localTags' || trace?.domain === 'sharedTags') && TAG_DELETE_STAGES.has(event.stage)
    if (!tagDelete && !detailedStartupLogsEnabled()) return
    const encoded = encodeOperationTraceEvent({ ...event, trace, dropped })
    if (!encoded) { dropped++; return }
    if (bytes + encoded.length > MAX_SESSION_BYTES) {
      dropped++
      if ((dropped & (dropped - 1)) === 0) append(`operation-chain: {"stage":"log-capacity","dropped":${dropped},"reason":"session-limit"}`)
      return
    }
    append(`operation-chain: ${encoded}`)
    bytes += encoded.length
    dropped = 0
  } catch { dropped++ }
}
export function traceRustInput(value: unknown): unknown {
  const trace = currentOperationTrace()
  if (!trace || !value || typeof value !== 'object' || Array.isArray(value)) return value
  try { return { ...value, trace: { ...trace, spanId: randomUUID() } } } catch { return value }
}


// Bounded operation evidence is collected before log filtering. It never grants
// authority, caches a read, or changes task admission/settlement.
type WorkCounts = { tasks: number; processStarts: number; processCloses: number; reads: number; sourceBytes: number; hashedBytes: number; cacheBytes: number; transferBytes: number; renders: number; timeouts: number }
type WorkEvidence = { operationId: string; domain: string; counts: WorkCounts; waits: number[]; waitCount: number; waitMaxMs: number; executionMs: number; phases: Record<string, { count: number; elapsedMs: number }> }
const workScope = new AsyncLocalStorage<WorkEvidence>()
export function recordOperationWork(values: Partial<WorkCounts> & { queuedMs?: number; executionMs?: number }): void {
  const work = workScope.getStore()
  if (!work) return
  for (const name of Object.keys(work.counts) as Array<keyof WorkCounts>) {
    const value = values[name]
    if (Number.isFinite(value) && value! >= 0) work.counts[name] += value!
  }
  if (Number.isFinite(values.queuedMs) && values.queuedMs! >= 0) {
    work.waitCount++; work.waitMaxMs = Math.max(work.waitMaxMs, values.queuedMs!)
    if (work.waits.length < 512) work.waits.push(values.queuedMs!)
  }
  if (Number.isFinite(values.executionMs) && values.executionMs! >= 0) work.executionMs += values.executionMs!
}
export async function measureOperationPhase<T>(phase: string, run: () => Promise<T>): Promise<T> {
  const work = workScope.getStore(), start = performance.now()
  try { return await run() }
  finally {
    if (work && (Object.hasOwn(work.phases, phase) || Object.keys(work.phases).length < 24)) {
      const entry = work.phases[phase] ||= { count: 0, elapsedMs: 0 }
      entry.count++; entry.elapsedMs += performance.now() - start
    }
  }
}
export function operationWorkSnapshot() {
  const work = workScope.getStore()
  if (!work) return undefined
  const waits = [...work.waits].sort((a, b) => a - b)
  return { operationId: work.operationId, domain: work.domain, ...work.counts, executionMs: work.executionMs,
    pendingProcessCloses: Math.max(0, work.counts.processStarts - work.counts.processCloses),
    queueWait: { scope: 'operation tasks across observed global/shared layers', count: work.waitCount, sampled: waits.length, truncated: work.waitCount > waits.length,
      p95Ms: waits.length ? waits[Math.ceil(waits.length * .95) - 1] : 0, maxMs: work.waitMaxMs }, phases: { ...work.phases } }
}
export async function withOperationWork<T>(domain: string, append: ((message: string) => void) | undefined, run: () => Promise<T>): Promise<T> {
  const prior = currentOperationTrace(), id = prior?.operationId || randomUUID(), start = performance.now()
  const trace = prior || { version: 1 as const, sessionId: 'main', operationId: id, attemptId: id, batchId: id, domain, members: [id], omitted: 0 }
  const work: WorkEvidence = { operationId: id, domain, counts: { tasks: 0, processStarts: 0, processCloses: 0, reads: 0, sourceBytes: 0, hashedBytes: 0, cacheBytes: 0, transferBytes: 0, renders: 0, timeouts: 0 }, waits: [], waitCount: 0, waitMaxMs: 0, executionMs: 0, phases: {} }
  return workScope.run(work, () => withOperationTrace(trace, append, async () => {
    let outcome = 'returned', resultCounts: Record<string, number | boolean> = {}
    try {
      const result = await run()
      if (result && typeof result === 'object') {
        const value = result as Record<string, unknown>
        for (const name of ['ok', 'linked', 'remaining', 'canceled', 'busy']) if (typeof value[name] === 'boolean' || typeof value[name] === 'number') resultCounts[name] = value[name] as number | boolean
        if (Array.isArray(value.failures)) resultCounts.failures = value.failures.length
        if (value.ok === false || Array.isArray(value.failures) && value.failures.length) outcome = 'partial'
      }
      return result
    }
    catch (error) { outcome = 'failed'; throw error }
    finally {
      const evidence = operationWorkSnapshot()
      try { append?.(`operation work: ${JSON.stringify({ ...evidence, outcome, result: resultCounts, taskScope: 'global/shared scheduler admissions', elapsedMs: performance.now() - start, byteScope: 'successful logical source/cache read bytes including native hashing; failed/cancelled partial bytes unknown; hashedBytes is a subset; transferBytes separate; excludes physical I/O, SQLite and rendering internals' })}`) } catch { /* Logging is never an execution gate. */ }
    }
  }))
}
