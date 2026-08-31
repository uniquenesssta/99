import { useEffect } from 'react'
import { registerRendererActivityListeners, startRendererLongTaskMonitor } from '../../../rendererActivityRuntime'

export function useRendererActivityRuntime(args: {
  hfm: Window['hfm']
  sidebarPage: string
  reportUserActivity: (reason?: string, durationMs?: number) => void
}): void {
  const { hfm, sidebarPage, reportUserActivity } = args

  useEffect(() => {
    const onActivity = (): void => reportUserActivity('renderer')
    return registerRendererActivityListeners(onActivity)
  }, [])

  useEffect(() => startRendererLongTaskMonitor({
    hfm,
    source: sidebarPage
  }), [sidebarPage])
}
