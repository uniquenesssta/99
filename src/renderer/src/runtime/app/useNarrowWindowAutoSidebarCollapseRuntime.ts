import { useEffect,useRef } from 'react'
import type { MutableRefObject } from 'react'
import { markLayoutTransitionActive,markWindowResizeActive } from './windowResizePhaseRuntime'

export const SIDEBAR_AUTO_COLLAPSE_WIDTH_PX = 1120
export const SIDEBAR_AUTO_EXPAND_WIDTH_PX = 1220

export function shouldAutoCollapseSidebar(width: number): boolean {
  return width > 0 && width <= SIDEBAR_AUTO_COLLAPSE_WIDTH_PX
}

export function shouldReleaseAutoCollapsedSidebar(width: number): boolean {
  return width >= SIDEBAR_AUTO_EXPAND_WIDTH_PX
}

export function useNarrowWindowAutoSidebarCollapseRuntime(args: {
  setSidebarCollapsedState: (value: boolean) => void
  userSidebarCollapsedRef: MutableRefObject<boolean>
}): MutableRefObject<boolean> {
  const { setSidebarCollapsedState,userSidebarCollapsedRef } = args
  const autoCollapsedRef = useRef(false)

  useEffect(() => {
    let frame = 0
    let disposed = false

    const apply = (): void => {
      if (disposed) return
      const width = window.innerWidth || document.documentElement.clientWidth || 0
      if (shouldAutoCollapseSidebar(width)) {
        if (!autoCollapsedRef.current) markLayoutTransitionActive()
        autoCollapsedRef.current = true
        setSidebarCollapsedState(true)
        document.documentElement.setAttribute('data-hfm-sidebar-auto-collapsed', '1')
        return
      }

      if (autoCollapsedRef.current && shouldReleaseAutoCollapsedSidebar(width)) {
        markLayoutTransitionActive()
        autoCollapsedRef.current = false
        setSidebarCollapsedState(userSidebarCollapsedRef.current)
        document.documentElement.removeAttribute('data-hfm-sidebar-auto-collapsed')
      }
    }

    const schedule = (): void => {
      markWindowResizeActive()
      if (frame) window.cancelAnimationFrame(frame)
      frame = window.requestAnimationFrame(() => {
        frame = 0
        apply()
      })
    }

    apply()
    window.addEventListener('resize', schedule, { passive: true })
    return () => {
      disposed = true
      if (frame) window.cancelAnimationFrame(frame)
      window.removeEventListener('resize', schedule)
      document.documentElement.removeAttribute('data-hfm-sidebar-auto-collapsed')
    }
  }, [setSidebarCollapsedState, userSidebarCollapsedRef])

  return autoCollapsedRef
}
