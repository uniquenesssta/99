import type { FolderNode,FontItem,LibraryState } from '@shared/types'
import { FONT_OBJECT_LRU_LIMIT } from '../appConstants'
import { createLegacyCollectionStateFields,normalizeLegacyCollectionIds } from '@shared/legacy/legacyCollectionCompatibility'
import { fontScripts } from '../fontClassification'
import { createEmptyLibrary,fontInsideRootFolder,isPhysicalFolderId,normalizeFontPathForCompare } from './libraryNormalizeBase'
import { ensureLibraryTagNamesContainFontTags,mergeFontWithTagAuthority } from '../fontTagStateAuthorityRuntime'

export function normalizeLibrary(state: LibraryState): LibraryState {
  const base = createEmptyLibrary()
  const fonts: Record<string, FontItem> = {}

  for (const [id, font] of Object.entries(state.fonts || {})) {
    fonts[id] = {
      ...font,
      tagNames: Array.isArray(font.tagNames) ? font.tagNames : [],
      localTagNames: Array.isArray(font.localTagNames) ? font.localTagNames : [],
      collectionIds: normalizeLegacyCollectionIds(font.collectionIds),
      scripts: fontScripts(font),
      systemInstalled: !!font.systemInstalled,
      systemInstallMatches: Array.isArray(font.systemInstallMatches) ? font.systemInstallMatches : [],
      active: false,
      systemImported: !!font.systemImported,
      deleteProtected: !!font.deleteProtected,
      previewDisabled: !!font.previewDisabled,
      previewError: font.previewError,
      activeSince: undefined
    }
  }

  return {
    ...base,
    ...state,
    fonts,
    folderAliases: state.folderAliases && typeof state.folderAliases === 'object' ? state.folderAliases : {},
    folderNodes: Array.isArray(state.folderNodes) ? state.folderNodes : [],
    fontFolderIds: state.fontFolderIds && typeof state.fontFolderIds === 'object' ? state.fontFolderIds : {},
    ...createLegacyCollectionStateFields(state),
    tags: Array.isArray(state.tags) ? state.tags : [],
    localTags: Array.isArray(state.localTags) ? state.localTags : [],
    previewMode: 'waterfall'
  }
}

export function markPartialLibrary(state: LibraryState): LibraryState {
  return { ...state, __partialFonts: true } as LibraryState
}

export function pruneRecordByKeyLimit<T>(record: Record<string, T>, limit: number, keepIds: Set<string>): Record<string, T> {
  const entries = Object.entries(record || {})
  if (entries.length <= limit) return record
  const kept = new Map<string, T>()
  for (const [id, value] of entries) {
    if (keepIds.has(id)) kept.set(id, value)
  }
  for (let index = entries.length - 1; index >= 0 && kept.size < limit; index -= 1) {
    const [id, value] = entries[index]
    if (!kept.has(id)) kept.set(id, value)
  }
  return Object.fromEntries(kept)
}

export function libraryWithMergedFonts(state: LibraryState, fonts: FontItem[], keepFontIds: string[] = []): LibraryState {
  if (!fonts.length) return state
  const keepIds = new Set(keepFontIds.filter(Boolean))
  for (const font of fonts) keepIds.add(font.id)

  const nextFonts = { ...(state.fonts || {}) }
  for (const font of fonts) {
    const existing = nextFonts[font.id]
    nextFonts[font.id] = existing
      ? {
          ...mergeFontWithTagAuthority(existing, font),
          favorite: !!font.favorite,
          collectionIds: normalizeLegacyCollectionIds(font.collectionIds),
          systemInstalled: !!font.systemInstalled,
          systemInstallMatches: font.systemInstallMatches || [],
          active: existing.active || font.active,
          activeSince: existing.active ? existing.activeSince || font.activeSince : font.activeSince,
          managedInstallPath: existing.active ? existing.managedInstallPath || font.managedInstallPath : font.managedInstallPath,
          managedRegistryName: existing.active ? existing.managedRegistryName || font.managedRegistryName : font.managedRegistryName,
          deleteProtected: !!font.deleteProtected,
          previewDisabled: existing.previewDisabled || font.previewDisabled,
          previewError: existing.previewError || font.previewError
        }
      : mergeFontWithTagAuthority(undefined, font)
  }

  for (const [id, font] of Object.entries(nextFonts)) {
    if (font.active || font.favorite || font.deleteProtected) keepIds.add(id)
  }

  return ensureLibraryTagNamesContainFontTags({ ...state, fonts: pruneRecordByKeyLimit(nextFonts, FONT_OBJECT_LRU_LIMIT, keepIds), __partialFonts: true } as LibraryState)
}

