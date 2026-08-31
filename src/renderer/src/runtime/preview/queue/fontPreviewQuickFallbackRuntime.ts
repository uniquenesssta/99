import type { FontItem } from '@shared/types'

export const QUICK_WEBFONT_URL_TIMEOUT_MS = 180
export const QUICK_WEBFONT_BINARY_TIMEOUT_MS = 120
export const QUICK_WEBFONT_TOTAL_BUDGET_MS = 300
export const QUICK_WEBFONT_BINARY_MAX_BYTES = 2 * 1024 * 1024

export function binaryWebFontQuickFallbackEnabled(): boolean {
  return String(import.meta.env?.VITE_HFM_PREVIEW_BINARY_WEBFONT_FALLBACK || '').trim() === '1'
}

export class QuickPreviewTimeoutError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'QuickPreviewTimeoutError'
  }
}

export function lowerFontPreviewPath(font: FontItem): string {
  return String(font.path || font.fileName || '').toLowerCase()
}

export function isFontCollectionOrLargeFont(font: FontItem): boolean {
  const path = lowerFontPreviewPath(font)
  const size = Number(font.fileSize || 0)
  return font.format === 'ttc' || path.endsWith('.ttc') || size >= 8 * 1024 * 1024
}

export function canUseBinaryWebFontQuickFallback(font: FontItem): boolean {
  if (!binaryWebFontQuickFallbackEnabled()) return false
  const path = lowerFontPreviewPath(font)
  const size = Number(font.fileSize || 0)
  if (font.format === 'ttc' || path.endsWith('.ttc')) return false
  if (size <= 0 || size > QUICK_WEBFONT_BINARY_MAX_BYTES) return false
  return path.endsWith('.ttf') || path.endsWith('.otf') || font.format === 'ttf' || font.format === 'otf'
}

export function remainingQuickPreviewBudget(startedAt: number, totalBudgetMs = QUICK_WEBFONT_TOTAL_BUDGET_MS): number {
  return Math.max(0, totalBudgetMs - Math.round(performance.now() - startedAt))
}

export function quickPreviewBudgetExpired(startedAt: number): boolean {
  return remainingQuickPreviewBudget(startedAt) <= 0
}

export async function withQuickPreviewTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string
): Promise<T> {
  let timer: number | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = window.setTimeout(() => {
      reject(new QuickPreviewTimeoutError(`${label} 超过 ${timeoutMs}ms，已切换原生预览。`))
    }, Math.max(1, timeoutMs))
  })

  try {
    return await Promise.race([promise, timeout])
  } finally {
    if (timer !== undefined) window.clearTimeout(timer)
  }
}

export async function loadFontFaceFromUrlWithinBudget(
  family: string,
  url: string,
  timeoutMs = QUICK_WEBFONT_URL_TIMEOUT_MS
): Promise<FontFace> {
  const face = new FontFace(family, `url("${url}")`)
  await withQuickPreviewTimeout(face.load(), timeoutMs, '协议 WebFont 快速预览')
  document.fonts.add(face)
  return face
}

export async function loadFontFaceFromBinaryWithinBudget(
  family: string,
  source: ArrayBuffer,
  timeoutMs = QUICK_WEBFONT_BINARY_TIMEOUT_MS
): Promise<FontFace> {
  const face = new FontFace(family, source)
  await withQuickPreviewTimeout(face.load(), timeoutMs, '二进制 WebFont 快速预览')
  document.fonts.add(face)
  return face
}
