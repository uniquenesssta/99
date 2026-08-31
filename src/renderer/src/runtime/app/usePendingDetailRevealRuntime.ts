import { useEffect } from 'react'
import type { Dispatch, MutableRefObject, SetStateAction } from 'react'
import type { VirtualLayout, VirtualViewport } from '../../appRuntime'
import { revealFontCardInScroller } from './fontCardDomRuntime'

export function usePendingDetailRevealRuntime(options: {
  detailVisible: boolean
  pendingDetailRevealFontId: string
  fontScrollerRef: MutableRefObject<HTMLDivElement | null>
  virtualLayout: VirtualLayout
  virtualViewport: VirtualViewport
  setVirtualViewport: Dispatch<SetStateAction<VirtualViewport>>
  setPendingDetailRevealFontId: Dispatch<SetStateAction<string>>
}): void {
  const {
    detailVisible,
    pendingDetailRevealFontId,
    fontScrollerRef,
    virtualLayout,
    virtualViewport,
    setVirtualViewport,
    setPendingDetailRevealFontId
  } = options

  useEffect(() => {
    if (!detailVisible || !pendingDetailRevealFontId) return

    let disposed = false
    let attempt = 0
    let rafId = 0
    let timerId: number | null = null
    let lastScrollTop = -1
    let stablePasses = 0
    const maxAttempts = 18

    const syncViewportAfterReveal = (node: HTMLDivElement): void => {
      setVirtualViewport((prev) => ({
        ...prev,
        scrollTop: node.scrollTop,
        height: node.clientHeight || prev.height,
        width: node.clientWidth || prev.width
      }))
    }

    const finishReveal = (): void => {
      if (!disposed) setPendingDetailRevealFontId('')
    }

    const tryReveal = (): void => {
      if (disposed) return
      const node = fontScrollerRef.current
      const revealed = Boolean(node && revealFontCardInScroller(node, pendingDetailRevealFontId))
      if (node && revealed) {
        syncViewportAfterReveal(node)
        const currentScrollTop = Math.round(node.scrollTop)
        stablePasses = currentScrollTop === lastScrollTop ? stablePasses + 1 : 0
        lastScrollTop = currentScrollTop
      } else {
        stablePasses = 0
      }

      attempt += 1
      if (revealed && stablePasses >= 3) {
        finishReveal()
        return
      }
      if (attempt >= maxAttempts) {
        finishReveal()
        return
      }
      timerId = window.setTimeout(scheduleReveal, revealed ? 55 : 35)
    }

    const scheduleReveal = (): void => {
      rafId = window.requestAnimationFrame(() => {
        rafId = window.requestAnimationFrame(tryReveal)
      })
    }

    scheduleReveal()

    return () => {
      disposed = true
      if (rafId) window.cancelAnimationFrame(rafId)
      if (timerId !== null) window.clearTimeout(timerId)
    }
  }, [detailVisible, pendingDetailRevealFontId, fontScrollerRef, virtualLayout.columns, virtualLayout.startIndex, virtualLayout.endIndex, virtualViewport.width, virtualViewport.height, setVirtualViewport, setPendingDetailRevealFontId])
}
