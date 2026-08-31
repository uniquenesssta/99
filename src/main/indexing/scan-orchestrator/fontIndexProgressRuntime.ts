import type { FontIndexProgressPayload } from '../../../shared/types'
import type { ScanOrchestratorDeps } from './scanOrchestratorTypes'

export function createFontIndexProgressReporter(
  deps: Pick<ScanOrchestratorDeps, 'emitFontIndexProgress' | 'indexProgressEventMinIntervalMs'>,
  jobId: string,
  folders: string[],
): (
  payload: Omit<FontIndexProgressPayload, 'jobId' | 'folders' | 'at'>,
  force?: boolean,
) => void {
  let lastSentAt = 0
  return (payload, force = false) => {
    const now = Date.now()
    if (!force && now - lastSentAt < deps.indexProgressEventMinIntervalMs) return
    lastSentAt = now
    deps.emitFontIndexProgress({
      ...payload,
      jobId,
      folders,
      at: new Date(now).toISOString(),
    })
  }
}
