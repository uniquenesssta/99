import type { FontItem,FontQueryRequest,SystemInstalledFont } from '../../shared/types'
import type { FontSearchCategory } from './fontSearchRuntime'

export type FontQueryResultCacheEntry = { at: number; items: FontItem[] }

export type FontMemoryQueryRuntimeOptions = {
  resultCacheMax: number
  resultCacheTtlMs: number
  appWatchedFolders: () => Promise<string[]>
  loadSharedFontsForFolders: (folders: string[]) => Promise<FontItem[]>
  loadSharedFontsForFoldersFresh?: (folders: string[]) => Promise<FontItem[]>
  hydrateLocalTagsForFonts: (items: FontItem[]) => Promise<FontItem[]>
  hydrateInstallStatusForFonts: (items: FontItem[]) => Promise<FontItem[]>
  normalizePathForCacheCompare: (filePath: string) => string
  isSystemInstalledRecord: (record: SystemInstalledFont) => boolean
  isPathInWindowsFonts: (filePath: string) => boolean
  inferFontSearchCategory: (font: FontItem) => FontSearchCategory
}
