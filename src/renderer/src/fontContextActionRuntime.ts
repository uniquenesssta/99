import { createFontCommandRuntime } from './fontCommandRuntime'
import type { FontCommand, FontCommandOptions, RunFontCommand } from './fontCommandRuntime'
import { isPartialFontLibrary } from './fontCommandTargetsRuntime'
import { activationEntryTrace, traceActivationEntry } from './fontActivationTrace'
import { reportFontOperation } from './fontOperationTrace'
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

export type FontContextActionRuntimeOptions = FontCommandOptions & {
  library: LibraryState
  contextMenu: ContextMenuState
  selectedFontIds: string[]
  getVisibleFonts?: () => FontItem[]
  setStatus: (status: string) => void
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
  toggleFontDeleteProtection: (fontIds: string[], protect?: boolean, available?: FontItem[]) => Promise<void>
}

export function createFontContextActionRuntime(options: FontContextActionRuntimeOptions): {
  setSingleFontSelection: (fontId: string) => void
  selectionLabel: (fonts: FontItem[]) => string
  contextFontTargets: (available?: FontItem[]) => FontItem[]
  openTagMenu: (event: React.MouseEvent, tag: string) => void
  openSharedTagMenu: (event: React.MouseEvent, tag: string) => void
  openFolderMenu: (event: React.MouseEvent, target: Extract<MenuTarget, { kind: 'folder' }>) => void
  openFontMenu: (event: React.MouseEvent, font: FontItem) => void
  contextTargetCount: number
  runFontCommand: RunFontCommand
  runFontContextAction: (action: FontCommand) => Promise<void>
} {
  const contextIds = options.contextMenu?.kind === 'font' ? (options.selectedFontIds.includes(options.contextMenu.font.id) ? options.selectedFontIds : [options.contextMenu.font.id]) : []
  const runFontCommand = createFontCommandRuntime(options)
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

  function contextFontTargets(available = options.getVisibleFonts?.() || []): FontItem[] {
    return contextFontsFromLibrary(options.contextMenu, options.selectedFontIds, options.library.fonts, available, isPartialFontLibrary(options.library))
  }

  return {
    setSingleFontSelection,
    runFontCommand,
    contextTargetCount: new Set(contextIds).size,

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

    async runFontContextAction(action: FontCommand): Promise<void> {
      if (!options.contextMenu || options.contextMenu.kind !== 'font') {
        if (action === 'activate') {
          const empty = traceActivationEntry([], 'font-context', options.selectedFontIds.length)
          reportFontOperation({ trace: activationEntryTrace(empty), stage: 'route', outcome: 'missing-context' })
        }
        return
      }

      const ids = contextIds
      const font = options.contextMenu.font
      options.setSelectedFontId(font.id)
      options.setContextMenu(null)
      await runFontCommand(action, ids, [font], 'font-context')
    }
  }
}
