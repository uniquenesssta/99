import { useEffect, useRef, useState } from 'react'
import type { SharedWatchStatus } from '../../../../shared/sharedWatchStatus'
import { createSharedWatchStatusPoller, sharedWatchStatusPresentation } from '../../runtime/app/sharedWatchStatusRuntime'

/** The App owns polling; switching the developer page only changes presentation. */
export function useSharedWatchStatus(): SharedWatchStatus | null {
  const [status, setStatus] = useState<SharedWatchStatus | null>(null)
  const poller = useRef<ReturnType<typeof createSharedWatchStatusPoller> | null>(null)
  if (!poller.current) poller.current = createSharedWatchStatusPoller({ read: () => window.hfm.getSharedWatchStatus() })
  useEffect(() => poller.current!.start(setStatus), [])
  return status
}

export function SharedWatchStatusCard({ status }: { status: SharedWatchStatus | null }): JSX.Element {
  const presentation = sharedWatchStatusPresentation(status)
  return (
    <div className="developer-card wide" data-shared-watch-status>
      <h3>NAS 监听</h3>
      <p role="status">{presentation?.text || '当前没有共享监听位置。'}</p>
      {presentation && <pre>{presentation.detail}</pre>}
    </div>
  )
}
