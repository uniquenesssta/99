import type { FontItem } from './fontTypes'
import type { FontCollection } from './legacyCollectionTypes'

export interface FolderNode {
  id: string
  name: string
  parentId: string
  rootPath: string
  createdAt: string
}

export interface LibraryState {
  folders: string[]
  folderAliases?: Record<string, string>
  folderNodes?: FolderNode[]
  fontFolderIds?: Record<string, string[]>
  fonts: Record<string, FontItem>
  collections: FontCollection[]
  tags: string[]
  localCollections?: FontCollection[]
  localTags?: string[]
  __localTagAuthorityKnown?: boolean
  __sharedTagAuthorityKnown?: boolean
  previewText: string
  previewMode: 'list' | 'waterfall'
}

export type LibraryShell = Omit<LibraryState, 'fonts' | 'fontFolderIds'> & {
  fonts: Record<string, never>
  fontFolderIds?: Record<string, never>
  totalFonts: number
}

export interface PhysicalFolderTreeResult {
  folders: string[]
  nodes: FolderNode[]
}

export interface FolderCacheRepairStatus {
  cache: 'index' | 'preview'
  path: string
  ok: boolean
  repaired: boolean
  message: string
}
