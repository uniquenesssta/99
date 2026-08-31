export function fontCardSelector(fontId: string): string {
  const escaped = fontId.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  return `[data-font-id="${escaped}"]`
}

export function revealFontCardInScroller(scroller: HTMLDivElement, fontId: string): boolean {
  const card = scroller.querySelector(fontCardSelector(fontId)) as HTMLElement | null
  if (!card) return false

  const scrollerRect = scroller.getBoundingClientRect()
  const cardRect = card.getBoundingClientRect()
  const padding = 18
  let nextScrollTop = scroller.scrollTop

  const cardIsTallerThanViewport = cardRect.height + padding * 2 >= scrollerRect.height
  if (cardIsTallerThanViewport) {
    const topEdge = scrollerRect.top + padding
    const latestReadableTop = scrollerRect.bottom - Math.max(72, Math.min(120, scrollerRect.height * 0.42))
    if (cardRect.top < topEdge) {
      nextScrollTop += cardRect.top - topEdge
    } else if (cardRect.top > latestReadableTop) {
      nextScrollTop += cardRect.top - latestReadableTop
    }
  } else if (cardRect.top < scrollerRect.top + padding) {
    nextScrollTop += cardRect.top - scrollerRect.top - padding
  } else if (cardRect.bottom > scrollerRect.bottom - padding) {
    nextScrollTop += cardRect.bottom - scrollerRect.bottom + padding
  }

  if (Math.abs(nextScrollTop - scroller.scrollTop) > 1) {
    scroller.scrollTop = Math.max(0, nextScrollTop)
  }
  return true
}
