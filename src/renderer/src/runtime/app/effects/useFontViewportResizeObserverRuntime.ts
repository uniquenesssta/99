import { useEffect } from 'react'
import { markWindowResizeActive,subscribeWindowResizeSettled } from '../windowResizePhaseRuntime'
import type { Dispatch, MutableRefObject, SetStateAction } from 'react'
import type { VirtualViewport } from '../../../appRuntime'

export function useFontViewportResizeObserverRuntime(args: {
  fontScrollerRef: MutableRefObject<HTMLDivElement | null>
  setVirtualViewport: Dispatch<SetStateAction<VirtualViewport>>
}): void {
  const { fontScrollerRef, setVirtualViewport } = args

  useEffect(() => {
    const node = fontScrollerRef.current
    if (!node) return

    let disposed = false
    let viewportFrame = 0
    let viewportTimer = 0
    let finalTimer = 0
    let lastAppliedAt = 0

    const applyViewport = (): void => {
      if (disposed) return
      lastAppliedAt = performance.now()
      setVirtualViewport((prev) => {
        const nextHeight = node.clientHeight || prev.height
        const nextWidth = node.clientWidth || prev.width
        const nextScrollTop = node.scrollTop
        if (
          Math.abs((prev.height || 0) - nextHeight) < 2 &&
          Math.abs((prev.width || 0) - nextWidth) < 2 &&
          Math.abs((prev.scrollTop || 0) - nextScrollTop) < 1
        ) return prev
        return {
          ...prev,
          height: nextHeight,
          width: nextWidth,
          scrollTop: nextScrollTop
        }
      })
    }

    const scheduleApplyViewport = (delayMs = 0): void => {
      if (disposed) return
      if (viewportFrame) window.cancelAnimationFrame(viewportFrame)
      if (viewportTimer) {
        window.clearTimeout(viewportTimer)
        viewportTimer = 0
      }
      const run = (): void => {
        viewportTimer = 0
        viewportFrame = window.requestAnimationFrame(() => {
          viewportFrame = 0
          applyViewport()
        })
      }
      if (delayMs > 0) viewportTimer = window.setTimeout(run, delayMs)
      else run()
    }

    const scheduleResizeViewport = (): void => {
      markWindowResizeActive()
      const elapsed = performance.now() - lastAppliedAt
      scheduleApplyViewport(elapsed >= 120 ? 0 : 120 - elapsed)
      if (finalTimer) window.clearTimeout(finalTimer)
      finalTimer = window.setTimeout(() => scheduleApplyViewport(0), 260)
    }

    const unsubscribeResizeSettled = subscribeWindowResizeSettled(() => scheduleApplyViewport(0))

    applyViewport()

    const observer = new ResizeObserver(scheduleResizeViewport)
    observer.observe(node)
    window.addEventListener('resize', scheduleResizeViewport, { passive: true })

    return () => {
      disposed = true
      if (viewportFrame) window.cancelAnimationFrame(viewportFrame)
      if (viewportTimer) window.clearTimeout(viewportTimer)
      if (finalTimer) window.clearTimeout(finalTimer)
      window.removeEventListener('resize', scheduleResizeViewport)
      observer.disconnect()
      unsubscribeResizeSettled()
    }
  }, [])
}
