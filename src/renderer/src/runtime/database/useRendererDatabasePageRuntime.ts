import { noteFontQueryScope, bindFontRefreshQuery, dispatchFontRefreshQuery, finishFontRefreshQuery } from '../../fontOperationTrace'
import { databaseQueryScopeKey, assertDatabasePageResponseMatchesRequest } from '../../constants/queryCacheRuntime'
import { SHARED_UNAVAILABLE_MESSAGE } from '../../../../shared/sharedAvailability'
import { captureFontTagReadConfirmation } from '../../fontTagStateAuthorityRuntime'
import { fontUserIntentRevision,hasUnsettledFavoriteIntent } from '../../fontUserIntentRuntime'
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
import { DATABASE_INCREMENTAL_PAGE_SIZE,buildRendererDatabasePageWindow,rendererDatabaseViewportPageOffset } from './rendererDatabasePageWindowRuntime'

function databaseTraceSeverity(durationMs: number): 'info' | 'slow' | 'warn' {
  if (durationMs >= 180) return 'warn'
  if (durationMs >= 50) return 'slow'
  return 'info'
}

export function mergeIncrementalDatabasePage(previous: FontQueryPageResult | null, result: FontQueryPageResult): FontQueryPageResult {
  if (!previous || result.offset <= 0 || previous.total !== result.total) return result
  if (databaseQueryScopeKey(previous.queryKey) !== databaseQueryScopeKey(result.queryKey)) return result
  // Only join overlapping/adjacent ranges. A jump to page 80 is not page 2.
  if (result.offset > previous.offset + previous.items.length || result.offset + result.items.length < previous.offset) return result
  // A response for the same range replaces it; a refresh cannot retain stale rows.
  if (result.offset === previous.offset) return result

  const seen = new Set<string>()
  const items: FontItem[] = []
  const pages = result.offset < previous.offset ? [result, previous] : [previous, result]
  for (const font of pages[0].items || []) {
    if (!font?.id || seen.has(font.id)) continue
    seen.add(font.id)
    items.push(font)
  }
  for (const font of pages[1].items || []) {
    if (!font?.id || seen.has(font.id)) continue
    seen.add(font.id)
    items.push(font)
  }

  return {
    ...result,
    items,
    offset: Math.min(previous.offset, result.offset),
    limit: items.length,
    truncated: Math.min(previous.offset, result.offset) + items.length < result.total
  }
}


