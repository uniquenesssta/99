import { randomUUID } from 'node:crypto'
import type { OperationTrace, OperationTraceEvent } from '../../shared/operationTrace'
import { currentOperationTrace, logOperation, withOperationTrace } from './operationTraceContext'
import { detailedStartupLogsEnabled } from './startupLogPolicy'

const channels = new Set(['fonts:renderPreviewImage', 'fonts:getCachedPreviewImage', 'fonts:getCachedPreviewImages'])
let sessionId: string | undefined

// Opt-in diagnostics only. IDs never participate in cache keys or admission.
export function createPreviewBaselineTrace(channel: string): OperationTrace | undefined {
  if (process.env.HFM_PREVIEW_BASELINE !== '1' || !detailedStartupLogsEnabled() || !channels.has(channel)) return undefined
  const operationId = randomUUID()
  return { version: 1, sessionId: sessionId ||= randomUUID(), operationId, attemptId: operationId,
    batchId: operationId, domain: 'preview-baseline', members: [], omitted: 0 }
}

export function previewBaselineEvent(stage: string, event: Omit<OperationTraceEvent, 'stage' | 'trace'> = {}): void {
  if (currentOperationTrace()?.domain === 'preview-baseline') logOperation({ ...event, stage })
}

// A queued callback may execute in the scope of the previous request's completion.
export function bindPreviewBaseline<T>(run: () => Promise<T>, append: (message: string) => void): () => Promise<T> {
  const trace = currentOperationTrace()
  return trace?.domain === 'preview-baseline' ? () => withOperationTrace(trace, append, run) : run
}

export function measurePreviewBaseline<T>(stage: string, run: () => T | Promise<T>, reason?: string): T | Promise<T> {
  if (currentOperationTrace()?.domain !== 'preview-baseline') return run()
  return (async () => {
    const start = performance.now()
    previewBaselineEvent(`${stage}-start`, { reason })
    try {
      const value = await run()
      previewBaselineEvent(`${stage}-result`, { outcome: 'returned', reason, elapsedMs: performance.now() - start })
      return value
    } catch (error) {
      previewBaselineEvent(`${stage}-result`, { outcome: 'rejected', reason, elapsedMs: performance.now() - start })
      throw error
    }
  })()
}
