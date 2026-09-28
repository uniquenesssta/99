import { useLayoutEffect } from 'react'
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

  // Geometry and anchor restoration commit first. Reveal once before paint;
  // retries across animation frames used to visibly fight scroll restoration.
  useLayoutEffect(() => {
    if (!pendingDetailRevealFontId) return
    if (!detailVisible) { setPendingDetailRevealFontId(''); return }
    const node = fontScrollerRef.current
    if (!node || node.clientWidth !== virtualViewport.width || node.clientHeight !== virtualViewport.height ||
      Math.abs(node.scrollTop - virtualViewport.scrollTop) > 1) return
    if (!revealFontCardInScroller(node, pendingDetailRevealFontId)) return
    if (node.scrollTop !== virtualViewport.scrollTop) {
      setVirtualViewport(prev => ({ ...prev, scrollTop: node.scrollTop }))
    }
    setPendingDetailRevealFontId('')
  }, [detailVisible, pendingDetailRevealFontId, fontScrollerRef, virtualLayout, virtualViewport, setVirtualViewport, setPendingDetailRevealFontId])
}
