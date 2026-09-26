import type { OperationTrace } from '@shared/operationTrace'
import { normalizePreviewText } from '@shared/preview-layout/previewTextFitRuntime'
import { createFontOperationTrace, reportFontOperation } from '../../fontOperationTrace'

// Diagnostic state only. Never used for queue admission, authorization or cache identity.
const traces = new Map<string, OperationTrace>()
const images: Array<{ image: string; fontId: string; trace: OperationTrace }> = []
const queuedAt = new Map<string, number>()
let generation = 0
const LIMIT = 512
function remember<K, V>(map: Map<K, V>, key: K, value: V): void {
  map.set(key, value)
  while (map.size > LIMIT) map.delete(map.keys().next().value!)
}
export function previewTraceEnabled(): boolean {
  return typeof window !== 'undefined' && window.hfm?.previewTraceEnabled === true
}
export function resetPreviewTrace(): void {
  generation++
  traces.clear()
  queuedAt.clear()
}
export function previewTrace(fontId: string, text: string, size: number): OperationTrace | undefined {
  if (!previewTraceEnabled()) return undefined
  const key = JSON.stringify([fontId, normalizePreviewText(text), size])
  const existing = traces.get(key)
  if (existing) return existing
  const trace = createFontOperationTrace('preview')
  let digest = 2166136261
  for (let i = 0; i < fontId.length; i++) digest = Math.imul(digest ^ fontId.charCodeAt(i), 16777619)
  trace.target = `font-${(digest >>> 0).toString(16)}`
  trace.rendererGeneration = generation
  remember(traces, key, trace)
  return trace
}
export function previewEvent(trace: OperationTrace | undefined, stage: string, outcome?: string, startedAt?: number): void {
  if (!trace || !previewTraceEnabled()) return
  if (stage === 'queued') remember(queuedAt, trace.operationId, performance.now())
  if (stage === 'load-start' && startedAt === undefined) startedAt = queuedAt.get(trace.operationId)
  reportFontOperation({ trace, stage, outcome, backend: 'renderer', monotonicMs: performance.now(), ...(startedAt === undefined ? {} : { elapsedMs: performance.now() - startedAt }) })
}
export function rememberPreviewImageTrace(image: string, trace: OperationTrace | undefined, fontId = ''): void {
  if (!trace || !previewTraceEnabled()) return
  previewEvent(trace, 'image-classified', image.startsWith('data:image/svg+xml') ? 'placeholder' : 'image')
  const index = images.findIndex(entry => entry.image === image && entry.fontId === fontId)
  if (index >= 0) images.splice(index, 1)
  images.push({ image, fontId, trace })
  if (images.length > LIMIT) images.shift()
}
export function previewBatchTrace(members: Array<OperationTrace | undefined>): OperationTrace | undefined {
  const live = members.filter((trace): trace is OperationTrace => Boolean(trace))
  if (!live.length) return undefined
  const batch = createFontOperationTrace('preview')
  batch.members = live.slice(0, 16).map(trace => trace.operationId)
  batch.omitted = Math.max(0, live.length - 16)
  for (const trace of live) reportFontOperation({ trace: { ...trace, batchId: batch.batchId }, stage: 'cache-batch-member' })
  return batch
}

export function previewImageTrace(image: string | undefined, fontId = ''): OperationTrace | undefined {
  return image ? images.find(entry => entry.image === image && entry.fontId === fontId)?.trace : undefined
}

export function previewLoadTrace(fontId: string, text: string, size: number): OperationTrace | undefined {
  const trace = previewTrace(fontId, text, size)
  return trace ? { ...trace, attemptId: createFontOperationTrace('preview').attemptId } : undefined
}
