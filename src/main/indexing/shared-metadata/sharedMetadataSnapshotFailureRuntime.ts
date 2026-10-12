import { createHash } from 'node:crypto'
import { SharedIoProcessError } from '../../path/sharedIoProcessRuntime'

export class SharedMetadataSnapshotBusyError extends SharedIoProcessError {
  constructor(error: SharedIoProcessError, readonly pinTarget: string, readonly rootToken: string) {
    super(error.message, error.outcome, 'snapshot-busy')
    this.closed = error.closed
    this.queuedMs = error.queuedMs
    this.executionMs = error.executionMs
  }
}

// Only the read-only binding caller may interpret this native machine marker.
// Error text/OS numbers alone cannot certify that a failed operation is retryable.
export function rethrowSharedMetadataSnapshotBusy(error: unknown, root: string): void {
  if (!error || typeof error !== 'object') return
  const failure = error as SharedIoProcessError
  if (failure.sharedIo !== true || failure.reason !== 'process-exit') return
  const match = /^Shared I\/O process failed: code=2, signal=null, message=\[HFM_BINDING_SNAPSHOT_BUSY:(database|parent|wal|journal):(32|33)\] /.exec(failure.message)
  if (!match) return
  const rootToken = createHash('sha256').update(root.replace(/\//g, '\\').toLowerCase()).digest('hex').slice(0, 16)
  throw new SharedMetadataSnapshotBusyError(failure, match[1], rootToken)
}
