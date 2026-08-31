import type { DragEvent, MouseEvent } from 'react'

export type AppSidebarProps = {
  sidebarCollapsed: boolean
  setSidebarCollapsed: (value: boolean) => void
  sidebarPage: any
  setSidebarPage: (value: any) => void
  activeFilter: any
  setActiveFilter: (value: any) => void
  advancedFilterCount: number
  refreshDeveloperStatusDetails: () => Promise<void>
  categoryCounts: Record<string, number>
  allFonts: unknown[]
  favoriteCount: number
  installedCount: number
  notInstalledCount: number
  activeCount: number
  previewText: string
  setPreviewText: (value: string) => void
  installStatusReady: boolean
  installStatusMissingCount: number
  installStatusSyncSuffix: string
  expandedFilterGroups: any
  setFilterGroupExpanded: (groupId: any, expanded: boolean) => void
  selectedWatchedFolders: string[]
  setSelectedWatchedFolders: (updater: (prev: string[]) => string[]) => void
  library: any
  folderCounts: Record<string, number>
  selectedFormats: any[]
  setSelectedFormats: (updater: (prev: any[]) => any[]) => void
  formatCounts: Record<string, number>
  selectedScripts: any[]
  setSelectedScripts: (updater: (prev: any[]) => any[]) => void
  scriptCounts: Record<string, number>
  selectedCategory: any
  setSelectedCategory: (value: any) => void
  clearAdvancedFilters: () => void
  newSharedTagName: string
  setNewSharedTagName: (value: string) => void
  createSharedTagOnlyFromInput: () => void
  sharedTagList: string[]
  selectedSharedTagName: string
  setSelectedSharedTagName: (value: string) => void
  openSharedTagMenu: (event: MouseEvent, tag: string) => void
  sharedTagCounts: Record<string, number>
  newTagName: string
  setNewTagName: (value: string) => void
  createTagOnlyFromInput: () => void
  localTagList: string[]
  selectedTagName: string
  setSelectedTagName: (value: string) => void
  openTagMenu: (event: MouseEvent, tag: string) => void
  localTagCounts: Record<string, number>
  addFolder: () => Promise<void>
  selectedFolderId: string
  setDatabasePageResult: (value: any) => void
  setDatabaseQueryResult: (value: any) => void
  setSelectedFolderId: (value: string) => void
  expandedFolderIds: Record<string, true>
  dropHoverFolderId: string
  setDropHoverFolderId: (value: string) => void
  selectFolderFilter: (folderId: string) => void
  openFolderMenu: (event: MouseEvent, target: any) => void
  fontIdsFromDropEvent: (event: DragEvent) => string[]
  assignFontsToFolder: (fontIds: string[], folderId: string) => Promise<void>
  toggleFolderExpanded: (folderId: string) => void
  flatFolderNodes: any[]
  setDeveloperStatusLog: (entries: any[]) => void
}
