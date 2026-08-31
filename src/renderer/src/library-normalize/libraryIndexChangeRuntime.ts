import type { FontIndexChangePayload,FontItem,LibraryState } from '@shared/types'
import { buildFolderTreeFromCachedFonts } from './libraryFolderTreeRuntime'
import { normalizeFolderPathForCompare,normalizeFontPathForCompare } from './libraryNormalizeBase'
import { pruneFontFolderIds } from './libraryNormalizeStateRuntime'
import { ensureLibraryTagNamesContainFontTags,mergeFontWithTagAuthority } from '../fontTagStateAuthorityRuntime'
import { applyEarlyVisibleFontIndexChangeToLibrary,isEarlyVisibleOnlyFontIndexChangePayload } from './libraryEarlyVisibleIndexChangeRuntime'

export function mergeIncrementalIndexedFont(oldFont: FontItem | undefined, nextFont: FontItem): FontItem {
  if (!oldFont) return mergeFontWithTagAuthority(undefined, nextFont)
  return {
    ...mergeFontWithTagAuthority(oldFont, nextFont),
    favorite: !!nextFont.favorite,
    collectionIds: nextFont.collectionIds || [],
    systemInstalled: !!nextFont.systemInstalled,
    systemInstallMatches: nextFont.systemInstallMatches || [],
    active: oldFont.active || nextFont.active,
    activeSince: oldFont.active ? oldFont.activeSince || nextFont.activeSince : nextFont.activeSince,
    managedInstallPath: oldFont.active ? oldFont.managedInstallPath || nextFont.managedInstallPath : nextFont.managedInstallPath,
    managedRegistryName: oldFont.active ? oldFont.managedRegistryName || nextFont.managedRegistryName : nextFont.managedRegistryName,
    deleteProtected: !!nextFont.deleteProtected,
    previewDisabled: oldFont.previewDisabled || nextFont.previewDisabled,
    previewError: oldFont.previewError || nextFont.previewError
  }
}

export function applyFontIndexChangeToLibrary(state: LibraryState, payload: FontIndexChangePayload): { library: LibraryState; removedIds: string[]; upsertedFonts: FontItem[] } {
  const watched = (state.folders || []).some((folder) => normalizeFolderPathForCompare(folder) === normalizeFolderPathForCompare(payload.folder))
  if (!watched) return { library: state, removedIds: [], upsertedFonts: [] }
  if (isEarlyVisibleOnlyFontIndexChangePayload(payload)) return applyEarlyVisibleFontIndexChangeToLibrary(state, payload)

  const nextFonts = { ...(state.fonts || {}) }
  const pathToId = new Map<string, string>()
  for (const [id, font] of Object.entries(nextFonts)) {
    pathToId.set(normalizeFontPathForCompare(font.path), id)
  }

  const removedIds = new Set<string>()
  for (const item of payload.deletes || []) {
    const id = item.id || pathToId.get(normalizeFontPathForCompare(item.path))
    if (id && nextFonts[id]) {
      delete nextFonts[id]
      removedIds.add(id)
    }

    const normalizedDeletedPath = normalizeFontPathForCompare(item.path)
    for (const [fontId, font] of Object.entries(nextFonts)) {
      if (normalizeFontPathForCompare(font.path) === normalizedDeletedPath) {
        delete nextFonts[fontId]
        removedIds.add(fontId)
      }
    }
  }

  const upsertedFonts: FontItem[] = []
  for (const font of payload.upserts || []) {
    const normalizedPath = normalizeFontPathForCompare(font.path)
    const oldId = pathToId.get(normalizedPath)
    const oldFont = oldId ? nextFonts[oldId] : nextFonts[font.id]
    if (oldId && oldId !== font.id) {
      delete nextFonts[oldId]
      removedIds.add(oldId)
    }

    const merged = mergeIncrementalIndexedFont(oldFont, font)
    nextFonts[merged.id] = merged
    upsertedFonts.push(merged)
  }

  const nextFontFolderIds = { ...(state.fontFolderIds || {}) }
  for (const id of removedIds) delete nextFontFolderIds[id]

  const tree = buildFolderTreeFromCachedFonts(state.folders || [], Object.values(nextFonts), state.folderNodes || [])
  const nextLibrary = ensureLibraryTagNamesContainFontTags({
    ...state,
    folderNodes: tree.nodes,
    fonts: nextFonts,
    fontFolderIds: pruneFontFolderIds(nextFontFolderIds, nextFonts, state.folders || [], tree.nodes)
  })

  return { library: nextLibrary, removedIds: Array.from(removedIds), upsertedFonts }
}
