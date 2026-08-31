import type { ViewMode } from '../../appTypes'

export const LIST_PREVIEW_FONT_SIZE_STORAGE_KEY = 'hfm.listPreviewFontSize'
export const LIST_PREVIEW_FONT_SIZE_MIN = 18
export const LIST_PREVIEW_FONT_SIZE_MAX = 72
export const LIST_PREVIEW_FONT_SIZE_DEFAULT = 44

export function clampListPreviewFontSize(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed)) return LIST_PREVIEW_FONT_SIZE_DEFAULT
  return Math.max(LIST_PREVIEW_FONT_SIZE_MIN, Math.min(LIST_PREVIEW_FONT_SIZE_MAX, Math.round(parsed)))
}

export function readStoredListPreviewFontSize(storage: Storage | undefined = typeof window !== 'undefined' ? window.localStorage : undefined): number {
  if (!storage) return LIST_PREVIEW_FONT_SIZE_DEFAULT
  return clampListPreviewFontSize(storage.getItem(LIST_PREVIEW_FONT_SIZE_STORAGE_KEY))
}

export function writeStoredListPreviewFontSize(value: number, storage: Storage | undefined = typeof window !== 'undefined' ? window.localStorage : undefined): void {
  if (!storage) return
  storage.setItem(LIST_PREVIEW_FONT_SIZE_STORAGE_KEY, String(clampListPreviewFontSize(value)))
}

export function listPreviewFontSizeRowHeightPadding(fontSize: number, viewMode: ViewMode, lineCount: number): number {
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
