import { mergeFontUserIntent } from '../fontUserIntentRuntime'
import type { FontIndexChangePayload,FontItem,LibraryState } from '@shared/types'
import { buildFolderTreeFromCachedFonts } from './libraryFolderTreeRuntime'
import { normalizeFolderPathForCompare,normalizeFontPathForCompare } from './libraryNormalizeBase'
import { pruneFontFolderIds } from './libraryNormalizeStateRuntime'
import { ensureLibraryTagNamesContainFontTags,mergeFontTagsFromIncoming,mergeFontWithTagAuthority } from '../fontTagStateAuthorityRuntime'
import { applyEarlyVisibleFontIndexChangeToLibrary,isEarlyVisibleOnlyFontIndexChangePayload } from './libraryEarlyVisibleIndexChangeRuntime'

export function mergeIncrementalIndexedFont(oldFont: FontItem | undefined, nextFont: FontItem, source?: FontIndexChangePayload['source']): FontItem {
  if (!oldFont) return mergeFontWithTagAuthority(undefined, nextFont)
  // Physical-file snapshots cannot acknowledge user metadata or activation changes.
  if (source === 'watcher') {
    return {
      ...nextFont,
      ...mergeFontTagsFromIncoming(oldFont, oldFont),
      favorite: oldFont.favorite,
      collectionIds: oldFont.collectionIds,
      systemInstalled: oldFont.systemInstalled,
      systemInstallMatches: oldFont.systemInstallMatches,
      installStatusKnown: oldFont.installStatusKnown,
      active: oldFont.active,
      activeSince: oldFont.activeSince,
      managedInstallPath: oldFont.managedInstallPath,
      managedRegistryName: oldFont.managedRegistryName,
      deleteProtected: oldFont.deleteProtected,
      previewDisabled: oldFont.previewDisabled || nextFont.previewDisabled,
      previewError: oldFont.previewError || nextFont.previewError
    }
  }
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
  if (payload.source === 'shared-metadata' && payload.metadataFields?.length && !payload.deletes.length) {
    let fonts = state.fonts
    const upsertedFonts: FontItem[] = []
    for (const incoming of payload.upserts) {
      const current = fonts[incoming.id]
      if (!current || current.deleteProtected === incoming.deleteProtected) continue
      if (fonts === state.fonts) fonts = { ...fonts }
      const next = { ...current, deleteProtected: !!incoming.deleteProtected }
      fonts[incoming.id] = next
      upsertedFonts.push(next)
    }
    return { library: fonts === state.fonts ? state : { ...state, fonts }, removedIds: [], upsertedFonts }
  }
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

    const merged = mergeFontUserIntent(oldFont, mergeIncrementalIndexedFont(oldFont, font, payload.source))
    nextFonts[merged.id] = merged
    upsertedFonts.push(merged)
  }

  const nextFontFolderIds = { ...(state.fontFolderIds || {}) }
  for (const id of removedIds) delete nextFontFolderIds[id]

  const tree = buildFolderTreeFromCachedFonts(state.folders || [], Object.values(nextFonts), state.folderNodes || [])
  // Renderer fonts are a hydration window, not a complete directory inventory.
  // Only a physical tree refresh or an explicit folder operation may remove nodes.
  const folderNodes = new Map((state.folderNodes || []).map((node) => [normalizeFolderPathForCompare(node.id), node]))
  for (const node of tree.nodes) {
    const key = normalizeFolderPathForCompare(node.id)
    if (!folderNodes.has(key)) folderNodes.set(key, node)
  }
  const nextLibrary = ensureLibraryTagNamesContainFontTags({
    ...state,
    folderNodes: Array.from(folderNodes.values()),
    fonts: nextFonts,
    fontFolderIds: pruneFontFolderIds(nextFontFolderIds, nextFonts, state.folders || [], Array.from(folderNodes.values()))
  })

  return { library: nextLibrary, removedIds: Array.from(removedIds), upsertedFonts }
}
