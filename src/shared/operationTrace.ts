// Diagnostic transport only: never a persistence, authorization or dedupe key.
export interface OperationTrace {
  version: 1
  sessionId: string
  operationId: string
  attemptId: string
  batchId: string
  domain: string
  members: string[]
  omitted: number
  spanId?: string
  commitSequence?: number
  target?: string
  rendererGeneration?: number
}

export const OPERATION_TRACE_MAX_BYTES = 8192
export const OPERATION_TRACE_MAX_MEMBERS = 16
const token = (value: unknown): string => typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,96}$/.test(value) ? value : ''

export function cleanOperationTrace(value: unknown): OperationTrace | undefined {
  try {
    if (!value || typeof value !== 'object') return undefined
    const v = value as Partial<OperationTrace>
    if (v.version !== 1 || !token(v.sessionId) || !token(v.operationId) || !token(v.attemptId) || !token(v.batchId) || !token(v.domain)) return undefined
    const members = Array.isArray(v.members) ? v.members : []
    const cleanedMembers = members.slice(0, OPERATION_TRACE_MAX_MEMBERS).map(token).filter(Boolean)
    return {
      version: 1, sessionId: token(v.sessionId), operationId: token(v.operationId),
      ...(token(v.target) ? { target: token(v.target) } : {}),
      ...(Number.isSafeInteger(v.rendererGeneration) ? { rendererGeneration: v.rendererGeneration } : {}),
      attemptId: token(v.attemptId), batchId: token(v.batchId), domain: token(v.domain),
      members: cleanedMembers,
      omitted: Math.max(0, Math.min(1e9, Number(v.omitted) || 0)) + Math.max(0, members.length - cleanedMembers.length),
      ...(token(v.spanId) ? { spanId: token(v.spanId) } : {}),
      ...(Number.isSafeInteger(v.commitSequence) && Number(v.commitSequence) > 0 ? { commitSequence: v.commitSequence } : {})
    }
  } catch { return undefined }
}

export interface OperationTraceEvent {
  trace?: OperationTrace
  stage: string
  outcome?: string
  reason?: string
  backend?: string
  transport?: string
  localRevision?: number
  sharedRevision?: number
  dropped?: number
  backendSequence?: number
  elapsedMs?: number
  monotonicMs?: number
  timestamp?: number
  jobId?: string
}

export function encodeOperationTraceEvent(event: OperationTraceEvent): string {
  try {
    // Whitelist scalar fields; never traverse business objects or stringify caller toJSON.
    const text = JSON.stringify({
      trace: cleanOperationTrace(event.trace), linked: Boolean(cleanOperationTrace(event.trace)),
      stage: token(event.stage), outcome: token(event.outcome), reason: token(event.reason),
      backend: token(event.backend), transport: token(event.transport),
      localRevision: Number.isFinite(event.localRevision) ? event.localRevision : undefined,
      sharedRevision: Number.isFinite(event.sharedRevision) ? event.sharedRevision : undefined,
      timestamp: Number.isFinite(event.timestamp) ? event.timestamp : Date.now(),
      elapsedMs: Number.isFinite(event.elapsedMs) ? event.elapsedMs : undefined,
      monotonicMs: Number.isFinite(event.monotonicMs) ? event.monotonicMs : undefined,
      backendSequence: Number.isSafeInteger(event.backendSequence) ? event.backendSequence : undefined,
      jobId: token(event.jobId),
      dropped: Math.max(0, Number(event.dropped) || 0)
    })
    return text.length <= OPERATION_TRACE_MAX_BYTES ? text : '' // All permitted text is ASCII.
  } catch { return '' }
}
