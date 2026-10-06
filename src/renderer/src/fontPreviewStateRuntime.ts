import { previewRecordForProbe } from '@shared/previewFailure'
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
  allowQueued?: boolean
  ready?: { family?: string; image?: string; loading: boolean }
  isBadFontRecord: (font: FontItem) => boolean
}): boolean {
  const { font, previewFamilies, nativePreviewImages, loadingFontIds, queuedPreviewFontIds, isBadFontRecord } = options
  if (font.fileAvailability === 'missing' || font.fileAvailability === 'unavailable') return false
  if (options.ready) {
    if (options.ready.family || options.ready.image || options.ready.loading) return false
  } else if (previewFamilies[font.id] || nativePreviewImages[font.id] || loadingFontIds.has(font.id)) return false
  if (!options.allowQueued && queuedPreviewFontIds.has(font.id)) return false
  if (isBadFontRecord(previewRecordForProbe(font))) return false
  return true
}

export function clearPreviewFailureFlagsInLibrary(library: LibraryState): { library: LibraryState; count: number } {
  let count = 0
  const fonts = Object.fromEntries(
    Object.entries(library.fonts || {}).map(([id, font]) => {
      if (font.fileAvailability === 'missing' || font.fileAvailability === 'unavailable') return [id, font]
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