export type RendererDatabasePageRuntimeOptions = {
  hfm: typeof window.hfm
  library: LibraryState
  libraryLoadedRef: Readonly<{ current: boolean }>
  databaseMetricsRefreshToken?: number
  databaseRefreshToken: number
  databasePageResult: FontQueryPageResult | null
  databaseQueryFailedKey: string
  virtualViewport: VirtualViewport
  viewLayout: { rowHeight: number; minCardWidth: number; columns?: number }
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
  fontListScrollingRef: Readonly<{ current: boolean }>
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
    const queryToken = `metrics:${requestSeq}:${Math.random().toString(36).slice(2)}`
    const scheduledAt = performance.now()
    let dispatched = false
    let settled = false
    const metricsDelayMs = options.indexingActive
      ? METRICS_INDEXING_DELAY_MS
      : options.rendererUserActive()
        ? METRICS_USER_ACTIVE_DELAY_MS
        : METRICS_IDLE_DELAY_MS
    const timer = window.setTimeout(() => {
      const startedAt = performance.now()
      dispatched = true
      const queueMs = Math.round(startedAt - scheduledAt)
      options.reportTrace({ kind: 'db-metrics-start', label: 'getFontMetrics', page: options.sidebarPage, durationMs: 0, details: { requestSeq, scheduledDelayMs: metricsDelayMs, queueMs, indexingActive: options.indexingActive, userActive: options.rendererUserActive(), fonts: options.allFontsLength } })
      const intentRevision = fontUserIntentRevision()
      const pendingFavorite = Object.values(options.library.fonts || {}).some(hasUnsettledFavoriteIntent)
      options.hfm.getFontMetrics(queryToken)
        .then((result) => {
          settled = true
          const durationMs = Math.round(performance.now() - startedAt)
          options.reportTrace({ kind: 'db-metrics-end', label: 'getFontMetrics', page: options.sidebarPage, severity: databaseTraceSeverity(durationMs), durationMs, details: { requestSeq, queueMs, totalMs: Math.round(performance.now() - scheduledAt), total: result.total, installed: result.installedCount, notInstalled: result.notInstalledCount, missing: result.installStatusMissingCount, elapsedMs: result.elapsedMs } })
          if (disposed || requestSeq !== options.fontMetricsRequestSeqRef.current) {
            options.reportTrace({ kind: 'db-metrics-rejected', label: 'obsolete-request', page: options.sidebarPage, details: { requestSeq } })
            return
          }
          if (pendingFavorite || intentRevision !== fontUserIntentRevision()) {
            options.reportTrace({ kind: 'db-metrics-rejected', label: 'user-intent-changed', page: options.sidebarPage,
              severity: 'warn', details: { requestSeq, pendingFavorite, intentRevision, currentIntentRevision: fontUserIntentRevision() } })
            return
          }
          const applyStartedAt = performance.now()
          options.setDatabaseFontMetrics(normalizeFontMetricsResult(result))
          options.reportTrace({ kind: 'db-metrics-applied', label: 'state-scheduled', page: options.sidebarPage,
            severity: 'info', durationMs: 0, details: { requestSeq, stateScheduleMs: Math.round(performance.now() - applyStartedAt), totalMs: Math.round(performance.now() - scheduledAt) } })
        })
        .catch((error) => {
          settled = true
          const durationMs = Math.round(performance.now() - startedAt)
          options.reportTrace({ kind: 'db-metrics-error', label: 'getFontMetrics', page: options.sidebarPage, severity: 'error', durationMs, details: { requestSeq, queueMs, totalMs: Math.round(performance.now() - scheduledAt), error: error instanceof Error ? error.message : String(error) } })
          if (disposed || requestSeq !== options.fontMetricsRequestSeqRef.current) return
          if (pendingFavorite || intentRevision !== fontUserIntentRevision()) {
            options.reportTrace({ kind: 'db-metrics-rejected', label: 'user-intent-changed', page: options.sidebarPage,
              severity: 'warn', details: { requestSeq, pendingFavorite, intentRevision, currentIntentRevision: fontUserIntentRevision() } })
            return
          }
          // A failed refresh must not replace a known snapshot with partial frontend counts.
        })
    }, metricsDelayMs)

    return () => {
      disposed = true
      window.clearTimeout(timer)
      if (!settled && dispatched) void options.hfm.cancelFontQuery?.(queryToken).catch(() => undefined)
      if (!settled) options.reportTrace({ kind: 'db-metrics-cancelled', label: dispatched ? 'in-flight' : 'queued', page: options.sidebarPage,
        details: { requestSeq, scheduledDelayMs: metricsDelayMs, totalMs: Math.round(performance.now() - scheduledAt) } })
    }
  }, [hasWatchedFolders, options.library.collections, options.library.tags, options.library.localTags, options.library.folders, options.library.folderNodes, options.library.fontFolderIds, options.databaseMetricsRefreshToken ?? options.databaseRefreshToken, options.indexingActive])

  const databasePageWindow = useMemo(() => buildRendererDatabasePageWindow({
    width: options.virtualViewport.width,
    height: options.virtualViewport.height,
    scrollTop: options.virtualViewport.scrollTop,
    rowHeight: options.viewLayout.rowHeight,
    minCardWidth: options.viewLayout.minCardWidth,
    columns: options.viewLayout.columns,
    pageOffset: incrementalPageOffset
  }), [options.virtualViewport.width, options.virtualViewport.height, options.virtualViewport.scrollTop, options.viewLayout.rowHeight, options.viewLayout.minCardWidth, options.viewLayout.columns, incrementalPageOffset])
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
    noteFontQueryScope(options.databasePageRequestSeqRef, pageQueryEnabled ? databaseQueryScope : undefined)
    if (!pageQueryEnabled) {
      options.setDatabaseQueryResult(null)
      options.setDatabasePageResult(null)
      options.setDatabaseQueryFailedKey('')
      return
    }

    let disposed = false
    const requestSeq = ++options.databasePageRequestSeqRef.current
    const queryToken = `page:${requestSeq}:${Math.random().toString(36).slice(2)}`
    const observation = bindFontRefreshQuery(options.databasePageRequestSeqRef, requestSeq, databaseQueryScope)
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
          keywordLength: databaseQueryRequest.keyword?.length || 0,
          scope: { filter: databaseQueryRequest.activeFilter?.kind, tag: databaseQueryRequest.selectedTagName, folder: databaseQueryRequest.selectedFolderId,
            install: databaseQueryRequest.installStatus, sort: databaseQueryRequest.sortMode, time: databaseQueryRequest.timeSortMode,
            category: databaseQueryRequest.selectedCategory, formats: databaseQueryRequest.selectedFormats?.join(','), scripts: databaseQueryRequest.selectedScripts?.join(','),
            watchedFolders: databaseQueryRequest.selectedWatchedFolders?.join('|') },
          scrolling: options.fontListScrollingRef.current
        }
      })
      dispatchFontRefreshQuery(observation)
      const intentRevision = fontUserIntentRevision()
      const confirmTagRead = captureFontTagReadConfirmation(options.library)
      options.hfm.queryFontPage(databaseQueryRequest, queryToken).then(async (result) => {
        if (disposed || requestSeq !== options.databasePageRequestSeqRef.current) {
          finishFontRefreshQuery(observation, undefined, disposed ? 'query-disposed' : 'query-superseded')
          options.reportTrace({ kind: 'db-query-rejected', label: disposed ? 'scope-disposed' : 'newer-request', page: options.sidebarPage,
            severity: 'info', details: { requestSeq, currentSeq: options.databasePageRequestSeqRef.current, keyword: databaseQueryRequest.keyword, total: result.total } })
          return
        }
        if (intentRevision !== fontUserIntentRevision()) {
          finishFontRefreshQuery(observation, undefined, disposed ? 'query-disposed' : 'query-superseded')
          options.reportTrace({ kind: 'db-query-rejected', label: 'user-intent-changed', page: options.sidebarPage,
            severity: 'warn', details: { requestSeq, intentRevision, currentIntentRevision: fontUserIntentRevision() } })
          return
        }
        assertDatabasePageResponseMatchesRequest(result, databaseQueryRequest)
        // Refill the previously loaded favorites window before publishing it. A
        // one-page replacement would shrink the scroll area after a bulk removal.
        const previous = options.databasePageResult
        if (databaseQueryRequest.activeFilter?.kind === 'favorites' && result.offset === 0 &&
            previous && databaseQueryScopeKey(previous.queryKey) === databaseQueryScopeKey(result.queryKey)) {
          const target = Math.min(previous.items.length, result.total)
          while (result.items.length < target) {
            if (disposed || requestSeq !== options.databasePageRequestSeqRef.current || intentRevision !== fontUserIntentRevision()) { finishFontRefreshQuery(observation); return }
            const nextRequest = { ...databaseQueryRequest, offset: result.items.length, limit: DATABASE_INCREMENTAL_PAGE_SIZE }
            const next = await options.hfm.queryFontPage(nextRequest, queryToken)
            assertDatabasePageResponseMatchesRequest(next, nextRequest)
            if (next.total !== result.total || !next.items.length) throw new Error('收藏分页在补齐期间发生变化，请重试')
            const merged = mergeIncrementalDatabasePage(result, next)
            if (merged.items.length <= result.items.length) throw new Error('收藏分页未向前推进，请重试')
            result = merged
          }
        }
        if (intentRevision !== fontUserIntentRevision()) {
          finishFontRefreshQuery(observation, undefined, disposed ? 'query-disposed' : 'query-superseded')
          options.reportTrace({ kind: 'db-query-rejected', label: 'user-intent-changed', page: options.sidebarPage,
            severity: 'warn', details: { requestSeq, intentRevision, currentIntentRevision: fontUserIntentRevision() } })
          return
        }
        const durationMs = Math.round(performance.now() - startedAt)
        options.reportTrace({
          kind: 'db-query-end',
          label: 'queryFontPage',
          page: options.sidebarPage,
          severity: databaseTraceSeverity(durationMs),
          durationMs,
          details: {
            requestSeq,
            keyword: databaseQueryRequest.keyword,
            keywordLength: databaseQueryRequest.keyword?.length || 0,
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
        if (disposed || requestSeq !== options.databasePageRequestSeqRef.current) { finishFontRefreshQuery(observation); return }
        const mergedResult = mergeIncrementalDatabasePage(options.databasePageResult, result)
        finishFontRefreshQuery(observation, mergedResult)
        options.setDatabasePageResult(mergedResult)
        options.setDatabaseQueryResult({
          queryKey: mergedResult.queryKey,
          ids: mergedResult.items.map((item: FontItem) => item.id),
          total: mergedResult.total,
          truncated: mergedResult.truncated,
          engine: mergedResult.engine,
          elapsedMs: mergedResult.elapsedMs
        })
        options.setLibrary((prev) => {
          const confirmed = confirmTagRead(prev, result.items)
          return libraryWithMergedFonts(confirmed, result.items, [options.selectedFontId, ...options.selectedFontIds])
        })
        options.setDatabaseQueryFailedKey('')
      }).catch((error) => {
        const durationMs = Math.round(performance.now() - startedAt)
        finishFontRefreshQuery(observation, undefined, 'query-failed')
        options.reportTrace({ kind: 'db-query-error', label: 'queryFontPage', page: options.sidebarPage, severity: 'error', durationMs, details: { requestSeq, error: error instanceof Error ? error.message : String(error), queryKey: databaseQueryKey } })
        if (disposed || requestSeq !== options.databasePageRequestSeqRef.current) { finishFontRefreshQuery(observation); return }
        if (String(error).includes(SHARED_UNAVAILABLE_MESSAGE)) {
          options.setStatus(SHARED_UNAVAILABLE_MESSAGE)
          return
        }
        options.setDatabasePageResult(null)
        options.setDatabaseQueryResult(null)
        options.setDatabaseQueryFailedKey(databaseQueryKey)
        options.setStatus(`数据库分页筛选暂时不可用，已回退前端筛选：${String(error)}`)
      })
    }, databasePageOffset > 0 ? 12 : options.fontListScrollingRef.current ? DATABASE_SCROLL_QUERY_DELAY_MS : DATABASE_IDLE_QUERY_DELAY_MS)

    return () => {
      disposed = true
      void options.hfm.cancelFontQuery?.(queryToken).catch(() => undefined)
      finishFontRefreshQuery(observation, undefined, 'query-disposed')
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
    const loadedItems = options.databasePageResult.items.length
    const nextOffset = rendererDatabaseViewportPageOffset({
      offset: options.databasePageResult.offset,
      loadedItems,
      totalItems: options.databasePageResult.total,
      viewportHeight: options.virtualViewport.height,
      scrollTop: options.virtualViewport.scrollTop,
      rowHeight: options.viewLayout.rowHeight,
      columns: databasePageWindow.columns
    })
    if (nextOffset !== null) setIncrementalPageOffset(nextOffset)
  }, [databasePageReady, options.databasePageResult, options.virtualViewport.height, options.virtualViewport.scrollTop, options.viewLayout.rowHeight, databasePageWindow.columns])

  return {
    databaseQueryRequest,
    databaseQueryKey,
    shouldUseDatabaseQuery,
    databasePageReady,
    visibleFontTotal
  }
}
