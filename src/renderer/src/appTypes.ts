import type { FontFormat,FontItem,FontScript,FontTagBatchItem } from '@shared/types'
import type React from 'react'

export type FilterKind = 'all' | 'favorites' | 'installed' | 'notInstalled' | 'active' | 'systemBuiltin' | 'cleanSystem' | 'format' | 'script' | 'collection' | 'tag' | 'sharedTag'

export type SidebarPage = 'library' | 'filters' | 'tags' | 'sharedTags' | 'folders' | 'developer'
export type TimeSortMode = 'created' | 'modified' | 'custom'
export type SortMode = 'smart' | 'nameAsc' | 'nameDesc' | 'createdDesc' | 'createdAsc' | 'modifiedDesc' | 'modifiedAsc' | 'sizeDesc' | 'sizeAsc'
export type ViewMode = 'comfortable' | 'compact' | 'large'
export type CardPoolViewMode = 'grid' | 'list' | 'family'
export type InstallStatusFilter = 'all' | 'installed' | 'notInstalled'
export type ThemeMode = 'dark' | 'light'
export type FilterGroupId = 'watchedFolders' | 'formats' | 'scripts' | 'category'
export type FontCategory = 'all' | 'serif' | 'slabSerif' | 'sansSerif' | 'script' | 'monospace' | 'handwriting' | 'hei' | 'art'
export type PageToolbarState = {
  search: string
  installStatus: InstallStatusFilter
  timeSortMode: TimeSortMode
  sortMode: SortMode
  viewMode: ViewMode
}

export type MenuTarget =
  | { kind: 'tag'; name: string; scope: 'local' | 'shared' }
  | { kind: 'folder'; id: string; name: string; rootPath: string; virtual: boolean }
  | { kind: 'font'; font: FontItem }

export type EditableMenuTarget = Exclude<MenuTarget, { kind: 'font' }>

export type ContextMenuState =
  | ({ x: number; y: number } & MenuTarget)
  | null

export interface SelectionRectState {
  startX: number
  startY: number
  currentX: number
  currentY: number
  additive: boolean
}

export interface DeveloperStatusEntry {
  id: number
  at: string
  source: string
  message: string
  payload?: unknown
}

export interface ActiveFilter {
  kind: FilterKind
  id?: string
  name: string
}

export interface FontCardProps {
  font: FontItem
  active: boolean
  selected?: boolean
  compact?: boolean
  previewFamily?: string
  previewImage?: string
  previewText?: string
  listPreviewFontSize?: number
  onSelect: (event: React.MouseEvent<HTMLButtonElement> | React.KeyboardEvent<HTMLButtonElement>) => void
  onOpenDetail?: (event: React.MouseEvent<HTMLButtonElement> | React.KeyboardEvent<HTMLButtonElement>) => void
  onVisible: () => void
  onContextMenu: (event: React.MouseEvent) => void
  draggable?: boolean
  onDragStart?: (event: React.DragEvent) => void
  onDragEnd?: (event: React.DragEvent) => void
}

export interface VirtualViewport {
  scrollTop: number
  height: number
  width: number
}

export interface VirtualLayout {
  items: FontItem[]
  top: number
  totalHeight: number
  columns: number
  startIndex: number
  endIndex: number
}

export interface FontScrollAnchor {
  fontId: string
  rowOffset: number
  rowOffsetRatio?: number
  viewportOffset?: number
}

export interface FontScrollRestoreSnapshot {
  scrollTop: number | null
  anchor: FontScrollAnchor | null
}

export interface FontComputedIndex {
  id: string
  searchText: string
  scripts: FontScript[]
  category: FontCategory
  installed: boolean
  installStatusKnown: boolean
  systemBuiltin: boolean
  cleanSystem: boolean
  bad: boolean
  createdAtMs: number
  modifiedAtMs: number
}

export type PreviewQueueEntry = {
  font: FontItem
  priority: 'normal' | 'high'
}

export type QueuedFontWriteState = {
  localTags: Map<string, FontTagBatchItem>
  sharedTags: Map<string, FontTagBatchItem>
  favorite: Map<string, { font: FontItem; favorite: boolean }>
  protection: Map<string, { font: FontItem; protect: boolean }>
}

export type RendererMemoryInfo = {
  usedJSHeapSize?: number
  totalJSHeapSize?: number
  jsHeapSizeLimit?: number
}

export interface FontMetrics {
  total: number
  favoriteCount: number
  installedCount: number
  notInstalledCount: number
  installStatusKnownCount: number
  installStatusMissingCount: number
  installStatusReady: boolean
  activeCount: number
  systemDefaultCount: number
  formatCounts: Record<FontFormat, number>
  categoryCounts: Record<FontCategory, number>
  scriptCounts: Record<FontScript, number>
  collectionCounts: Record<string, number>
  tagCounts: Record<string, number>
  localTagCounts: Record<string, number>
  sharedTagCounts: Record<string, number>
  folderCounts: Record<string, number>
}
