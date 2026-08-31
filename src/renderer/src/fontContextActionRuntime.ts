import type { FontItem,LibraryState } from '@shared/types'
import type React from 'react'
import type { Dispatch,SetStateAction } from 'react'
import type { ContextMenuState,MenuTarget } from './appRuntime'
import { fontDisplayName } from './appRuntime'
import {
contextFontsFromLibrary,
createFolderContextMenuState,
createFontContextMenuState,
createTagContextMenuState
} from './fontContextMenuRuntime'
import { selectionLabel as buildSelectionLabel,singleFontSelection } from './fontSelectionRuntime'

export type FontContextActionRuntimeOptions = {
  library: LibraryState
  contextMenu: ContextMenuState
  selectedFontIds: string[]
  menuWidth: number
  menuMaxHeight: number
  viewport: Window
  setSelectedFontIds: Dispatch<SetStateAction<string[]>>
  setSelectionAnchorFontId: Dispatch<SetStateAction<string>>
  setSelectedFontId: Dispatch<SetStateAction<string>>
  setContextMenu: Dispatch<SetStateAction<ContextMenuState>>
  installFontByCard: (font: FontItem) => Promise<void>
  removeFontByCard: (font: FontItem) => Promise<void>
  activateFontByCard: (font: FontItem) => Promise<void>
  deactivateFontByCard: (font: FontItem) => Promise<void>
  activateFontsBatch: (fonts: FontItem[], label: string) => Promise<void>
  deactivateFontsBatch: (fonts: FontItem[], label: string) => Promise<void>
  deleteFontsBatch: (fonts: FontItem[], label: string) => Promise<void>
  toggleFontDeleteProtection: (fontIds: string[]) => Promise<void>
}

export function createFontContextActionRuntime(options: FontContextActionRuntimeOptions): {
  setSingleFontSelection: (fontId: string) => void
  selectionLabel: (fonts: FontItem[]) => string
  contextFontTargets: () => FontItem[]
  openTagMenu: (event: React.MouseEvent, tag: string) => void
  openSharedTagMenu: (event: React.MouseEvent, tag: string) => void
  openFolderMenu: (event: React.MouseEvent, target: Extract<MenuTarget, { kind: 'folder' }>) => void
  openFontMenu: (event: React.MouseEvent, font: FontItem) => void
  runFontContextAction: (action: 'install' | 'remove' | 'activate' | 'deactivate' | 'deleteFile' | 'protectToggle') => Promise<void>
} {
  const positionOptions = {
    menuWidth: options.menuWidth,
    menuMaxHeight: options.menuMaxHeight,
    viewport: options.viewport
  }

  function setSingleFontSelection(fontId: string): void {
    const next = singleFontSelection(fontId)
    options.setSelectedFontIds(next.selectedFontIds)
    options.setSelectionAnchorFontId(next.selectionAnchorFontId)
  }

  function contextFontTargets(): FontItem[] {
    return contextFontsFromLibrary(options.contextMenu, options.selectedFontIds, options.library.fonts)
  }

  return {
    setSingleFontSelection,

    selectionLabel(fonts: FontItem[]): string {
      return buildSelectionLabel(fonts, fontDisplayName)
    },

    contextFontTargets,

    openTagMenu(event: React.MouseEvent, tag: string): void {
      event.preventDefault()
      event.stopPropagation()
      options.setContextMenu(createTagContextMenuState(tag, 'local', event.clientX, event.clientY, positionOptions))
    },

    openSharedTagMenu(event: React.MouseEvent, tag: string): void {
      event.preventDefault()
      event.stopPropagation()
      options.setContextMenu(createTagContextMenuState(tag, 'shared', event.clientX, event.clientY, positionOptions))
    },

    openFolderMenu(event: React.MouseEvent, target: Extract<MenuTarget, { kind: 'folder' }>): void {
      event.preventDefault()
      event.stopPropagation()
      options.setContextMenu(createFolderContextMenuState(target, event.clientX, event.clientY, positionOptions))
    },

    openFontMenu(event: React.MouseEvent, font: FontItem): void {
      event.preventDefault()
      event.stopPropagation()

      if (!(options.selectedFontIds.length > 1 && options.selectedFontIds.includes(font.id))) {
        setSingleFontSelection(font.id)
      }

      options.setContextMenu(createFontContextMenuState(font, event.clientX, event.clientY, positionOptions))
    },

    async runFontContextAction(action: 'install' | 'remove' | 'activate' | 'deactivate' | 'deleteFile' | 'protectToggle'): Promise<void> {
      if (!options.contextMenu || options.contextMenu.kind !== 'font') return

      const targets = contextFontTargets()
      const font = targets[0]
      if (!font) return

      options.setSelectedFontId(font.id)
      options.setContextMenu(null)

      if (action === 'install') await options.installFontByCard(font)
      if (action === 'remove') await options.removeFontByCard(font)
      if (action === 'activate') {
        if (targets.length > 1) await options.activateFontsBatch(targets, '批量选择')
        else await options.activateFontByCard(font)
      }
      if (action === 'deactivate') {
        if (targets.length > 1) await options.deactivateFontsBatch(targets, '批量选择')
        else await options.deactivateFontByCard(font)
      }
      if (action === 'deleteFile') await options.deleteFontsBatch(targets.length > 1 ? targets : [font], targets.length > 1 ? '批量选择' : fontDisplayName(font))
      if (action === 'protectToggle') await options.toggleFontDeleteProtection(targets.length > 1 ? targets.map((item) => item.id) : [font.id])
    }
  }
}
