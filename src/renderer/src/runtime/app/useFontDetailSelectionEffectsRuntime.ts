import type { FontItem, LibraryState } from '@shared/types'
import { useEffect } from 'react'
import type { Dispatch, SetStateAction } from 'react'

export function useFontDetailSelectionEffectsRuntime(options: {
  library: LibraryState
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
    const validIds = new Set(Object.keys(library.fonts || {}))
    setSelectedFontIds((prev) => prev.filter((id) => validIds.has(id)))
  }, [library.fonts])

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
