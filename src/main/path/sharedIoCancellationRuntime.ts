import { currentSharedIoSignal } from './sharedFileSystemRuntime'
import { SharedIoProcessError } from './sharedIoProcessRuntime'

// Cancellation is terminal at read/fallback boundaries, even when a native or
// scheduler error is not a SharedIoProcessError and no ambient signal remains.
export function isSharedIoCancellationError(error: unknown): boolean {
  const value = error as { name?: string; code?: string; reason?: string } | null
  return value?.name === 'AbortError' || value?.code === 'ABORT_ERR'
    || value?.name === 'OperationCancelledError'
    || value?.name === 'RustCoreSchedulerTaskCancelled'
    || ['cancelled', 'stopping', 'query-superseded'].includes(value?.reason || '')
}

export function assertSharedIoActive(signal = currentSharedIoSignal(), cause?: unknown): void {
  if (signal?.aborted) {
    const error = new SharedIoProcessError('I/O operation cancelled.', 'not-started', 'cancelled')
    error.closed = (cause as SharedIoProcessError | undefined)?.closed
    throw error
  }
}

export function rethrowSharedIoCancellation(error: unknown): void {
  // Preserve the original error, especially its physical-child close promise.
  if (isSharedIoCancellationError(error)) throw error
  assertSharedIoActive(currentSharedIoSignal(), error)
}
