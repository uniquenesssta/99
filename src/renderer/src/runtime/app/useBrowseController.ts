import { useRef, useState } from 'react'
import type { FontFormat, FontScript, FontItem, FontQueryPageResult, FontQueryResult } from '@shared/types'
import type { ActiveFilter, SidebarPage, FontCategory, FilterGroupId, PageToolbarState, FontMetrics, VirtualViewport } from '../../appRuntime'
import { createDefaultPageToolbarStates, VIEW_MODE_LAYOUT, USER_ACTIVITY_IDLE_WINDOW_MS } from '../../appRuntime'
import { createFontToolbarFilterRuntime, type FontToolbarFilterRuntimeOptions } from '../../fontToolbarFilterRuntime'

export function useBrowseController(options: Pick<FontToolbarFilterRuntimeOptions, 'reportUserActivity'>) {
  const [activeFilter, setActiveFilter] = useState<ActiveFilter>({ kind: 'all', name: '全部字体' })
  const [sidebarPage, setSidebarPage] = useState<SidebarPage>('library')
  const [selectedFormats, setSelectedFormats] = useState<FontFormat[]>([])
  const [selectedScripts, setSelectedScripts] = useState<FontScript[]>([])
  const [selectedCategory, setSelectedCategory] = useState<FontCategory>('all')
  const [selectedWatchedFolders, setSelectedWatchedFolders] = useState<string[]>([])
  const [expandedFilterGroups, setExpandedFilterGroups] = useState<Partial<Record<FilterGroupId, true>>>({})
  const [selectedTagName, setSelectedTagName] = useState<string>('')
  const [selectedSharedTagName, setSelectedSharedTagName] = useState<string>('')
  const [selectedFolderId, setSelectedFolderId] = useState<string>('')
  const [pageToolbarStates, setPageToolbarStates] = useState<Record<SidebarPage, PageToolbarState>>(() => createDefaultPageToolbarStates())
  const [, setDatabaseQueryResult] = useState<FontQueryResult | null>(null)
  const [databasePageResult, setDatabasePageResult] = useState<FontQueryPageResult | null>(null)
  const [databaseQueryFailedKey, setDatabaseQueryFailedKey] = useState('')
  const [databaseFontMetrics, setDatabaseFontMetrics] = useState<FontMetrics | null>(null)
  const [virtualViewport, setVirtualViewport] = useState<VirtualViewport>({ scrollTop: 0, height: 640, width: 760 })
  const databasePageRequestSeqRef = useRef(0)
  const fontMetricsRequestSeqRef = useRef(0)
  const fontScrollerRef = useRef<HTMLDivElement | null>(null)
  const scrollRafRef = useRef<number | null>(null)
  const lastScrollTraceAtRef = useRef(0)
  const latestVisibleFontsRef = useRef<FontItem[]>([])
  const latestViewLayoutRef = useRef(VIEW_MODE_LAYOUT.comfortable)
  const pageToolbar = pageToolbarStates[sidebarPage]
  const search = pageToolbar.search
  const installStatus = pageToolbar.installStatus || 'all'
  const timeSortMode = pageToolbar.timeSortMode
  const sortMode = pageToolbar.sortMode
  const viewMode = pageToolbar.viewMode
  const selectedWatchedFoldersKey = selectedWatchedFolders.join('\u0000')
  const selectedFormatsKey = selectedFormats.join('\u0000')
  const selectedScriptsKey = selectedScripts.join('\u0000')
  const activeFilterKey = `${activeFilter.kind}\u0000${activeFilter.id || ''}\u0000${activeFilter.name || ''}`

  const toolbarFilterRuntime = createFontToolbarFilterRuntime({
    sidebarPage,
    setPageToolbarStates,
    reportUserActivity: options.reportUserActivity,
    userActivityIdleWindowMs: USER_ACTIVITY_IDLE_WINDOW_MS,
    setSelectedWatchedFolders,
    setSelectedFormats,
    setSelectedScripts,
    setSelectedCategory,
    setExpandedFilterGroups
  })
  const updatePageToolbar = toolbarFilterRuntime.updatePageToolbar
  const clearAdvancedFilters = toolbarFilterRuntime.clearAdvancedFilters
  const setFilterGroupExpanded = toolbarFilterRuntime.setFilterGroupExpanded

  return {
    activeFilter,
    setActiveFilter,
    sidebarPage,
    setSidebarPage,
    selectedFormats,
    setSelectedFormats,
    selectedScripts,
    setSelectedScripts,
    selectedCategory,
    setSelectedCategory,
    selectedWatchedFolders,
    setSelectedWatchedFolders,
    expandedFilterGroups,
    selectedTagName,
    setSelectedTagName,
    selectedSharedTagName,
    setSelectedSharedTagName,
    selectedFolderId,
    setSelectedFolderId,
    setDatabaseQueryResult,
    databasePageResult,
    setDatabasePageResult,
    databaseQueryFailedKey,
    setDatabaseQueryFailedKey,
    databaseFontMetrics,
    setDatabaseFontMetrics,
    virtualViewport,
    setVirtualViewport,
    databasePageRequestSeqRef,
    fontMetricsRequestSeqRef,
    fontScrollerRef,
    scrollRafRef,
    lastScrollTraceAtRef,
    latestVisibleFontsRef,
    latestViewLayoutRef,
    search,
    installStatus,
    timeSortMode,
    sortMode,
    viewMode,
    selectedWatchedFoldersKey,
    selectedFormatsKey,
    selectedScriptsKey,
    activeFilterKey,
    updatePageToolbar,
    clearAdvancedFilters,
    setFilterGroupExpanded,
  }
}
