import { logOperation, withOperationTrace } from './operationTraceContext'

const sessionId = `preview-${process.pid}-${Date.now().toString(36)}`
let sequence = 0

// A system mutation starts here; this is not a renderer/user-intent receipt.
export function tracePreviewCacheMutation<T>(label: string, append: (message: string) => void, run: () => Promise<T>): Promise<T> {
  if (label !== 'apply' && label !== 'delete') return run()
  const operationId = `preview-${++sequence}`
  return withOperationTrace({ version: 1, sessionId, operationId, attemptId: `${operationId}-1`, batchId: operationId, domain: 'previewCache', members: [operationId], omitted: 0 }, append, async () => {
    logOperation({ stage: 'dispatch', reason: `system-preview-${label}` })
    try {
      const result = await run()
      logOperation({ stage: 'client-result', outcome: result === null ? 'unavailable' : 'returned' })
      return result
    } catch (error) {
      logOperation({ stage: 'client-result', outcome: 'unknown', reason: 'no-rollback-claim' })
      throw error
    }
  })
}
