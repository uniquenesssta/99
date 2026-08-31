import type { FontFormat,FontItem,FontQueryPageResult,FontQueryRequest,FontQueryResult,FontScript,LibraryState } from '@shared/types'
import type { Dispatch,MutableRefObject,SetStateAction } from 'react'
import { useEffect,useMemo,useState } from 'react'
import type { ActiveFilter,FontCategory,FontMetrics,InstallStatusFilter,RendererPerformanceEventPayload,SidebarPage,SortMode,TimeSortMode,VirtualViewport } from '../../appRuntime'
import {
DATABASE_IDLE_QUERY_DELAY_MS,
DATABASE_SCROLL_QUERY_DELAY_MS,
METRICS_IDLE_DELAY_MS,
METRICS_INDEXING_DELAY_MS,
METRICS_USER_ACTIVE_DELAY_MS,
libraryWithMergedFonts,
normalizeFontMetricsResult,
rendererFontQueryCacheKey
} from '../../appRuntime'
import { createRendererFontQueryRequest } from '../../fontViewRuntime'
import { DATABASE_INCREMENTAL_PAGE_SIZE,buildRendererDatabasePageWindow,nextRendererDatabasePageOffset,shouldGrowRendererDatabasePage } from './rendererDatabasePageWindowRuntime'

function databaseQueryScopeKey(queryKey: string | undefined): string {
  if (!queryKey) return ''
  try {
    const parsed = JSON.parse(queryKey) as Record<string, unknown>
    delete parsed.offset
    delete parsed.limit
    return JSON.stringify(parsed)
  } catch {
    return queryKey
  }
}

function databaseTraceSeverity(durationMs: number): 'info' | 'slow' | 'warn' {
  if (durationMs >= 180) return 'warn'
  if (durationMs >= 50) return 'slow'
  return 'info'
}

function mergeIncrementalDatabasePage(previous: FontQueryPageResult | null, result: FontQueryPageResult): FontQueryPageResult {
  if (!previous || result.offset <= 0 || previous.offset !== 0) return result
  if (databaseQueryScopeKey(previous.queryKey) !== databaseQueryScopeKey(result.queryKey)) return result

  const seen = new Set<string>()
  const items: FontItem[] = []
  for (const font of previous.items || []) {
    if (!font?.id || seen.has(font.id)) continue
    seen.add(font.id)
    items.push(font)
  }
  for (const font of result.items || []) {
    if (!font?.id || seen.has(font.id)) continue
    seen.add(font.id)
    items.push(font)
  }

  return {
    ...result,
    items,
    offset: 0,
    limit: items.length,
    truncated: items.length < result.total
  }
}


export type RendererDatabasePageRuntimeOptions = {
  hfm: typeof window.hfm
  library: LibraryState
  libraryLoadedRef: MutableRefObject<boolean>
  databaseRefreshToken: number
  databasePageResult: FontQueryPageResult | null
  databaseQueryFailedKey: string
  virtualViewport: VirtualViewport
  viewLayout: { rowHeight: number; minCardWidth: number }
  skipPageQuery?: boolean
  allFontsLength: number
  sidebarPage: SidebarPage
  indexingActive: boolean
  deferredSearch: string
  activeFilter: ActiveFilter
  selectedWatchedFolders: string[]
  selectedFormats: FontFormat[]
  selectedScripts: FontScript[]
  selectedCategory: FontCategory
  selectedTagName: string
  selectedSharedTagName: string
  selectedFolderId: string
  selectedFontId: string
  selectedFontIds: string[]
  installStatus: InstallStatusFilter
  timeSortMode: TimeSortMode
  sortMode: SortMode
  fontListScrollingRef: MutableRefObject<boolean>
  fontMetricsRequestSeqRef: MutableRefObject<number>
  databasePageRequestSeqRef: MutableRefObject<number>
  rendererUserActive: () => boolean
  reportTrace: (payload: RendererPerformanceEventPayload, throttleKey?: string) => void
  setDatabaseFontMetrics: Dispatch<SetStateAction<FontMetrics | null>>
  setDatabasePageResult: Dispatch<SetStateAction<FontQueryPageResult | null>>
  setDatabaseQueryResult: Dispatch<SetStateAction<FontQueryResult | null>>
  setDatabaseQueryFailedKey: Dispatch<SetStateAction<string>>
  setLibrary: Dispatch<SetStateAction<LibraryState>>
  setStatus: Dispatch<SetStateAction<string>>
}

