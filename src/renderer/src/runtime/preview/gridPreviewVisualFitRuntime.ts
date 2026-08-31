import { useEffect,useMemo,useState } from 'react'

const GRID_VISUAL_FIT_MAX_CANDIDATES = 5
const GRID_VISUAL_FIT_OVERFLOW_TOLERANCE_PX = 4
const MIXED_SCRIPT_LATIN_TAIL_PATTERN = /([\u3400-\u9FFF\uF900-\uFAFF][\u3400-\u9FFF\uF900-\uFAFF\s·・-]*)([A-Za-z]{3,})$/

function uniqueValues(values: string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const value of values) {
    if (seen.has(value)) continue
    seen.add(value)
    result.push(value)
  }
  return result
}

function shortenLatinTail(line: string, maxLatinLength: number): string {
  return line.replace(MIXED_SCRIPT_LATIN_TAIL_PATTERN, (_match, prefix: string, latinTail: string) => {
    if (latinTail.length <= maxLatinLength) return `${prefix}${latinTail}`
    return `${prefix}${latinTail.slice(0, maxLatinLength)}`
  })
}

function lineCanUseLatinTailFit(line: string): boolean {
  return MIXED_SCRIPT_LATIN_TAIL_PATTERN.test(line)
}

export function buildGridPreviewVisualFitCandidates(text: string, lines: string[]): string[] {
  const sourceText = text || ''
  const sourceLines = lines.length ? lines : sourceText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  if (!sourceLines.some(lineCanUseLatinTailFit)) return [sourceText]

  const candidates = [
    sourceLines,
    sourceLines.map((line) => shortenLatinTail(line, 3)),
    sourceLines.map((line) => shortenLatinTail(line, 2)),
    sourceLines.map((line) => shortenLatinTail(line, 1)),
    sourceLines.map((line) => shortenLatinTail(line, 0)),
  ]
    .map((candidateLines) => candidateLines.join('\n'))
    .slice(0, GRID_VISUAL_FIT_MAX_CANDIDATES)

  return uniqueValues(candidates)
}

function measureInkWidth(line: HTMLElement): number {
  const text = line.textContent || ''
  if (!text) return 0
  const canvas = document.createElement('canvas')
  const context = canvas.getContext('2d')
  if (!context) return 0
  const computed = window.getComputedStyle(line)
  context.font = computed.font || `${computed.fontStyle} ${computed.fontWeight} ${computed.fontSize} ${computed.fontFamily}`
  const metrics = context.measureText(text)
  const inkWidth = Math.ceil((metrics.actualBoundingBoxLeft || 0) + (metrics.actualBoundingBoxRight || 0))
  return Math.max(Math.ceil(metrics.width || 0), inkWidth)
}

function hasOverflow(node: HTMLElement | null): boolean {
  if (!node) return false
  const lines = Array.from(node.querySelectorAll<HTMLElement>('.font-sample-line'))
  for (const line of lines) {
    const limit = Math.max(0, line.clientWidth - GRID_VISUAL_FIT_OVERFLOW_TOLERANCE_PX)
    if (line.scrollWidth > line.clientWidth + GRID_VISUAL_FIT_OVERFLOW_TOLERANCE_PX) return true
    if (measureInkWidth(line) > limit) return true
  }
  return false
}

export function useGridPreviewVisualFitText(text: string, lines: string[], enabled = true): {
  fittedText: string
  visualFitRef: (node: HTMLDivElement | null) => void
  visualFitActive: boolean
} {
  const candidates = useMemo(() => buildGridPreviewVisualFitCandidates(text, lines), [text, lines])
  const [candidateIndex, setCandidateIndex] = useState(0)
  const [sampleNode, setSampleNode] = useState<HTMLDivElement | null>(null)

  useEffect(() => {
    setCandidateIndex(0)
  }, [candidates])

  useEffect(() => {
    if (!enabled || !sampleNode || candidateIndex >= candidates.length - 1) return
    let cancelled = false
    const check = (): void => {
      if (cancelled) return
      if (!hasOverflow(sampleNode)) return
      setCandidateIndex((current) => Math.min(current + 1, candidates.length - 1))
    }
    const frame = window.requestAnimationFrame(check)
    return () => {
      cancelled = true
      window.cancelAnimationFrame(frame)
    }
  }, [enabled, sampleNode, candidateIndex, candidates.length])

  return {
    fittedText: candidates[Math.min(candidateIndex, candidates.length - 1)] || text,
    visualFitRef: setSampleNode,
    visualFitActive: candidateIndex > 0,
  }
}
