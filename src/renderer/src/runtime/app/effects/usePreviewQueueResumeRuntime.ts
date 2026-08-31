import { useEffect,useRef } from 'react'
import { requestIdleWindow } from '../../../rendererMemory'
import { pausePreviewQueueAfterIndexing } from '../../preview/queue/fontPreviewIndexCooldownRuntime'

export function usePreviewQueueResumeRuntime(args: {
  indexingActive: boolean
  processPreviewQueue: () => void
  processAutoPreviewCacheQueue: () => void
}): void {
  const { indexingActive, processPreviewQueue, processAutoPreviewCacheQueue } = args
  const wasIndexingRef = useRef(false)

  useEffect(() => {
    if (indexingActive) {
      wasIndexingRef.current = true
      return
    }

    const delayMs = wasIndexingRef.current ? 1800 : 0
    if (wasIndexingRef.current) pausePreviewQueueAfterIndexing(delayMs)
    wasIndexingRef.current = false

    const timeoutId = window.setTimeout(() => {
      requestIdleWindow(() => {
        processPreviewQueue()
        processAutoPreviewCacheQueue()
      }, 1800)
    }, delayMs)

    return () => window.clearTimeout(timeoutId)
  }, [indexingActive, processPreviewQueue, processAutoPreviewCacheQueue])
}
