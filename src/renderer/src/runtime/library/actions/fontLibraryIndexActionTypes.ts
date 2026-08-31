import type { CacheStats,FontItem,FontQueryPageResult,FontQueryResult,LibraryState,PhysicalFolderTreeResult,ScanResult } from '@shared/types'
import type { Dispatch,MutableRefObject,SetStateAction } from 'react'
import type { FontMetrics,FontScrollRestoreSnapshot,MenuTarget } from '../../../appRuntime'

export type FontLibraryIndexActionRuntimeOptions = {
  hfm: typeof window.hfm
  library: LibraryState
  selectedFolderId: string
  autoInstallStatusRefreshStartedRef: MutableRefObject<boolean>
  knownInstallStatusIds: MutableRefObject<Set<string>>
  setLibrary: Dispatch<SetStateAction<LibraryState>>
  getCurrentLibrary: () => LibraryState
  commitLibraryUpdate: (update: SetStateAction<LibraryState>) => LibraryState
  setStatus: Dispatch<SetStateAction<string>>
  setCacheStats: Dispatch<SetStateAction<CacheStats | null>>
  setContextMenu: (value: null) => void
  setSelectedFolderId: Dispatch<SetStateAction<string>>
  setDatabasePageResult: Dispatch<SetStateAction<FontQueryPageResult | null>>
  setDatabaseQueryResult: Dispatch<SetStateAction<FontQueryResult | null>>
  setDatabaseFontMetrics: Dispatch<SetStateAction<FontMetrics | null>>
  setDatabaseRefreshToken: Dispatch<SetStateAction<number>>
  setIndexingActive: Dispatch<SetStateAction<boolean>>
  setFailedPreviewFontIds: Dispatch<SetStateAction<Record<string, true>>>
  setNativePreviewImages: Dispatch<SetStateAction<Record<string, string>>>
  setNativeDetailImage: Dispatch<SetStateAction<string>>
  nextIndexOperationRunId: () => number
  isCurrentIndexOperation: (runId: number) => boolean
  captureFontScrollSnapshot: () => FontScrollRestoreSnapshot
  restoreFontScrollSnapshot: (snapshot: FontScrollRestoreSnapshot) => void
  saveLibraryImmediately: (nextLibrary: LibraryState) => Promise<boolean>
  stopLazyInstallStatusDetect: () => void
  startBackgroundInstallStatusRefresh: (prefix?: string, options?: { force?: boolean }) => Promise<void>
  resetPreviewRuntimeState: () => void
  isBadFontRecord: (font: FontItem) => boolean
}

export type FontLibraryIndexSharedRuntime = {
  invalidateDatabasePages: () => void
  loadCacheStats: () => Promise<void>
  readPhysicalFolderTree: (folders: string[]) => Promise<PhysicalFolderTreeResult>
  finishIndexingWithoutFullInstallRefresh: (statusText: string) => Promise<void>
  isCancelledScanResult: (result: ScanResult) => boolean
}

export type FontLibraryIndexActionRuntime = FontLibraryIndexSharedRuntime & {
  clearAllCacheAction: () => Promise<void>
  loadSharedCacheForFolders: (folders: string[], keepScroll?: boolean) => Promise<ScanResult | null>
  addFolder: () => Promise<void>
  readSharedCache: () => Promise<void>
  cancelIndexing: () => Promise<void>
  rescan: () => Promise<void>
  rebuildScanCache: () => Promise<void>
  scanInstalledFontsIntoLibrary: () => Promise<void>
  scanAllFonts: () => Promise<void>
  clearPreviewCacheAction: () => Promise<void>
  refreshWatchedFolders: () => Promise<void>
  refreshFolderTarget: (target: Extract<MenuTarget, { kind: 'folder' }>) => Promise<void>
}
