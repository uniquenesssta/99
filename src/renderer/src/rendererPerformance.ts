import { rendererMemoryInfo } from './rendererMemory'

export type RendererPerformanceSeverity = 'info' | 'slow' | 'warn' | 'error'
export type RendererPerformanceEventPayload = {
  source?: string
  kind?: string
  label?: string
  severity?: RendererPerformanceSeverity | string
  durationMs?: number
  timestamp?: number
  page?: string
  details?: Record<string, unknown>
}

export const RENDERER_TRACE_SYNC_THRESHOLD_MS = 8
export const RENDERER_TRACE_WARN_THRESHOLD_MS = 32
export const RENDERER_TRACE_THROTTLE_MS = 260
export const rendererTraceLastAt = new Map<string, number>()

export function safeRendererTraceValue(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value
  if (typeof value === 'string') return value.length > 160 ? `${value.slice(0, 160)}…` : value
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (Array.isArray(value)) return { type: 'array', length: value.length }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(record).slice(0, 12)) {
      out[key] = depth >= 1 ? (Array.isArray(record[key]) ? { type: 'array', length: (record[key] as unknown[]).length } : typeof record[key] === 'object' ? '[object]' : safeRendererTraceValue(record[key], depth + 1)) : safeRendererTraceValue(record[key], depth + 1)
    }
    return out
  }
  return typeof value
}

export function reportRendererTrace(payload: RendererPerformanceEventPayload, throttleKey?: string): void {
  if (typeof window === 'undefined' || !window.hfm || typeof window.hfm.reportPerformanceEvent !== 'function') return
  const now = performance.now()
  if (throttleKey) {
    const last = rendererTraceLastAt.get(throttleKey) || 0
    if (now - last < RENDERER_TRACE_THROTTLE_MS) return
    rendererTraceLastAt.set(throttleKey, now)
  }
  const memory = rendererMemoryInfo()
  void window.hfm.reportPerformanceEvent({
    source: 'renderer',
    severity: payload.severity || ((payload.durationMs || 0) >= RENDERER_TRACE_WARN_THRESHOLD_MS ? 'warn' : (payload.durationMs || 0) >= RENDERER_TRACE_SYNC_THRESHOLD_MS ? 'slow' : 'info'),
    timestamp: Date.now(),
    ...payload,
    details: {
      ...(safeRendererTraceValue(payload.details || {}) as Record<string, unknown>),
      heapUsedMb: memory.usedJSHeapSize ? Math.round(memory.usedJSHeapSize / 1024 / 1024) : undefined,
      heapTotalMb: memory.totalJSHeapSize ? Math.round(memory.totalJSHeapSize / 1024 / 1024) : undefined
    }
  }).catch(() => undefined)
}

export function traceRendererSyncComputation<T>(label: string, details: Record<string, unknown>, fn: () => T, page?: string, thresholdMs = RENDERER_TRACE_SYNC_THRESHOLD_MS): T {
  const startedAt = performance.now()
  const result = fn()
  const durationMs = Math.round((performance.now() - startedAt) * 10) / 10
  if (durationMs >= thresholdMs) {
    reportRendererTrace({
      kind: 'sync-computation',
      label,
      page,
      durationMs,
      details
    }, `sync:${label}:${page || ''}`)
  }
  return result
}
