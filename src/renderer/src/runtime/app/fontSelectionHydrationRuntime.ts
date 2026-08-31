import type { FontItem, LibraryState } from '@shared/types'
import type { Dispatch, SetStateAction } from 'react'
import { libraryWithMergedFonts } from '../../appRuntime'

export function hydrateFontForSelectionDetail(
  font: FontItem,
  setLibrary: Dispatch<SetStateAction<LibraryState>>
): void {
  if (!font?.id) return
  setLibrary((prev) => libraryWithMergedFonts(prev, [font], [font.id]))
}
