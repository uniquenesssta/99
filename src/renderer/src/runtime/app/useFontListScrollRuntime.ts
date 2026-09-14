import { useCallback } from 'react'
import type { Dispatch, MutableRefObject, SetStateAction, UIEvent } from 'react'
import type { RendererPerformanceEventPayload, SidebarPage, VirtualLayout, VirtualViewport } from '../../appRuntime'

export function useFontListScrollRuntime(options: {
  sidebarPage: SidebarPage
  virtualLayout: VirtualLayout
  databasePageReady: boolean
  visibleFontTotal: number
  visibleFontsLength: number
  scrollRafRef: MutableRefObject<number | null>
  lastScrollTraceAtRef: MutableRefObject<number>
  beginFontListScroll: (previewScrollIdleMs: number) => void
  previewScrollIdleMs: number
  userActivityIdleWindowMs: number
  reportUserActivity: (reason?: string, durationMs?: number) => void
  reportTrace: (payload: RendererPerformanceEventPayload, label: string) => void
  setVirtualViewport: Dispatch<SetStateAction<VirtualViewport>>
}): (event: UIEvent<HTMLDivElement>) => void {
  const {
    sidebarPage,
    virtualLayout,
    databasePageReady,
    visibleFontTotal,
    visibleFontsLength,
    scrollRafRef,
    lastScrollTraceAtRef,
    beginFontListScroll,
    previewScrollIdleMs,
    userActivityIdleWindowMs,
    reportUserActivity,
    reportTrace,
    setVirtualViewport
  } = options

  return useCallback((event: UIEvent<HTMLDivElement>): void => {
    const node = event.currentTarget
    reportUserActivity('scroll', userActivityIdleWindowMs)
    beginFontListScroll(previewScrollIdleMs)

    if (scrollRafRef.current !== null) return

    scrollRafRef.current = window.requestAnimationFrame(() => {
      scrollRafRef.current = null
      const now = performance.now()
      if (now - lastScrollTraceAtRef.current > 900) {
        lastScrollTraceAtRef.current = now
        reportTrace({
          kind: 'scroll-sample',
          label: 'font-list-scroll',
          page: sidebarPage,
          durationMs: 0,
          details: {
            scrollTop: Math.round(node.scrollTop),
            clientHeight: node.clientHeight,
            scrollHeight: node.scrollHeight,
            virtualStart: virtualLayout.startIndex,
            virtualEnd: virtualLayout.endIndex,
            virtualItems: virtualLayout.items.length,
            total: databasePageReady ? visibleFontTotal : visibleFontsLength,
            databasePageReady
          }
        }, 'scroll-sample')
      }
      setVirtualViewport((prev) => ({
        ...prev,
        scrollTop: node.scrollTop,
        height: node.clientHeight || prev.height,
        width: node.clientWidth || prev.width
      }))
    })
  }, [
    sidebarPage,
    virtualLayout,
    databasePageReady,
    visibleFontTotal,
    visibleFontsLength,
    scrollRafRef,
    lastScrollTraceAtRef,
    beginFontListScroll,
    previewScrollIdleMs,
    userActivityIdleWindowMs,
    reportUserActivity,
    reportTrace,
    setVirtualViewport
  ])
}