export function mergeScannedFonts(oldFonts: Record<string, FontItem>, scanned: FontItem[]): Record<string, FontItem> {
  const next = { ...oldFonts }
  const pathToId = new Map<string, string>()

  for (const [id, font] of Object.entries(next)) {
    pathToId.set(normalizeFontPathForCompare(font.path), id)
  }

  for (const item of scanned) {
    const matchedId = next[item.id] ? item.id : pathToId.get(normalizeFontPathForCompare(item.path))
    const existing = matchedId ? next[matchedId] : undefined
    const nextId = matchedId || item.id

    next[nextId] = existing
      ? {
          ...mergeFontWithTagAuthority(existing, item),
          id: nextId,
          favorite: !!item.favorite,
          collectionIds: normalizeLegacyCollectionIds(item.collectionIds),
          scripts: item.scripts?.length ? item.scripts : fontScripts(existing),
          systemInstalled: item.systemInstalled,
          systemInstallMatches: item.systemInstallMatches || [],
          active: existing.active || false,
          deleteProtected: !!item.deleteProtected,
          systemImported: existing.systemImported || item.systemImported || false,
          previewDisabled: existing.previewDisabled || item.previewDisabled || false,
          previewError: existing.previewError || item.previewError,
          activeSince: existing.activeSince
        }
      : {
          ...mergeFontWithTagAuthority(undefined, item),
          collectionIds: normalizeLegacyCollectionIds(item.collectionIds),
          scripts: item.scripts?.length ? item.scripts : fontScripts(item),
          systemInstalled: item.systemInstalled || false,
          systemInstallMatches: item.systemInstallMatches || [],
          active: false,
          deleteProtected: item.deleteProtected || false,
          systemImported: item.systemImported || false,
          previewDisabled: item.previewDisabled || false,
          previewError: item.previewError
        }

    pathToId.set(normalizeFontPathForCompare(item.path), nextId)
  }

  return next
}

export function mergeAndPruneScannedFonts(oldFonts: Record<string, FontItem>, scanned: FontItem[], watchedFolders: string[]): Record<string, FontItem> {
  const scannedPaths = new Set(scanned.map((font) => normalizeFontPathForCompare(font.path)))
  const merged = mergeScannedFonts(oldFonts, scanned)
  const next: Record<string, FontItem> = {}

  for (const [id, font] of Object.entries(merged)) {
    const insideWatchedFolder = (watchedFolders || []).some((folder) => fontInsideRootFolder(font, folder))
    if (insideWatchedFolder && !scannedPaths.has(normalizeFontPathForCompare(font.path))) continue
    next[id] = font
  }

  return next
}

export function pruneFontFolderIds(fontFolderIds: Record<string, string[]> | undefined, fonts: Record<string, FontItem>, folders: string[], folderNodes: FolderNode[]): Record<string, string[]> {
  const validFolderIds = new Set([...(folders || []), ...(folderNodes || []).map((node) => node.id)])
  const next: Record<string, string[]> = {}

  for (const [fontId, ids] of Object.entries(fontFolderIds || {})) {
    if (!fonts[fontId]) continue
    const font = fonts[fontId]
    const nextIds = ids.filter((id) => validFolderIds.has(id) && (!isPhysicalFolderId(id) || fontInsideRootFolder(font, id)))
    if (nextIds.length) next[fontId] = Array.from(new Set(nextIds))
  }

  return next
}
