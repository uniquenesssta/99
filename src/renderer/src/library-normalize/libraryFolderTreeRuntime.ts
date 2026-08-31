import type { FolderNode,FontItem,LibraryState,PhysicalFolderTreeResult } from '@shared/types'
import { folderBaseName,normalizeFolderPathForCompare,normalizePhysicalPathText } from './libraryNormalizeBase'
import { mergeAndPruneScannedFonts,pruneFontFolderIds } from './libraryNormalizeStateRuntime'
import { selectRendererFontHydrationWindow } from './libraryFontHydrationWindowRuntime'
import { ensureLibraryTagNamesContainFontTags } from '../fontTagStateAuthorityRuntime'

export function replacePathPrefixValue(value: string, oldPath: string, newPath: string): string {
  if (!value) return value

  const cleanValue = normalizePhysicalPathText(value)
  const cleanOld = normalizePhysicalPathText(oldPath)
  const cleanNew = normalizePhysicalPathText(newPath)
  const lowerValue = cleanValue.toLowerCase()
  const lowerOld = cleanOld.toLowerCase()

  if (lowerValue === lowerOld) return cleanNew
  if (lowerValue.startsWith(`${lowerOld}\\`)) return `${cleanNew}${cleanValue.slice(cleanOld.length)}`
  return value
}

export function replaceFolderPathInLibrary(state: LibraryState, oldPath: string, newPath: string): LibraryState {
  const folders = (state.folders || []).map((folder) => replacePathPrefixValue(folder, oldPath, newPath))
  const folderNodes = (state.folderNodes || []).map((node) => {
    const id = replacePathPrefixValue(node.id, oldPath, newPath)
    return {
      ...node,
      id,
      name: folderBaseName(id),
      parentId: replacePathPrefixValue(node.parentId, oldPath, newPath),
      rootPath: replacePathPrefixValue(node.rootPath, oldPath, newPath)
    }
  })

  const fonts = Object.fromEntries(
    Object.entries(state.fonts || {}).map(([id, font]) => {
      const path = replacePathPrefixValue(font.path, oldPath, newPath)
      return [
        id,
        path === font.path
          ? font
          : {
              ...font,
              path,
              fileName: folderBaseName(path),
              previewDisabled: false,
              previewError: undefined
            }
      ]
    })
  )

  const nextFontFolderIds = Object.fromEntries(
    Object.entries(state.fontFolderIds || {}).map(([fontId, ids]) => [
      fontId,
      Array.from(new Set(ids.map((id) => replacePathPrefixValue(id, oldPath, newPath))))
    ])
  )

  return {
    ...state,
    folders,
    folderAliases: {},
    folderNodes,
    fonts,
    fontFolderIds: pruneFontFolderIds(nextFontFolderIds, fonts, folders, folderNodes)
  }
}


export function normalizePhysicalFolderTree(tree: PhysicalFolderTreeResult): PhysicalFolderTreeResult {
  const folders = Array.from(new Set((tree.folders || []).map(normalizePhysicalPathText).filter(Boolean)))
  const nodes = (tree.nodes || []).map((node) => ({
    ...node,
    id: normalizePhysicalPathText(node.id),
    parentId: normalizePhysicalPathText(node.parentId),
    rootPath: normalizePhysicalPathText(node.rootPath),
  })).filter((node) => !!node.id && !!node.rootPath)
  return { ...tree, folders, nodes }
}

export function applyFolderTreeToLibrary(state: LibraryState, tree: PhysicalFolderTreeResult, scannedFonts?: FontItem[]): LibraryState {
  const normalizedTree = normalizePhysicalFolderTree(tree)
  const fonts = scannedFonts
    ? mergeAndPruneScannedFonts(state.fonts || {}, scannedFonts, state.folders?.length ? state.folders : normalizedTree.folders)
    : state.fonts || {}

  return ensureLibraryTagNamesContainFontTags({
    ...state,
    folders: normalizedTree.folders,
    folderAliases: {},
    folderNodes: normalizedTree.nodes,
    fonts,
    fontFolderIds: pruneFontFolderIds(state.fontFolderIds, fonts, normalizedTree.folders, normalizedTree.nodes)
  })
}

export function applyFolderCacheToLibrary(state: LibraryState, tree: PhysicalFolderTreeResult, cachedFonts: FontItem[], cacheFolders: string[]): LibraryState {
  const normalizedTree = normalizePhysicalFolderTree(tree)
  const foldersWithCache = cacheFolders.length ? cacheFolders.map(normalizePhysicalPathText) : []
  const rendererFonts = selectRendererFontHydrationWindow(cachedFonts, state.fonts || {})
  const fonts = foldersWithCache.length && rendererFonts.length
    ? mergeAndPruneScannedFonts(state.fonts || {}, rendererFonts, foldersWithCache)
    : state.fonts || {}

  return ensureLibraryTagNamesContainFontTags({
    ...state,
    folders: normalizedTree.folders,
    folderAliases: {},
    folderNodes: normalizedTree.nodes,
    fonts,
    fontFolderIds: pruneFontFolderIds(state.fontFolderIds, fonts, normalizedTree.folders, normalizedTree.nodes)
  })
}

export function parentFolderPath(folderPath: string): string {
  const clean = normalizePhysicalPathText(folderPath)
  const index = clean.lastIndexOf('\\')
  return index > -1 ? clean.slice(0, index) : ''
}

export function buildFolderTreeFromCachedFonts(folders: string[], fonts: FontItem[], existingNodes: FolderNode[] = []): PhysicalFolderTreeResult {
  const nodes: FolderNode[] = []
  const seen = new Set<string>()
  const existingCreatedAt = new Map(existingNodes.map((node) => [normalizeFolderPathForCompare(node.id), node.createdAt]))
  const rootByKey = new Map(folders.map((folder) => [normalizeFolderPathForCompare(folder), folder]))
  const rootKeys = Array.from(rootByKey.keys()).sort((a, b) => b.length - a.length)

  for (const font of fonts) {
    const fontPathKey = normalizeFolderPathForCompare(font.path)
    const rootKey = rootKeys.find((key) => fontPathKey.startsWith(`${key}\\`) || fontPathKey === key)
    if (!rootKey) continue

    const rootPath = rootByKey.get(rootKey) || rootKey
    const ancestors: string[] = []
    let current = parentFolderPath(font.path)

    while (current) {
      const currentKey = normalizeFolderPathForCompare(current)
      if (currentKey === rootKey) break
      if (!currentKey.startsWith(`${rootKey}\\`)) break
      ancestors.unshift(current)
      current = parentFolderPath(current)
    }

    let parentId = rootPath
    for (const folderPath of ancestors) {
      const key = normalizeFolderPathForCompare(folderPath)
      if (!seen.has(key)) {
        seen.add(key)
        nodes.push({
          id: folderPath,
          name: folderBaseName(folderPath),
          parentId,
          rootPath,
          createdAt: existingCreatedAt.get(key) || new Date().toISOString()
        })
      }
      parentId = folderPath
    }
  }

  return { folders, nodes }
}
