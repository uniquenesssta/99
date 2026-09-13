import type { FontItem, FontFormat, FontScript, LibraryState, FontQueryPageResult, FontQueryResult } from '@shared/types'
import type { SidebarPage, ActiveFilter, FilterGroupId, FontCategory, MenuTarget, DeveloperStatusEntry, flattenFolderNodes } from '../../appRuntime'
import type { DragEvent, MouseEvent } from 'react'

export type AppSidebarProps = {
  sidebarCollapsed: boolean
  setSidebarCollapsed: (value: boolean) => void
  sidebarPage: SidebarPage
  setSidebarPage: (value: SidebarPage) => void
  activeFilter: ActiveFilter
  setActiveFilter: (value: ActiveFilter) => void
  advancedFilterCount: number
  refreshDeveloperStatusDetails: () => Promise<void>
  categoryCounts: Record<string, number>
  allFonts: FontItem[]
  favoriteCount: number
  installedCount: number
  notInstalledCount: number
  activeCount: number
  previewText: string
  setPreviewText: (value: string) => void
  installStatusReady: boolean
  installStatusMissingCount: number
  installStatusSyncSuffix: string
  expandedFilterGroups: Partial<Record<FilterGroupId, true>>
  setFilterGroupExpanded: (groupId: FilterGroupId, expanded: boolean) => void
  selectedWatchedFolders: string[]
  setSelectedWatchedFolders: (updater: (prev: string[]) => string[]) => void
  library: LibraryState
  folderCounts: Record<string, number>
  selectedFormats: FontFormat[]
  setSelectedFormats: (updater: (prev: FontFormat[]) => FontFormat[]) => void
  formatCounts: Record<string, number>
  selectedScripts: FontScript[]
  setSelectedScripts: (updater: (prev: FontScript[]) => FontScript[]) => void
  scriptCounts: Record<string, number>
  selectedCategory: FontCategory
  setSelectedCategory: (value: FontCategory) => void
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
  setDatabasePageResult: (value: FontQueryPageResult | null) => void
  setDatabaseQueryResult: (value: FontQueryResult | null) => void
  setSelectedFolderId: (value: string) => void
  expandedFolderIds: Record<string, true>
  dropHoverFolderId: string
  setDropHoverFolderId: (value: string) => void
  selectFolderFilter: (folderId: string) => void
  openFolderMenu: (event: MouseEvent, target: Extract<MenuTarget, { kind: 'folder' }>) => void
  fontIdsFromDropEvent: (event: DragEvent) => string[]
  assignFontsToFolder: (fontIds: string[], folderId: string) => Promise<void>
  toggleFolderExpanded: (folderId: string) => void
  flatFolderNodes: ReturnType<typeof flattenFolderNodes>
  setDeveloperStatusLog: (entries: DeveloperStatusEntry[]) => void
}
