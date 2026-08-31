import type { FontItem } from '@shared/types'
import type { ContextMenuState,EditableMenuTarget,MenuTarget } from './appTypes'
import { clampContextMenuPosition } from './fontSelectionRuntime'

export interface ContextMenuPositionOptions {
  menuWidth: number
  menuMaxHeight: number
  viewport: { innerWidth: number; innerHeight: number }
}

function positionedContextMenu<T extends MenuTarget>(
  target: T,
  clientX: number,
  clientY: number,
  options: ContextMenuPositionOptions
): { x: number; y: number } & T {
  const point = clampContextMenuPosition(clientX, clientY, options.menuWidth, options.menuMaxHeight, options.viewport)
  return {
    ...target,
    x: point.x,
    y: point.y
  }
}

export function createTagContextMenuState(
  tag: string,
  scope: 'local' | 'shared',
  clientX: number,
  clientY: number,
  options: ContextMenuPositionOptions
): NonNullable<ContextMenuState> {
  return positionedContextMenu({ kind: 'tag', name: tag, scope }, clientX, clientY, options)
}

export function createFolderContextMenuState(
  target: Extract<MenuTarget, { kind: 'folder' }>,
  clientX: number,
  clientY: number,
  options: ContextMenuPositionOptions
): NonNullable<ContextMenuState> {
  return positionedContextMenu(target, clientX, clientY, options)
}

export function createFontContextMenuState(
  font: FontItem,
  clientX: number,
  clientY: number,
  options: ContextMenuPositionOptions
): NonNullable<ContextMenuState> {
  return positionedContextMenu({ kind: 'font', font }, clientX, clientY, options)
}

export function editableTargetFromContextMenu(contextMenu: ContextMenuState): EditableMenuTarget | null {
  if (!contextMenu || contextMenu.kind === 'font') return null
  return contextMenu.kind === 'folder'
    ? { kind: 'folder', id: contextMenu.id, name: contextMenu.name, rootPath: contextMenu.rootPath, virtual: contextMenu.virtual }
    : { kind: 'tag', name: contextMenu.name, scope: contextMenu.scope }
}

export function folderTargetFromContextMenu(contextMenu: ContextMenuState): Extract<MenuTarget, { kind: 'folder' }> | null {
  if (!contextMenu || contextMenu.kind !== 'folder') return null
  return { kind: 'folder', id: contextMenu.id, name: contextMenu.name, rootPath: contextMenu.rootPath, virtual: contextMenu.virtual }
}

export function tagBatchActionFromContextMenu(contextMenu: ContextMenuState): {
  name: string
  scope: 'local' | 'shared'
  label: string
} | null {
  if (!contextMenu || contextMenu.kind !== 'tag') return null
  return {
    name: contextMenu.name,
    scope: contextMenu.scope,
    label: `${contextMenu.scope === 'shared' ? '共享标签' : '标签'}“${contextMenu.name}”`
  }
}

export function contextFontsFromLibrary(
  contextMenu: ContextMenuState,
  selectedFontIds: string[],
  fonts: Record<string, FontItem>
): FontItem[] {
  if (!contextMenu || contextMenu.kind !== 'font') return []
  const liveFont = fonts[contextMenu.font.id] || contextMenu.font
  if (selectedFontIds.length > 1 && selectedFontIds.includes(liveFont.id)) {
    return selectedFontIds
      .map((id) => fonts[id])
      .filter((font): font is FontItem => !!font)
  }
  return [liveFont]
}
