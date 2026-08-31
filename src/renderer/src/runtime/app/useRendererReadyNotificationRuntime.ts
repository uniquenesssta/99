import { useEffect } from 'react'

export function useRendererReadyNotification(): void {
  useEffect(() => {
    let notified = false
    let firstFrame = 0
    let secondFrame = 0
    let fallbackTimer: number | null = null

    const notifyReady = (): void => {
      if (notified) return
      notified = true
      if (typeof window.hfm.notifyRendererReady === 'function') {
        void window.hfm.notifyRendererReady().catch(() => undefined)
      }
    }

    firstFrame = window.requestAnimationFrame(() => {
      secondFrame = window.requestAnimationFrame(notifyReady)
    })
    fallbackTimer = window.setTimeout(notifyReady, 1200)

    return () => {
      notified = true
      if (firstFrame) window.cancelAnimationFrame(firstFrame)
      if (secondFrame) window.cancelAnimationFrame(secondFrame)
      if (fallbackTimer !== null) window.clearTimeout(fallbackTimer)
    }
  }, [])
}
