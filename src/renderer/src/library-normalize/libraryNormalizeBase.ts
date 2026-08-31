import type { FolderNode,FontItem,LibraryState,MoveFontFileResult } from '@shared/types'
import { DEFAULT_PREVIEW } from '../appConstants'
import { createLegacyCollectionStateFields } from '@shared/legacy/legacyCollectionCompatibility'

export function createEmptyLibrary(): LibraryState {
  return {
    folders: [],
    folderAliases: {},
    folderNodes: [],
    fontFolderIds: {},
    fonts: {},
    ...createLegacyCollectionStateFields(),
    tags: [],
    localTags: [],
    previewText: DEFAULT_PREVIEW,
    previewMode: 'waterfall'
  }
}

export function isDefinitelyBadFontRecord(font: FontItem): boolean {
  return font.fileName.startsWith('._') || font.path.includes('\\._') || font.path.includes('/._') || font.fileSize < 64 || !!font.previewError?.includes('字体文件不存在') || !!font.previewError?.includes('路径已失效')
}

export function normalizePhysicalPathText(value: string): string {
  let normalized = String(value || '').trim().replaceAll('/', '\\')
  normalized = normalized.replace(/^\\\\\?\\UNC\\/i, '\\\\')
  normalized = normalized.replace(/^\\\\\?\\/i, '')
  if (/^[a-zA-Z]:\\?$/.test(normalized)) return `${normalized.slice(0, 2)}\\`
  return normalized.replace(/\\+$/g, '')
}

export function normalizeFolderPathForCompare(value: string): string {
  return normalizePhysicalPathText(value).toLowerCase()
}

export function folderBaseName(folderPath: string): string {
  const clean = normalizePhysicalPathText(folderPath)
  return clean.split('\\').pop() || clean
}

export function makeVirtualFolderId(): string {
  return `vf_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

export function folderDisplayName(_library: LibraryState, folderId: string, fallbackName?: string): string {
  if (fallbackName) return fallbackName
  return folderBaseName(folderId)
}

export function fontInsideRootFolder(font: FontItem, rootPath: string): boolean {
  const root = normalizeFolderPathForCompare(rootPath)
  const file = normalizeFolderPathForCompare(font.path)
  return file === root || file.startsWith(`${root}\\`)
}

export function fontAssignedToFolder(library: LibraryState, font: FontItem, folderId: string): boolean {
  return !!library.fontFolderIds?.[font.id]?.includes(folderId)
}

export function fontBelongsToFolder(library: LibraryState, font: FontItem, folderId: string): boolean {
  if (library.folders.includes(folderId) || folderPhysicalPath(library, folderId)) {
    return fontInsideRootFolder(font, folderId) || fontAssignedToFolder(library, font, folderId)
  }

  return fontAssignedToFolder(library, font, folderId)
}

export function fontBelongsToAnyFolder(library: LibraryState, font: FontItem): boolean {
  if ((library.folders || []).some((folder) => fontInsideRootFolder(font, folder))) return true
  return !!library.fontFolderIds?.[font.id]?.length
}

export function folderDepth(library: LibraryState, folderId: string): number {
  let depth = 0
  let current = library.folderNodes?.find((node) => node.id === folderId)

  while (current && depth < 6) {
    depth += 1
    current = library.folderNodes?.find((node) => node.id === current?.parentId)
  }

  return depth
}

export function folderHasChildren(library: LibraryState, folderId: string): boolean {
  return (library.folderNodes || []).some((node) => node.parentId === folderId)
}

export function flattenFolderNodes(library: LibraryState, expandedFolderIds: Record<string, true> = {}): Array<FolderNode & { depth: number; hasChildren: boolean; expanded: boolean }> {
  const nodes = library.folderNodes || []
  const result: Array<FolderNode & { depth: number; hasChildren: boolean; expanded: boolean }> = []

  function visit(parentId: string, depth: number): void {
    if (!expandedFolderIds[parentId]) return

    nodes
      .filter((node) => node.parentId === parentId)
      .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))
      .forEach((node) => {
        const hasChildren = nodes.some((child) => child.parentId === node.id)
        const expanded = !!expandedFolderIds[node.id]
        result.push({ ...node, depth, hasChildren, expanded })
        if (expanded) visit(node.id, depth + 1)
      })
  }

  for (const root of library.folders || []) {
    visit(root, 1)
  }

  return result
}

export function isPhysicalFolderId(folderId: string): boolean {
  return !!folderId && !folderId.startsWith('vf_')
}

export function folderPhysicalPath(library: LibraryState, folderId: string): string {
  if (library.folders.includes(folderId)) return folderId
  const node = library.folderNodes?.find((item) => item.id === folderId)
  return node && isPhysicalFolderId(node.id) ? node.id : ''
}

export function normalizeFontPathForCompare(value: string): string {
  return normalizePhysicalPathText(value).toLowerCase()
}

export function updateMovedFontPath(font: FontItem, result: MoveFontFileResult): FontItem {
  if (!result.ok || !result.newPath) return font
  const normalized = normalizePhysicalPathText(result.newPath)
  return {
    ...font,
    path: normalized,
    fileName: normalized.split('\\').pop() || font.fileName,
    previewDisabled: false,
    previewError: undefined
  }
}
