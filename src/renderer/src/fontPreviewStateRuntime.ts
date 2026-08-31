import type { FontItem,LibraryState } from '@shared/types'

export function createPreviewFamilyName(fontId: string): string {
  return `HFM_${fontId.replace(/[^a-zA-Z0-9]/g, '')}`
}

export function previewStateKeepIds(fontId: string, selectedFontId: string, selectedFontIds: string[]): Set<string> {
  return new Set([fontId, selectedFontId, ...selectedFontIds])
}

export function canQueuePreviewFont(options: {
  font: FontItem
  previewFamilies: Record<string, string>
  nativePreviewImages: Record<string, string>
  failedPreviewFontIds: Record<string, true>
  loadingFontIds: Set<string>
  queuedPreviewFontIds: Set<string>
  isBadFontRecord: (font: FontItem) => boolean
}): boolean {
  const { font, previewFamilies, nativePreviewImages, failedPreviewFontIds, loadingFontIds, queuedPreviewFontIds, isBadFontRecord } = options
  const forceNativePreview = !!font.systemInstalled || !!font.active || !!font.systemImported || (Array.isArray(font.systemInstallMatches) && font.systemInstallMatches.length > 0)
  if (previewFamilies[font.id] && !forceNativePreview) return false
  if (nativePreviewImages[font.id] && failedPreviewFontIds[font.id]) return false
  if (loadingFontIds.has(font.id)) return false
  if (queuedPreviewFontIds.has(font.id)) return false
  if (isBadFontRecord(font)) return false
  return true
}

export function clearPreviewFailureFlagsInLibrary(library: LibraryState): { library: LibraryState; count: number } {
  let count = 0
  const fonts = Object.fromEntries(
    Object.entries(library.fonts || {}).map(([id, font]) => {
      if (font.previewDisabled || font.previewError) count += 1
      return [
        id,
        {
          ...font,
          previewDisabled: false,
          previewError: undefined
        }
      ]
    })
  )
  return { library: { ...library, fonts }, count }
}

export function removeBadFontRecordsFromLibrary(
  library: LibraryState,
  isBadFontRecord: (font: FontItem) => boolean
): { library: LibraryState; removed: number } {
  let removed = 0
  const nextFonts: Record<string, FontItem> = {}
  for (const [id, font] of Object.entries(library.fonts || {})) {
    if (isBadFontRecord(font)) {
      removed += 1
      continue
    }
    nextFonts[id] = font
  }
  return { library: { ...library, fonts: nextFonts }, removed }
}
