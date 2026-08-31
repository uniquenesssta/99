import type { FontItem,LibraryState } from '@shared/types'
import type React from 'react'
import type { Dispatch,SetStateAction } from 'react'
import { flushSync } from 'react-dom'
import { handleTagSuggestionInputKeyDown } from './fontTagInputRuntime'

export type FontDetailPanelRuntimeOptions = {
  selectedFont: FontItem | undefined
  detailVisible: boolean
  selectedFontId: string
  previewFamilies: Record<string, string>
  library: LibraryState
  setLibrary: React.Dispatch<React.SetStateAction<LibraryState>>
  setSelectedFontId: (fontId: string) => void
  setDetailVisible: (visible: boolean) => void
  setNativeDetailImage: (image: string) => void
  hfm: typeof window.hfm
  localTagSuggestions: string[]
  activeLocalTagSuggestionIndex: number
  assignTagName: string
  setActiveLocalTagSuggestionIndex: Dispatch<SetStateAction<number>>
  addTagToSelectedByName: (name: string) => void
  setAssignTagName: (value: string) => void
  sharedTagSuggestions: string[]
  activeSharedTagSuggestionIndex: number
  assignSharedTagName: string
  setActiveSharedTagSuggestionIndex: Dispatch<SetStateAction<number>>
  addSharedTagToSelectedByName: (name: string) => void
  setAssignSharedTagName: (value: string) => void
  installFontByCard: (font: FontItem) => Promise<void>
  removeFontByCard: (font: FontItem) => Promise<void>
  activateFontByCard: (font: FontItem) => Promise<void>
  deactivateFontByCard: (font: FontItem) => Promise<void>
}

export function createFontDetailPanelRuntime(options: FontDetailPanelRuntimeOptions): {
  selectedPreviewFamily: string
  closeDetail: () => void
  toggleFontDetail: (font: FontItem) => void
  generateDetailNativePreview: (font: FontItem) => Promise<void>
  setPreviewText: (value: string) => void
  handleLocalTagInputKeyDown: (event: React.KeyboardEvent<HTMLInputElement>) => void
  handleSharedTagInputKeyDown: (event: React.KeyboardEvent<HTMLInputElement>) => void
  installSelected: () => Promise<void>
  removeSelected: () => Promise<void>
  activateSelected: () => Promise<void>
  deactivateSelected: () => Promise<void>
} {
  return {
    selectedPreviewFamily: options.selectedFont ? options.previewFamilies[options.selectedFont.id] : '',

    closeDetail(): void {
      flushSync(() => {
        options.setSelectedFontId('')
        options.setDetailVisible(false)
      })
    },

    toggleFontDetail(font: FontItem): void {
      const closing = options.detailVisible && options.selectedFontId === font.id
      flushSync(() => {
        options.setSelectedFontId(closing ? '' : font.id)
        options.setDetailVisible(!closing)
      })
    },

    async generateDetailNativePreview(font: FontItem): Promise<void> {
      try {
        const image = await options.hfm.renderPreviewImage(font, options.library.previewText, 54, 760, 320)
        options.setNativeDetailImage(image)
      } catch {
        options.setNativeDetailImage('')
      }
    },

    setPreviewText(value: string): void {
      options.setLibrary((prev) => ({ ...prev, previewText: value }))
    },

    handleLocalTagInputKeyDown(event: React.KeyboardEvent<HTMLInputElement>): void {
      handleTagSuggestionInputKeyDown(event, {
        suggestions: options.localTagSuggestions,
        activeIndex: options.activeLocalTagSuggestionIndex,
        inputValue: options.assignTagName,
        setActiveIndex: options.setActiveLocalTagSuggestionIndex,
        addTagByName: options.addTagToSelectedByName,
        clearInput: () => options.setAssignTagName('')
      })
    },

    handleSharedTagInputKeyDown(event: React.KeyboardEvent<HTMLInputElement>): void {
      handleTagSuggestionInputKeyDown(event, {
        suggestions: options.sharedTagSuggestions,
        activeIndex: options.activeSharedTagSuggestionIndex,
        inputValue: options.assignSharedTagName,
        setActiveIndex: options.setActiveSharedTagSuggestionIndex,
        addTagByName: options.addSharedTagToSelectedByName,
        clearInput: () => options.setAssignSharedTagName('')
      })
    },

    async installSelected(): Promise<void> {
      if (!options.selectedFont) return
      await options.installFontByCard(options.selectedFont)
    },

    async removeSelected(): Promise<void> {
      if (!options.selectedFont) return
      await options.removeFontByCard(options.selectedFont)
    },

    async activateSelected(): Promise<void> {
      if (!options.selectedFont) return
      await options.activateFontByCard(options.selectedFont)
    },

    async deactivateSelected(): Promise<void> {
      if (!options.selectedFont) return
      await options.deactivateFontByCard(options.selectedFont)
    }
  }
}
