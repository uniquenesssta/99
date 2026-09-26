import { logOperation } from '../../logging/operationTraceContext'

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
