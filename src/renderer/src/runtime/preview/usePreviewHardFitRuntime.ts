import { useLayoutEffect,useRef,useState } from 'react'
import type { RefObject } from 'react'
import { isWindowResizeActive,subscribeWindowResizeSettled } from '../app/windowResizePhaseRuntime'

export type PreviewHardFitRuntime = {
  boxRef: RefObject<HTMLSpanElement>
  contentRef: RefObject<HTMLSpanElement>
  scale: number
}

function readPixel(value: string): number {
  const parsed = Number.parseFloat(value || '0')
  return Number.isFinite(parsed) ? parsed : 0
}

function previewLinesFromContent(content: HTMLElement): string[] {
  const lineNodes = Array.from(content.querySelectorAll<HTMLElement>('.font-sample-line'))
  const lines = lineNodes.map((node) => node.textContent?.trim() || '').filter(Boolean)
  return lines.length ? lines : [(content.textContent || '').trim()].filter(Boolean)
}

function measureInkBounds(content: HTMLElement): { width: number; height: number } | null {
  const lines = previewLinesFromContent(content)
  if (!lines.length) return null

  const style = window.getComputedStyle(content)
  const fontSize = Math.max(1, readPixel(style.fontSize))
  const lineHeight = style.lineHeight === 'normal' ? fontSize * 1.2 : Math.max(fontSize, readPixel(style.lineHeight))
  const fontStyle = style.fontStyle || 'normal'
  const fontWeight = style.fontWeight || '400'
  const fontFamily = style.fontFamily || 'sans-serif'

  const canvas = document.createElement('canvas')
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) return null

  context.font = `${fontStyle} ${fontWeight} ${fontSize}px ${fontFamily}`
  const measuredWidth = Math.max(1, ...lines.map((line) => context.measureText(line).width))
  const margin = Math.ceil(fontSize * 2.4)
  const canvasWidth = Math.min(8192, Math.max(64, Math.ceil(measuredWidth + margin * 2)))
  const canvasHeight = Math.min(4096, Math.max(64, Math.ceil(lineHeight * lines.length + margin * 2)))
  canvas.width = canvasWidth
  canvas.height = canvasHeight

  context.clearRect(0, 0, canvasWidth, canvasHeight)
  context.fillStyle = '#000000'
  context.textAlign = 'left'
  context.textBaseline = 'alphabetic'
  context.font = `${fontStyle} ${fontWeight} ${fontSize}px ${fontFamily}`

  lines.forEach((line, index) => {
    context.fillText(line, margin, margin + fontSize + index * lineHeight)
  })

  const image = context.getImageData(0, 0, canvasWidth, canvasHeight)
  const data = image.data
  let minX = canvasWidth
  let minY = canvasHeight
  let maxX = -1
  let maxY = -1

  for (let y = 0; y < canvasHeight; y += 1) {
    const row = y * canvasWidth * 4
    for (let x = 0; x < canvasWidth; x += 1) {
      if (data[row + x * 4 + 3] <= 8) continue
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
  }

  if (maxX < minX || maxY < minY) return null
  return { width: maxX - minX + 1, height: maxY - minY + 1 }
}

function measureHardFitScale(box: HTMLElement, content: HTMLElement): number {
  const boxStyle = window.getComputedStyle(box)
  const innerWidth = Math.max(1, box.clientWidth - readPixel(boxStyle.paddingLeft) - readPixel(boxStyle.paddingRight))
  const innerHeight = Math.max(1, box.clientHeight - readPixel(boxStyle.paddingTop) - readPixel(boxStyle.paddingBottom))
  const inkBounds = measureInkBounds(content)
  const lines = previewLinesFromContent(content)
  const lineCount = Math.max(1, lines.length)
  const contentStyle = window.getComputedStyle(content)
  const fontSize = Math.max(1, readPixel(contentStyle.fontSize))
  const lineHeight = contentStyle.lineHeight === 'normal' ? fontSize * 1.2 : Math.max(fontSize, readPixel(contentStyle.lineHeight))

  // Some Windows/CJK/script fonts draw far outside their CSS line box. Canvas
  // and DOM scroll metrics both under-report those decorative overhangs in
  // different cases, so multiline list previews need an explicit vertical
  // guard. Otherwise the second line looks measured as fitted but is clipped by
  // the fixed virtual-list frame.
  const guardedLineHeight = fontSize * (lineCount > 1 ? 1.52 : 1.28)
  const guardedHeight = Math.max(lineHeight * lineCount, guardedLineHeight * lineCount)
  const naturalWidth = Math.max(1, content.scrollWidth, inkBounds?.width || 0)
  const naturalHeight = Math.max(1, content.scrollHeight, inkBounds?.height || 0, guardedHeight)
  const widthScale = innerWidth / naturalWidth
  const heightScale = innerHeight / naturalHeight
  const fittedScale = Math.min(1, widthScale, heightScale)
  const safetyScale = lineCount > 1 ? 0.94 : 0.90

  return Math.max(0.04, Math.min(1, fittedScale * safetyScale))
}

export function usePreviewHardFit(enabled: boolean, dependencies: readonly unknown[]): PreviewHardFitRuntime {
  const boxRef = useRef<HTMLSpanElement | null>(null)
  const contentRef = useRef<HTMLSpanElement | null>(null)
  const [scale, setScale] = useState(1)

  useLayoutEffect(() => {
    if (!enabled) {
      setScale(1)
      return
    }

    let disposed = false
    let frame = 0
    let afterResizeTimer = 0
    let pendingAfterResize = false

    const measure = (): void => {
      if (disposed) return
      const box = boxRef.current
      const content = contentRef.current
      if (!box || !content) return
      const nextScale = measureHardFitScale(box, content)
      setScale((current) => (Math.abs(current - nextScale) < 0.006 ? current : nextScale))
    }

    const scheduleMeasure = (): void => {
      if (disposed) return
      if (isWindowResizeActive()) {
        pendingAfterResize = true
        return
      }
      if (frame) window.cancelAnimationFrame(frame)
      frame = window.requestAnimationFrame(() => {
        frame = 0
        measure()
      })
    }

    const scheduleAfterResizeSettled = (): void => {
      if (disposed) return
      if (!pendingAfterResize) return
      pendingAfterResize = false
      if (afterResizeTimer) window.clearTimeout(afterResizeTimer)
      afterResizeTimer = window.setTimeout(() => {
        afterResizeTimer = 0
        scheduleMeasure()
      }, 35 + Math.floor(Math.random() * 165))
    }

    const unsubscribeResizeSettled = subscribeWindowResizeSettled(scheduleAfterResizeSettled)
    const resizeObserver = new ResizeObserver(scheduleMeasure)
    if (boxRef.current) resizeObserver.observe(boxRef.current)
    if (contentRef.current) resizeObserver.observe(contentRef.current)

    scheduleMeasure()
    window.setTimeout(scheduleMeasure, 80)
    window.setTimeout(scheduleMeasure, 240)
    if (document.fonts?.ready) {
      document.fonts.ready.then(scheduleMeasure).catch(() => undefined)
    }

    return () => {
      disposed = true
      if (frame) window.cancelAnimationFrame(frame)
      if (afterResizeTimer) window.clearTimeout(afterResizeTimer)
      resizeObserver.disconnect()
      unsubscribeResizeSettled()
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, ...dependencies])

  return { boxRef, contentRef, scale }
}