export function useRendererDatabasePageRuntime(options: RendererDatabasePageRuntimeOptions): {
  databaseQueryRequest: FontQueryRequest
  databaseQueryKey: string
  shouldUseDatabaseQuery: boolean
  databasePageReady: boolean
  visibleFontTotal: number
} {
  const [incrementalPageOffset, setIncrementalPageOffset] = useState(0)
  const hasWatchedFolders = (options.library.folders || []).length > 0

  useEffect(() => {
    if (!hasWatchedFolders) {
      options.setDatabaseFontMetrics(null)
      return
    }
    if (typeof options.hfm.getFontMetrics !== 'function') return

    let disposed = false
    const requestSeq = ++options.fontMetricsRequestSeqRef.current
    const metricsDelayMs = options.indexingActive
      ? METRICS_INDEXING_DELAY_MS
      : options.rendererUserActive()
        ? METRICS_USER_ACTIVE_DELAY_MS
        : METRICS_IDLE_DELAY_MS
    const timer = window.setTimeout(() => {
      const startedAt = performance.now()
      options.reportTrace({ kind: 'db-metrics-start', label: 'getFontMetrics', page: options.sidebarPage, durationMs: 0, details: { indexingActive: options.indexingActive, userActive: options.rendererUserActive(), fonts: options.allFontsLength } }, 'db-metrics-start')
      options.hfm.getFontMetrics()
        .then((result) => {
          const durationMs = Math.round(performance.now() - startedAt)
          options.reportTrace({ kind: 'db-metrics-end', label: 'getFontMetrics', page: options.sidebarPage, severity: databaseTraceSeverity(durationMs), durationMs, details: { total: result.total, installed: result.installedCount, notInstalled: result.notInstalledCount, missing: result.installStatusMissingCount, elapsedMs: result.elapsedMs } })
          if (disposed || requestSeq !== options.fontMetricsRequestSeqRef.current) return
          options.setDatabaseFontMetrics(normalizeFontMetricsResult(result))
        })
        .catch((error) => {
          const durationMs = Math.round(performance.now() - startedAt)
          options.reportTrace({ kind: 'db-metrics-error', label: 'getFontMetrics', page: options.sidebarPage, severity: 'error', durationMs, details: { error: error instanceof Error ? error.message : String(error) } })
          if (disposed || requestSeq !== options.fontMetricsRequestSeqRef.current) return
          options.setDatabaseFontMetrics(null)
        })
    }, metricsDelayMs)

    return () => {
      disposed = true
      window.clearTimeout(timer)
    }
  }, [hasWatchedFolders, options.library.collections, options.library.tags, options.library.localTags, options.library.folders, options.library.folderNodes, options.library.fontFolderIds, options.databaseRefreshToken, options.indexingActive])

  const databasePageWindow = useMemo(() => buildRendererDatabasePageWindow({
    width: options.virtualViewport.width,
    height: options.virtualViewport.height,
    scrollTop: options.virtualViewport.scrollTop,
    rowHeight: options.viewLayout.rowHeight,
    minCardWidth: options.viewLayout.minCardWidth,
    pageOffset: incrementalPageOffset
  }), [options.virtualViewport.width, options.virtualViewport.height, options.virtualViewport.scrollTop, options.viewLayout.rowHeight, options.viewLayout.minCardWidth, incrementalPageOffset])
  const databasePageOffset = databasePageWindow.offset
  const databasePageLimit = databasePageWindow.limit

  const databaseQueryRequest = useMemo<FontQueryRequest>(() => createRendererFontQueryRequest({
    deferredSearch: options.deferredSearch,
    databasePageLimit,
    databasePageOffset,
    sidebarPage: options.sidebarPage,
    activeFilter: options.activeFilter,
    selectedWatchedFolders: options.selectedWatchedFolders,
    selectedFormats: options.selectedFormats,
    selectedScripts: options.selectedScripts,
    selectedCategory: options.selectedCategory,
    selectedTagName: options.selectedTagName,
    selectedSharedTagName: options.selectedSharedTagName,
    selectedFolderId: options.selectedFolderId,
    installStatus: options.installStatus,
    timeSortMode: options.timeSortMode,
    sortMode: options.sortMode
  }), [options.deferredSearch, databasePageLimit, databasePageOffset, options.sidebarPage, options.activeFilter, options.selectedWatchedFolders, options.selectedFormats, options.selectedScripts, options.selectedCategory, options.selectedTagName, options.selectedSharedTagName, options.selectedFolderId, options.installStatus, options.timeSortMode, options.sortMode])

  const databaseQueryKey = useMemo(() => rendererFontQueryCacheKey(databaseQueryRequest), [databaseQueryRequest])
  const databaseQueryScope = useMemo(() => databaseQueryScopeKey(databaseQueryKey), [databaseQueryKey])
  const databaseResultScope = useMemo(() => databaseQueryScopeKey(options.databasePageResult?.queryKey), [options.databasePageResult?.queryKey])

  const shouldUseDatabaseQuery = useMemo(() => {
    return hasWatchedFolders && options.sidebarPage !== 'developer' && typeof options.hfm.queryFontPage === 'function' && options.libraryLoadedRef.current
  }, [hasWatchedFolders, options.sidebarPage, options.library.folders, options.library.collections, options.library.tags, options.library.localTags, options.databaseRefreshToken])

  const databaseIncrementalResetKey = useMemo(() => JSON.stringify({
    sidebarPage: options.sidebarPage,
    search: options.deferredSearch.trim(),
    activeKind: options.activeFilter?.kind || 'all',
    activeName: options.activeFilter?.name || '',
    watchedFolders: options.selectedWatchedFolders,
    formats: options.selectedFormats,
    scripts: options.selectedScripts,
    category: options.selectedCategory,
    localTag: options.selectedTagName,
    sharedTag: options.selectedSharedTagName,
    folderId: options.selectedFolderId,
    installStatus: options.installStatus,
    timeSortMode: options.timeSortMode,
    sortMode: options.sortMode,
    refresh: options.databaseRefreshToken
  }), [options.sidebarPage, options.deferredSearch, options.activeFilter, options.selectedWatchedFolders, options.selectedFormats, options.selectedScripts, options.selectedCategory, options.selectedTagName, options.selectedSharedTagName, options.selectedFolderId, options.installStatus, options.timeSortMode, options.sortMode, options.databaseRefreshToken])

  useEffect(() => {
    setIncrementalPageOffset(0)
  }, [databaseIncrementalResetKey])

  const pageQueryEnabled = shouldUseDatabaseQuery && !options.skipPageQuery

  useEffect(() => {
    if (!pageQueryEnabled) {
      options.setDatabaseQueryResult(null)
      options.setDatabasePageResult(null)
      options.setDatabaseQueryFailedKey('')
      return
    }

    let disposed = false
    const requestSeq = ++options.databasePageRequestSeqRef.current
    const timer = window.setTimeout(() => {
      const startedAt = performance.now()
      options.reportTrace({
        kind: 'db-query-start',
        label: 'queryFontPage',
        page: options.sidebarPage,
        durationMs: 0,
        details: {
          requestSeq,
          offset: databaseQueryRequest.offset,
          limit: databaseQueryRequest.limit,
          keyword: databaseQueryRequest.keyword,
          activeFilterKind: databaseQueryRequest.activeFilter?.kind || 'all',
          activeFilterName: databaseQueryRequest.activeFilter?.name,
          installStatus: databaseQueryRequest.installStatus,
          sortMode: databaseQueryRequest.sortMode,
          timeSortMode: databaseQueryRequest.timeSortMode,
          selectedFolderId: databaseQueryRequest.selectedFolderId,
          selectedWatchedFolders: databaseQueryRequest.selectedWatchedFolders?.length || 0,
          scrolling: options.fontListScrollingRef.current
        }
      }, `db-query-start:${options.sidebarPage}`)
      options.hfm.queryFontPage(databaseQueryRequest).then((result) => {
        const durationMs = Math.round(performance.now() - startedAt)
        options.reportTrace({
          kind: 'db-query-end',
          label: 'queryFontPage',
          page: options.sidebarPage,
          severity: databaseTraceSeverity(durationMs),
          durationMs,
          details: {
            requestSeq,
            total: result.total,
            items: result.items.length,
            offset: result.offset,
            limit: result.limit,
            engine: result.engine,
            elapsedMs: result.elapsedMs,
            activeFilterKind: databaseQueryRequest.activeFilter?.kind || 'all',
            activeFilterName: databaseQueryRequest.activeFilter?.name,
            installStatus: databaseQueryRequest.installStatus,
            scrolling: options.fontListScrollingRef.current
          }
        })
        if (disposed || requestSeq !== options.databasePageRequestSeqRef.current) return
        const mergedResult = mergeIncrementalDatabasePage(options.databasePageResult, result)
        options.setDatabasePageResult(mergedResult)
        options.setDatabaseQueryResult({
          queryKey: mergedResult.queryKey,
          ids: mergedResult.items.map((item: FontItem) => item.id),
          total: mergedResult.total,
          truncated: mergedResult.truncated,
          engine: mergedResult.engine,
          elapsedMs: mergedResult.elapsedMs
        })
        options.setLibrary((prev) => libraryWithMergedFonts(prev, result.items, [options.selectedFontId, ...options.selectedFontIds]))
        options.setDatabaseQueryFailedKey('')
      }).catch((error) => {
        const durationMs = Math.round(performance.now() - startedAt)
        options.reportTrace({ kind: 'db-query-error', label: 'queryFontPage', page: options.sidebarPage, severity: 'error', durationMs, details: { requestSeq, error: error instanceof Error ? error.message : String(error), queryKey: databaseQueryKey } })
        if (disposed || requestSeq !== options.databasePageRequestSeqRef.current) return
        options.setDatabasePageResult(null)
        options.setDatabaseQueryResult(null)
        options.setDatabaseQueryFailedKey(databaseQueryKey)
        options.setStatus(`数据库分页筛选暂时不可用，已回退前端筛选：${String(error)}`)
      })
    }, databasePageOffset > 0 ? 12 : options.fontListScrollingRef.current ? DATABASE_SCROLL_QUERY_DELAY_MS : DATABASE_IDLE_QUERY_DELAY_MS)

    return () => {
      disposed = true
      window.clearTimeout(timer)
    }
  }, [pageQueryEnabled, databaseQueryRequest, databaseQueryKey, options.databaseRefreshToken])

  const databasePageReady = !!(
    pageQueryEnabled &&
    options.databaseQueryFailedKey !== databaseQueryKey &&
    options.databasePageResult &&
    databaseResultScope === databaseQueryScope
  )
  const visibleFontTotal = databasePageReady ? options.databasePageResult?.total || 0 : 0

  useEffect(() => {
    if (!databasePageReady || !options.databasePageResult) return
    if (options.databasePageResult.offset !== 0) return
    const loadedItems = options.databasePageResult.items.length
    if (!shouldGrowRendererDatabasePage({
      loadedItems,
      totalItems: options.databasePageResult.total,
      viewportHeight: options.virtualViewport.height,
      scrollTop: options.virtualViewport.scrollTop,
      rowHeight: options.viewLayout.rowHeight,
      columns: databasePageWindow.columns
    })) return
    setIncrementalPageOffset((current) => {
      const nextOffset = nextRendererDatabasePageOffset(loadedItems, options.databasePageResult?.total || 0)
      return nextOffset > current ? nextOffset : current
    })
  }, [databasePageReady, options.databasePageResult, options.virtualViewport.height, options.virtualViewport.scrollTop, options.viewLayout.rowHeight, databasePageWindow.columns])

  return {
    databaseQueryRequest,
    databaseQueryKey,
    shouldUseDatabaseQuery,
    databasePageReady,
    visibleFontTotal
  }
}
