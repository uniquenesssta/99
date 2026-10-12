import { useEffect, useRef, useState } from 'react'
import type { SharedWatchStatus } from '../../../../shared/sharedWatchStatus'
import { createSharedWatchStatusPoller, sharedWatchStatusPresentation } from '../../runtime/app/sharedWatchStatusRuntime'

export function SharedWatchStatusBar({ developerStatus }: { developerStatus?: string }): JSX.Element | null {
  const [status, setStatus] = useState<SharedWatchStatus | null>(null)
  const poller = useRef<ReturnType<typeof createSharedWatchStatusPoller> | null>(null)
  if (!poller.current) poller.current = createSharedWatchStatusPoller({ read: () => window.hfm.getSharedWatchStatus() })
  useEffect(() => poller.current!.start(setStatus), [])
  const presentation = sharedWatchStatusPresentation(status)
  if (!presentation && developerStatus === undefined) return null
  return (
    <footer className="statusbar">
      {presentation && <span role="status" title={presentation.detail} style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{presentation.text}</span>}
      {developerStatus !== undefined && <span title={developerStatus} style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{presentation ? ' · ' : ''}{developerStatus}</span>}
    </footer>
  )
}
