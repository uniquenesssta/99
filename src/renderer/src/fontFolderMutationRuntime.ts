import type { FontItem,LibraryState,MoveFontFileResult } from '@shared/types'
import type { MenuTarget } from './appTypes'
import { folderPhysicalPath,fontInsideRootFolder,updateMovedFontPath } from './libraryNormalize'

export type FolderMenuTarget = Extract<MenuTarget, { kind: 'folder' }>

export interface RemoveFolderTargetPlan {
  childIds: Set<string>
  removedFontIds: Set<string>
}

export function fontIdsFromDragDataTransfer(dataTransfer: DataTransfer, fallbackFontId = ''): string[] {
  const batchText = dataTransfer.getData('application/x-hfm-font-ids')
  if (batchText) {
    try {
      const parsed = JSON.parse(batchText)
      if (Array.isArray(parsed)) return parsed.filter((id): id is string => typeof id === 'string' && !!id)
    } catch {
      // ignore malformed drag payload
    }
  }

  const single = dataTransfer.getData('application/x-hfm-font-id') || fallbackFontId
  return single ? [single] : []
}

export function createRemoveFolderTargetPlan(library: LibraryState, target: FolderMenuTarget): RemoveFolderTargetPlan {
  const childIds = new Set<string>([target.id])
  let changed = true

  while (changed) {
    changed = false
    for (const node of library.folderNodes || []) {
      if (childIds.has(node.parentId) && !childIds.has(node.id)) {
        childIds.add(node.id)
        changed = true
      }
    }
  }

  const removedPhysicalFolders = Array.from(childIds)
    .map((id) => folderPhysicalPath(library, id))
    .filter(Boolean)

  const removedFontIds = new Set(
    Object.values(library.fonts || {})
      .filter((font) => !font.systemImported && removedPhysicalFolders.some((folder) => fontInsideRootFolder(font, folder)))
      .map((font) => font.id)
  )

  return { childIds, removedFontIds }
}

export function removeFolderTargetFromLibrary(
  library: LibraryState,
  target: FolderMenuTarget,
  plan: RemoveFolderTargetPlan
): LibraryState {
  const nextFontFolderIds: Record<string, string[]> = {}
  for (const [fontId, ids] of Object.entries(library.fontFolderIds || {})) {
    if (plan.removedFontIds.has(fontId)) continue
    const nextIds = ids.filter((id) => !plan.childIds.has(id))
    if (nextIds.length) nextFontFolderIds[fontId] = nextIds
  }

  const nextFonts = Object.fromEntries(
    Object.entries(library.fonts || {}).filter(([id]) => !plan.removedFontIds.has(id))
  )

  if (!target.virtual) {
    const nextAliases = { ...(library.folderAliases || {}) }
    delete nextAliases[target.id]
    return {
      ...library,
      folders: (library.folders || []).filter((folder) => folder !== target.id),
      folderAliases: nextAliases,
      folderNodes: (library.folderNodes || []).filter((node) => !plan.childIds.has(node.id)),
      fonts: nextFonts,
      fontFolderIds: nextFontFolderIds
    }
  }

  return {
    ...library,
    folderNodes: (library.folderNodes || []).filter((node) => !plan.childIds.has(node.id)),
    fonts: nextFonts,
    fontFolderIds: nextFontFolderIds
  }
}

export function applyMovedFontToLibrary(
  library: LibraryState,
  fontId: string,
  result: MoveFontFileResult
): LibraryState {
  const nextFonts = { ...library.fonts }
  const nextFontFolderIds = { ...(library.fontFolderIds || {}) }
  if (nextFonts[fontId]) {
    nextFonts[fontId] = updateMovedFontPath(nextFonts[fontId], result)
  }
  delete nextFontFolderIds[fontId]

  return {
    ...library,
    fonts: nextFonts,
    fontFolderIds: nextFontFolderIds
  }
}

export function applyMovedFontsToLibrary(
  library: LibraryState,
  movedUpdates: Array<{ id: string; result: MoveFontFileResult }>
): LibraryState {
  const nextFonts = { ...library.fonts }
  const nextFontFolderIds = { ...(library.fontFolderIds || {}) }
  for (const update of movedUpdates) {
    if (nextFonts[update.id]) {
      nextFonts[update.id] = updateMovedFontPath(nextFonts[update.id], update.result)
    }
    delete nextFontFolderIds[update.id]
  }
  return { ...library, fonts: nextFonts, fontFolderIds: nextFontFolderIds }
}

export function removeFontsFromLibrary(library: LibraryState, fontIds: string[]): LibraryState {
  const removed = new Set(fontIds)
  const nextFonts = { ...library.fonts }
  const nextFontFolderIds = { ...(library.fontFolderIds || {}) }
  for (const id of removed) {
    delete nextFonts[id]
    delete nextFontFolderIds[id]
  }
  return { ...library, fonts: nextFonts, fontFolderIds: nextFontFolderIds }
}

export function uniqueFontsById(fonts: FontItem[]): FontItem[] {
  return Array.from(new Map(fonts.map((font) => [font.id, font])).values())
}
