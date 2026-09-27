import { CARD_PREVIEW_LAYOUT_VERSION,CARD_PREVIEW_MAX_TEXT_LENGTH,DEFAULT_PREVIEW_TEXT,PREVIEW_LAYOUTS } from './previewLayoutConfig'
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
  return fitPreviewLines(mode, lines)
}

function fitPreviewLines(mode: PreviewLayoutMode, lines: string[]): PreviewTextFit {
  const spec = PREVIEW_LAYOUTS[mode]
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

export const LIST_PREVIEW_FONT_SIZE_MIN = 18
export const LIST_PREVIEW_FONT_SIZE_MAX = 72
export const LIST_PREVIEW_FONT_SIZE_DEFAULT = 44

export function clampListPreviewFontSize(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed)) return LIST_PREVIEW_FONT_SIZE_DEFAULT
  return Math.max(LIST_PREVIEW_FONT_SIZE_MIN, Math.min(LIST_PREVIEW_FONT_SIZE_MAX, Math.round(parsed)))
}

export function listPreviewFontSizeRowHeightPadding(fontSize: number, viewMode: 'compact' | 'comfortable' | 'large', lineCount: number): number {
  const normalizedSize = clampListPreviewFontSize(fontSize)
  const baseSize = viewMode === 'large' ? 48 : viewMode === 'compact' ? 38 : LIST_PREVIEW_FONT_SIZE_DEFAULT
  const lineMultiplier = Math.max(1, Math.min(2, lineCount || 1))
  const overflow = Math.max(0, normalizedSize - baseSize)
  return Math.ceil(overflow * (lineMultiplier > 1 ? 1.85 : 1.35))
}

export function listPreviewNativeImageHeight(fontSize: number, lineCount: number): number {
  const normalizedSize = clampListPreviewFontSize(fontSize)
  const normalizedLines = Math.max(1, Math.min(2, lineCount || 1))
  const basePreviewBoxHeight = normalizedLines > 1 ? 144 : 108
  return Math.max(86, basePreviewBoxHeight + listPreviewFontSizeRowHeightPadding(normalizedSize, 'comfortable', normalizedLines))
}

// Source ownership stays with library.previewText. Never persist this display derivation.
export function getCardPreviewSample(text?: string): {
  text: string; lines: string[]; hasHiddenLines: boolean; lengthLimited: boolean
} {
  const source = text?.trim() ? text.replace(/\r\n?/g, '\n') : DEFAULT_PREVIEW_TEXT
  const sourceLines = source.split('\n')
  const visible = sourceLines.slice(0, 2).join('\n')
  let end = Math.min(visible.length, CARD_PREVIEW_MAX_TEXT_LENGTH)
  // Preserve a pair straddling the UTF-16 boundary. Invalid input still reaches
  // the existing native validator; do not silently repair unpaired surrogates.
  if (end < visible.length && /[\uD800-\uDBFF]/.test(visible[end - 1]) && /[\uDC00-\uDFFF]/.test(visible[end])) end -= 1
  const sample = visible.slice(0, end)
  return { text: sample, lines: sample.split('\n'), hasHiddenLines: sourceLines.length > 2, lengthLimited: end < visible.length }
}

export function getCardPreviewLayout(mode: 'list' | 'grid', text?: string, listFontSize?: number) {
  const sample = getCardPreviewSample(text)
  const spec = PREVIEW_LAYOUTS[mode]
  const fit = fitPreviewLines(mode, sample.lines)
  const fontSize = mode === 'list' ? clampListPreviewFontSize(listFontSize ?? LIST_PREVIEW_FONT_SIZE_DEFAULT) : fit.fontSize
  const width = spec.width
  const height = mode === 'list' ? listPreviewNativeImageHeight(fontSize, sample.lines.length) : spec.height
  return {
    ...sample, ...fit, fontSize, width, height, mode,
    version: CARD_PREVIEW_LAYOUT_VERSION,
    // Only pixel-relevant input is included: edits to hidden lines and the hidden
    // list control in grid mode must not invalidate an identical image.
    token: JSON.stringify([CARD_PREVIEW_LAYOUT_VERSION, mode, sample.text, fontSize, width, height])
  }
}
