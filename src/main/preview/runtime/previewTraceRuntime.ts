import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash, randomUUID } from 'node:crypto'
import { logOperation, currentOperationTrace } from '../../logging/operationTraceContext'
import type { FontItem } from '../../../shared/types'
import type { PreviewFailureKind } from '../../../shared/previewFailure'
import { nativePreviewLayoutKey, type NativePreviewLayout } from '../../../shared/preview-layout/nativePreviewLayout'

// Default-log evidence for otherwise indistinguishable native output keys. This
// observer owns no cache/admission authority and retains no source strings/bytes.
let reuseSession = 'unobserved'
try { reuseSession = randomUUID().slice(0, 8) } catch { /* Diagnostics need no entropy authority. */ }
const REUSE_WINDOW_MS = 60000, REUSE_WINDOW_LINES = 256, REUSE_SESSION_LINES = 2048
let reuseOwner = 0, reuseWindowAt: number | undefined, reuseWindowLines = 0, reuseSessionLines = 0, reuseDropped = 0
const finiteNext = (value: number) => Math.min(Number.MAX_SAFE_INTEGER, value + 1)
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value) ?? 'null').digest('hex').slice(0, 20)
type ReuseContext = { owner: number; request: number; requestKey: string; nativeKey?: string; outputKey?: string }
type ReuseDetail = Record<string, string | number | boolean | undefined>

export function createPreviewReuseObserver(appendLog: (message: string) => void) {
  const owner = reuseOwner = finiteNext(reuseOwner)
  const scope = new AsyncLocalStorage<ReuseContext>()
  const owners = new WeakMap<Promise<unknown>, ReuseContext>()
  let sequence = 0

  function emit(context: ReuseContext, event: string, detail: ReuseDetail | (() => ReuseDetail) = {}): void {
    try {
      const now = Date.now()
      if (reuseWindowAt === undefined || now - reuseWindowAt >= REUSE_WINDOW_MS || now < reuseWindowAt) { reuseWindowAt = now; reuseWindowLines = 0 }
      if (reuseWindowLines >= REUSE_WINDOW_LINES || reuseSessionLines >= REUSE_SESSION_LINES) { reuseDropped = finiteNext(reuseDropped); return }
      const cap = reuseWindowLines === REUSE_WINDOW_LINES - 1 || reuseSessionLines === REUSE_SESSION_LINES - 1
      // Suppressed/cap rows must not hash source fields or read optional metadata.
      const fields = cap ? undefined : typeof detail === 'function' ? detail() : detail
      const row = cap ? { session: reuseSession, event: 'observation-cap', scope: reuseSessionLines === REUSE_SESSION_LINES - 1 ? 'session' : 'window' }
        : { session: reuseSession, ...context, event, ...fields, ...(reuseDropped ? { suppressed: reuseDropped } : {}) }
      reuseWindowLines++; reuseSessionLines++; reuseDropped = cap ? finiteNext(reuseDropped) : 0
      appendLog(`preview reuse: ${JSON.stringify(row)}`)
    } catch { /* Observation must never change preview settlement. */ }
  }

  function admit(input: { requestKey: string; item: FontItem; text: string; fontSize: number; width: number; height: number; layout?: NativePreviewLayout;
    memory: boolean; legacyMissing: boolean; existing?: Promise<string> }): ReuseContext {
    const context: ReuseContext = { owner, request: sequence = finiteNext(sequence), requestKey: 'unobserved' }
    try {
      emit(context, 'request', () => {
        context.requestKey = digest(input.requestKey)
        const joined = input.existing ? owners.get(input.existing) : undefined
        const trace = currentOperationTrace()
        return {
          decision: input.memory && !input.legacyMissing ? 'memory-hit' : input.existing ? 'inflight-join' : input.memory ? 'legacy-bypass' : 'new-work',
          memory: input.memory, legacyMissing: input.legacyMissing,
          joinedOwner: joined?.owner, joinedRequest: joined?.request,
          idKey: digest(input.item.id), pathKey: digest(input.item.path),
          foldedPathKey: digest(String(input.item.path || '').replaceAll('\\', '/').toLowerCase()),
          stampKey: digest([input.item.fileSize || 0, input.item.modifiedAt || 0]),
          recoveryPresent: !!input.item.recoveryContentHash, recoveryKey: digest(input.item.recoveryContentHash || ''),
          layoutKey: digest([input.text, input.fontSize, input.width, input.height, nativePreviewLayoutKey(input.layout)]),
          operationKey: trace ? digest(trace.operationId) : undefined, attemptKey: trace ? digest(trace.attemptId) : undefined,
        }
      })
    } catch { /* Untrusted optional metadata cannot invalidate a usable image. */ }
    return context
  }

  function native(renderKey: string, cacheKey: string, route: 'file' | 'system', existing?: Promise<unknown>): void {
    try {
      const context = scope.getStore()
      if (!context) return
      emit(context, existing ? 'native-join' : 'native-start', () => {
        context.nativeKey = /^[a-f0-9]{40,64}$/i.test(cacheKey) ? cacheKey.toLowerCase() : digest(cacheKey)
        context.outputKey = digest(renderKey)
        const joined = existing ? owners.get(existing) : undefined
        return { route, joinedOwner: joined?.owner, joinedRequest: joined?.request }
      })
    } catch { /* Observation cannot reject a native owner. */ }
  }

  function track(task: Promise<unknown>, context?: ReuseContext): void { try { context ||= scope.getStore(); if (context) owners.set(task, context) } catch { /* Never change the tracked task. */ } }
  function remember(transient: boolean): void { try { const context = scope.getStore(); if (context) emit(context, 'memory-stored', { transient }) } catch { /* Never change a remembered image. */ } }
  function settled(context: ReuseContext, outcome: 'fulfilled' | 'rejected', failure?: PreviewFailureKind): void { emit(context, 'settled', { outcome, failure, retired: true }) }
  function run<T>(context: ReuseContext, operation: () => T): T {
    let started = false, returned = false, result: T
    try { return scope.run(context, () => { started = true; result = operation(); returned = true; return result }) }
    catch (error) { if (returned) return result!; if (started) throw error; return operation() }
  }
  return { admit, native, track, remember, settled, run }
}

// Observe the existing async operation; do not introduce deadlines or catch-and-fallback.
export async function tracePreviewPhase<T>(stage: string, operation: () => Promise<T>): Promise<T> {
  const startedAt = performance.now()
  logOperation({ stage: `${stage}-start`, backend: 'main' })
  try {
    const result = await operation()
    logOperation({ stage: `${stage}-end`, outcome: 'returned', elapsedMs: performance.now() - startedAt, backend: 'main' })
    return result
  } catch (error) {
    logOperation({ stage: `${stage}-end`, outcome: 'rejected', elapsedMs: performance.now() - startedAt, backend: 'main' })
    throw error
  }
}
