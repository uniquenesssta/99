import type { FontItem, LibraryState } from '@shared/types'
import type { Dispatch, SetStateAction } from 'react'
import { libraryWithMergedFonts } from '../../appRuntime'

export function hydrateFontForSelectionDetail(
  font: FontItem,
  setLibrary: Dispatch<SetStateAction<LibraryState>>,
  keepFontIds: string[] = []
): void {
  if (!font?.id) return
  setLibrary((prev) => libraryWithMergedFonts(prev, [prev.fonts[font.id] || font], [...keepFontIds, font.id]))
}
