import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { cleanOperationTrace, encodeOperationTraceEvent, type OperationTrace, type OperationTraceEvent } from '../../shared/operationTrace'
import { detailedStartupLogsEnabled } from './startupLogPolicy'

type TraceScope = { trace?: OperationTrace; append?: (message: string) => void }
const scope = new AsyncLocalStorage<TraceScope>()
let bytes = 0
let dropped = 0
const MAX_SESSION_BYTES = 16 * 1024 * 1024

export function currentOperationTrace(): OperationTrace | undefined { return scope.getStore()?.trace }
export function withOperationTrace<T>(trace: unknown, append: TraceScope['append'], run: () => T): T {
  return scope.run({ trace: cleanOperationTrace(trace), append }, run)
}
export function logOperation(event: OperationTraceEvent, append = scope.getStore()?.append): void {
  try {
    if (!append || !detailedStartupLogsEnabled()) return
    const encoded = encodeOperationTraceEvent({ ...event, trace: Object.hasOwn(event, 'trace') ? event.trace : currentOperationTrace(), dropped })
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
