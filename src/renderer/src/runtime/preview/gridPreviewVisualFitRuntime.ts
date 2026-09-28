import { useLayoutEffect,useState } from 'react'

// Both routes keep their base CSS-pixel size; shrink the entire sample only
// when needed, never below the grid's 26px reading floor or enlarge small ink.
export function gridPreviewVisualFit(width: number, height: number, availableWidth: number, availableHeight: number, fontSize: number) {
  const floor = Math.min(1, 26 / Math.max(26, fontSize))
  const scale = Math.max(floor, Math.min(1, availableWidth / Math.max(1, width), availableHeight / Math.max(1, height)))
  return { scale, overflow: width * scale > availableWidth + 1 || height * scale > availableHeight + 1 }
}

export function useGridPreviewVisualFit(identity: string, fontSize: number, clipped = false) {
  const [viewport, setViewport] = useState<HTMLDivElement | null>(null)
  const [content, setContent] = useState<HTMLDivElement | null>(null)
  const [fit, setFit] = useState({ scale: 1, overflow: false })
  useLayoutEffect(() => {
    if (!viewport || !content) return
    let disposed = false
    const measure = () => {
      if (disposed) return
      const next = gridPreviewVisualFit(content.offsetWidth, content.offsetHeight, viewport.clientWidth, viewport.clientHeight, fontSize)
      next.overflow ||= clipped
      setFit(previous => previous.scale === next.scale && previous.overflow === next.overflow ? previous : next)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(viewport)
    observer.observe(content)
    content.addEventListener('load', measure, true)
    document.fonts.addEventListener('loadingdone', measure)
    document.fonts.addEventListener('loadingerror', measure)
    void document.fonts.ready.then(measure)
    return () => {
      disposed = true
      observer.disconnect()
      content.removeEventListener('load', measure, true)
      document.fonts.removeEventListener('loadingdone', measure)
      document.fonts.removeEventListener('loadingerror', measure)
    }
  }, [viewport, content, identity, fontSize, clipped])
  return { ...fit, viewportRef: setViewport, contentRef: setContent }
}
