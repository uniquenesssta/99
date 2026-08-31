import type { FontItem,LibraryState } from '@shared/types'
import type { Dispatch,MutableRefObject,SetStateAction } from 'react'
import type { FontMetrics } from '../../../appRuntime'

export type FontSystemActionRuntimeOptions = {
  hfm: typeof window.hfm
  library: LibraryState
  getCurrentLibrary: () => LibraryState
  getCurrentSelectedFontId: () => string
  selectedFontId: string
  activeOperationFontIds: MutableRefObject<Set<string>>
  setLibrary: Dispatch<SetStateAction<LibraryState>>
  setStatus: Dispatch<SetStateAction<string>>
  setSelectedFontIds: Dispatch<SetStateAction<string[]>>
  setSelectedFontId: Dispatch<SetStateAction<string>>
  setDetailVisible: Dispatch<SetStateAction<boolean>>
  setContextMenu: (value: null) => void
  setDatabaseFontMetrics: Dispatch<SetStateAction<FontMetrics | null>>
  refreshDatabaseDerivedState: () => void
  queueFavoriteWrite: (font: FontItem, favorite: boolean) => void
}

export type FontSystemStateRuntime = {
  updateFont: (fontId: string, updater: (font: FontItem) => FontItem) => void
  adjustDatabaseActiveCount: (delta: number) => void
  adjustDatabaseFavoriteCount: (delta: number) => void
  setFontActiveRuntime: (fontId: string, active: boolean, patch?: Partial<FontItem>) => void
  setFontsActiveRuntimeBulk: (updates: Record<string, { active: boolean; patch?: Partial<FontItem> }>) => void
  fontsForTag: (tagName: string, scope?: 'local' | 'shared') => FontItem[]
}

export type FontSystemActionRuntime = FontSystemStateRuntime & {
  toggleFontFavorite: (font: FontItem) => Promise<void>
  installFontByCard: (font: FontItem) => Promise<void>
  removeFontByCard: (font: FontItem) => Promise<void>
  deleteFontsBatch: (fonts: FontItem[], label: string) => Promise<void>
  uninstallFontsBatch: (fonts: FontItem[], label: string) => Promise<void>
  activateFontByCard: (font: FontItem) => Promise<void>
  activateFontsBatch: (fonts: FontItem[], label: string) => Promise<void>
  deactivateFontByCard: (font: FontItem) => Promise<void>
  deactivateFontsBatch: (fonts: FontItem[], label: string) => Promise<void>
}
