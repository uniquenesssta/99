import { DEFAULT_PREVIEW_TEXT,PREVIEW_LAYOUTS } from './previewLayoutConfig'
import type { PreviewLayoutMode,PreviewTextFit } from './previewLayoutTypes'

export function normalizePreviewText(text?: string): string {
  return (text || '').trim() || DEFAULT_PREVIEW_TEXT
}

export function previewTextLines(text?: string, maxLines = 3): string[] {
  const lines = normalizePreviewText(text)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  return lines.length ? lines.slice(0, maxLines) : DEFAULT_PREVIEW_TEXT.split('\n').slice(0, maxLines)
}

function charVisualWeight(char: string): number {
  if (/\s/.test(char)) return 0.34
  if (/^[\x00-\x7F]$/.test(char)) return /[A-Z0-9]/.test(char) ? 0.76 : 0.68
  if (/^[，。！？、；：“”‘’（）【】《》·…—-]$/.test(char)) return 0.46
  return 1
}

function lineVisualUnits(line: string): number {
  return Array.from(line || '').reduce((sum, char) => sum + charVisualWeight(char), 0)
}

function lineHasMixedCjkLatin(line: string): boolean {
  return /[\u3400-\u9FFF]/.test(line) && /[A-Za-z]/.test(line)
}

export function getPreviewTextFit(mode: PreviewLayoutMode, text?: string): PreviewTextFit {
  const spec = PREVIEW_LAYOUTS[mode]
  const lines = previewTextLines(text, spec.maxLines)
  const widestLineUnits = Math.max(1, ...lines.map(lineVisualUnits))
  const mixedScriptGuard = lines.some(lineHasMixedCjkLatin) ? 0.9 : 1

  // Limit-box preview mode:
  // - Normal samples keep the stable base size.
  // - Only clearly overlong text is reduced, and only as much as needed.
  // - We do not try to normalize each font's visual ink area; script/ornamental
  //   fonts keep their natural personality as long as they stay inside the box.
  const fontSize = mode === 'list'
    ? spec.maxFontSize
    : Math.max(spec.minFontSize, Math.min(spec.maxFontSize, Math.round(spec.maxFontSize * Math.min(1, (spec.capacityUnits * mixedScriptGuard) / widestLineUnits))))

  return {
    fontSize,
    lineHeight: spec.lineHeight,
    maxLines: spec.maxLines,
    textAlign: 'center'
  }
}

export function getNativePreviewRequestLayout(mode: PreviewLayoutMode, text?: string): { fontSize: number; width: number; height: number } {
  const spec = PREVIEW_LAYOUTS[mode]
  const fit = getPreviewTextFit(mode, text)
  return {
    fontSize: fit.fontSize,
    width: spec.width,
    height: spec.height
  }
}
