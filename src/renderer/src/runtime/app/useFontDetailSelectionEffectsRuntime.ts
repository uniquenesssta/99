import { isPartialFontLibrary } from '../../fontCommandTargetsRuntime'
import { libraryWithMergedFonts } from '../../appRuntime'
import type { FontItem, LibraryState } from '@shared/types'
import { useEffect } from 'react'
import type { Dispatch, SetStateAction } from 'react'

export function useFontDetailSelectionEffectsRuntime(options: {
  library: LibraryState
  selectedFontIds: string[]
  setLibrary: Dispatch<SetStateAction<LibraryState>>
  visibleFonts: FontItem[]
  selectedFontId: string
  selectedFont: FontItem | undefined
  detailVisible: boolean
  setSelectedFontIds: Dispatch<SetStateAction<string[]>>
  setSelectedFontId: Dispatch<SetStateAction<string>>
  requestPreviewFont: (font: FontItem, priority?: 'normal' | 'high') => void
  isBadFontRecord: (font: FontItem) => boolean
}): void {
  const {
    library,
    visibleFonts,
    selectedFontId,
    selectedFont,
    detailVisible,
    setSelectedFontIds,
    setSelectedFontId,
    requestPreviewFont,
    isBadFontRecord
  } = options

  useEffect(() => {
    // A partial cache miss is not deletion. Explicit index/delete events still remove IDs.
    if (!isPartialFontLibrary(library)) {
      const validIds = new Set(Object.keys(library.fonts || {}))
      setSelectedFontIds((prev) => prev.some(id => !validIds.has(id)) ? prev.filter((id) => validIds.has(id)) : prev)
      return
    }
    const selected = new Set(options.selectedFontIds)
    const missing = visibleFonts.filter(font => selected.has(font.id) && !library.fonts[font.id])
    if (missing.length) options.setLibrary(prev => {
      // Do not restore an item removed by a newer authoritative snapshot.
      if (!isPartialFontLibrary(prev)) return prev
      const absent = missing.filter(font => !prev.fonts[font.id])
      return absent.length ? libraryWithMergedFonts(prev, absent, options.selectedFontIds) : prev
    })
  }, [library.fonts, isPartialFontLibrary(library), options.selectedFontIds, visibleFonts])

  useEffect(() => {
    if (!selectedFontId && visibleFonts[0]) {
      setSelectedFontId(visibleFonts[0].id)
    }
  }, [visibleFonts, selectedFontId])

  useEffect(() => {
    if (detailVisible && selectedFont && !isBadFontRecord(selectedFont)) {
      requestPreviewFont(selectedFont, 'high')
    }
  }, [selectedFont?.id, detailVisible])
}
