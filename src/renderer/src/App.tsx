import type { CacheStats,FontFormat,FontIndexChangePayload,FontIndexProgressPayload,FontItem,FontQueryPageResult,FontQueryResult,FontScript,InstallStatusProgressPayload,LibraryState } from '@shared/types'
import { normalizePreviewText,previewTextLines } from '@shared/preview-layout/previewTextFitRuntime'
import { useDeferredValue,useEffect,useLayoutEffect,useMemo,useRef,useState } from 'react'
import type {
ActiveFilter,
ContextMenuState,
CardPoolViewMode,
DeveloperStatusEntry,
EditableMenuTarget,
FilterGroupId,
FontCategory,
FontComputedIndex,
FontMetrics,
MenuTarget,
PageToolbarState,
PreviewQueueEntry,
QueuedFontWriteState,
SelectionRectState,
SidebarPage,
ThemeMode,
VirtualLayout,
VirtualViewport
} from './appRuntime'
import {
applyFontIndexChangeToLibrary,
buildFontComputedIndex,
buildFontMetrics,
CONTEXT_MENU_MAX_HEIGHT,
CONTEXT_MENU_WIDTH,
createDefaultPageToolbarStates,
createEmptyLibrary,
createEmptyQueuedFontWriteState,
flattenFolderNodes,
getVirtualGridColumns,
IS_DEVELOPMENT,
isDefinitelyBadFontRecord,
markPartialLibrary,
normalizeLibrary,
PREVIEW_PREFETCH_LIMIT,
PREVIEW_SCROLL_IDLE_MS,
rendererMemoryPressure,
normalizeFontMetricsResult,
reportRendererTrace,
requestIdleWindow,
traceRendererSyncComputation,
USER_ACTIVITY_IDLE_WINDOW_MS,
USER_ACTIVITY_REPORT_INTERVAL_MS,
VIEW_MODE_LAYOUT,
VIRTUAL_PANEL_PADDING,
WRITE_BEHIND_DELAY_MS,
WRITE_BEHIND_MAX_BUFFER_BYTES,
WRITE_BEHIND_MAX_ITEMS
} from './appRuntime'
import { AppLayout } from './components/app/AppLayout'
import { AppOverlays } from './components/app/AppOverlays'
import { AppSidebar } from './components/app/AppSidebar'
import { AppRootView } from './components/app/AppRootView'
import { AppTopbar } from './components/app/AppTopbar'
import { createFontCardRenderer } from './components/app/FontCardRenderer'
import { FontDetailPanel } from './components/app/FontDetailPanel'
import { FontListPanel } from './components/app/FontListPanel'
import { refreshDatabaseDerivedStateRuntime,scheduleDatabaseDerivedStateRefreshRuntime } from './databaseDerivedStateRuntime'
import { createFontContextActionRuntime } from './fontContextActionRuntime'
import { createFontDetailPanelRuntime } from './fontDetailPanelRuntime'
import { createFontDialogRuntime } from './fontDialogRuntime'
import {
pruneExpandedFolderIds,
pruneSelectedWatchedFolders
} from './fontFilterStateRuntime'
import { createFontFolderTreeRuntime } from './fontFolderTreeRuntime'
import { cleanupRemovedIndexedFontsFromRendererState,fontIndexChangeStatusText,isIndexProgressActive } from './fontIndexEventRuntime'
import {
applyInstallCompareToFont
} from './fontInstallStateRuntime'
import {
normalizedSelectionRect
} from './fontSelectionRuntime'
import { createFontToolbarFilterRuntime } from './fontToolbarFilterRuntime'
import { buildTagSuggestions,buildVirtualLayout,buildVisibleFonts } from './fontViewRuntime'
import type { FontFamilyGroupResult } from './runtime/family/fontFamilyGroupingRuntime'
import { fontFamilyQueryScopeKey,loadFontFamilyGroups } from './runtime/family/fontFamilyGroupingRuntime'
import { createRendererFontWriteQueueRuntime } from './fontWriteQueueRuntime'
import {
isRendererUserActive,
registerRendererActivityListeners,
reportRendererUserActivity,
startRendererLongTaskMonitor
} from './rendererActivityRuntime'
import { appendDeveloperStatusEntry,refreshDeveloperStatusDetailsRuntime } from './rendererDeveloperStatusRuntime'
import { runSharedMetadataSyncCheckRuntime } from './sharedMetadataSyncRuntime'
import { useAutoInstallStatusRefreshRuntime } from './runtime/app/useAutoInstallStatusRefreshRuntime'
import { useFontDetailNativePreviewRuntime } from './runtime/app/useFontDetailNativePreviewRuntime'
import { useFontDetailSelectionEffectsRuntime } from './runtime/app/useFontDetailSelectionEffectsRuntime'
import { useFontListScrollRuntime } from './runtime/app/useFontListScrollRuntime'
import { usePendingDetailRevealRuntime } from './runtime/app/usePendingDetailRevealRuntime'
import { useRendererDisplayPreferences } from './runtime/app/useRendererDisplayPreferencesRuntime'
import { useRendererReadyNotification } from './runtime/app/useRendererReadyNotificationRuntime'
import { useAppFontShellDerivedRuntime } from './runtime/app/useAppFontShellDerivedRuntime'
import { useAppFontDerivedRuntime } from './runtime/app/useAppFontDerivedRuntime'
import { createAppFontScrollRestoreRuntime } from './runtime/app/useFontScrollRestoreRuntime'
import { createAppFontSelectionInteractionRuntime } from './runtime/app/useFontSelectionInteractionRuntime'
import { useRendererDatabasePageRuntime } from './runtime/database/useRendererDatabasePageRuntime'
import { createFontLibraryIndexActionRuntime } from './runtime/library/fontLibraryIndexActionRuntime'
import { createFontPreviewQueueRuntime } from './runtime/preview/fontPreviewQueueRuntime'
import { clampListPreviewFontSize,listPreviewFontSizeRowHeightPadding } from './runtime/preview/listPreviewSizeRuntime'
import { createFontInstallStatusRuntime } from './runtime/system/fontInstallStatusRuntime'
import { createFontSystemActionRuntime } from './runtime/system/fontSystemActionRuntime'
import { setupFloatingScrollbars } from './utils/floatingScrollbars'
import { useAppThemeRuntime } from './runtime/app/effects/useAppThemeRuntime'
import { useRendererDeveloperStatusLogRuntime } from './runtime/app/effects/useRendererDeveloperStatusLogRuntime'
import type { LeaseLockConflictNotice } from './runtime/lease-lock/leaseLockConflictNoticeRuntime'
import { parseLeaseLockConflictNotice } from './runtime/lease-lock/leaseLockConflictNoticeRuntime'
import { useFolderFilterPruneRuntime } from './runtime/app/effects/useFolderFilterPruneRuntime'
import { useTagSelectionPruneRuntime } from './runtime/app/effects/useTagSelectionPruneRuntime'
import { useInitialLibraryShellRuntime } from './runtime/app/effects/useInitialLibraryShellRuntime'
import { useSharedMetadataSyncForegroundRuntime } from './runtime/app/effects/useSharedMetadataSyncForegroundRuntime'
import { useAppFlushOnUnloadRuntime } from './runtime/app/effects/useAppFlushOnUnloadRuntime'
import { useRendererActivityRuntime } from './runtime/app/effects/useRendererActivityRuntime'
import { useWatchedFoldersRuntime } from './runtime/app/effects/useWatchedFoldersRuntime'
import { useFoldersChangedEventRuntime } from './runtime/app/effects/useFoldersChangedEventRuntime'
import { useFontIndexProgressEventRuntime } from './runtime/app/effects/useFontIndexProgressEventRuntime'
import { useInstallStatusProgressEventRuntime } from './runtime/app/effects/useInstallStatusProgressEventRuntime'
import { usePreviewQueueResumeRuntime } from './runtime/app/effects/usePreviewQueueResumeRuntime'
import { useBackgroundTaskEventsRuntime } from './runtime/app/effects/useBackgroundTaskEventsRuntime'
import { useFontIndexChangedEventRuntime } from './runtime/app/effects/useFontIndexChangedEventRuntime'
import { useFontTagStateSignalEventRuntime } from './runtime/app/effects/useFontTagStateSignalEventRuntime'
import { libraryShellPersistenceKey,useLibraryAutosaveRuntime } from './runtime/app/effects/useLibraryAutosaveRuntime'
import { useIndexOperationRunRuntime } from './runtime/app/effects/useIndexOperationRunRuntime'
import { useContextMenuDismissRuntime } from './runtime/app/effects/useContextMenuDismissRuntime'
import { useFontFilterScrollResetRuntime } from './runtime/app/effects/useFontFilterScrollResetRuntime'
import { useFontViewportResizeObserverRuntime } from './runtime/app/effects/useFontViewportResizeObserverRuntime'
import { usePreviewTextResetRuntime } from './runtime/app/effects/usePreviewTextResetRuntime'
import { useTagSuggestionResetRuntime } from './runtime/app/effects/useTagSuggestionResetRuntime'
import { useFontFamilyGroupsRuntime } from './runtime/app/useFontFamilyGroupsRuntime'
import { hydrateFontForSelectionDetail } from './runtime/app/fontSelectionHydrationRuntime'
import { effectiveCardPoolViewMode as resolveEffectiveCardPoolViewMode, isFontFamilyViewAllowed } from './runtime/app/cardPoolViewModePolicyRuntime'
export default function App(): JSX.Element {
  if (!window.hfm) {
    return (
      <div className="bridge-error">
        <h1>启动桥接失败</h1>
        <p>Electron preload 没有成功注入 window.hfm。请确认正在运行 v0.8.7 或更新版本。</p>
        <pre>window.hfm is undefined</pre>
      </div>
    )
  }

  useRendererReadyNotification()

  const [library, setLibraryState] = useState<LibraryState>(createEmptyLibrary())
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
  const [expandedFolderIds, setExpandedFolderIds] = useState<Record<string, true>>({})
  const [newFolderName, setNewFolderName] = useState('')
  const [folderChildTarget, setFolderChildTarget] = useState<Extract<MenuTarget, { kind: 'folder' }> | null>(null)
  const [draggingFontId, setDraggingFontId] = useState('')
  const [dropHoverFolderId, setDropHoverFolderId] = useState('')
  const [pageToolbarStates, setPageToolbarStates] = useState<Record<SidebarPage, PageToolbarState>>(() => createDefaultPageToolbarStates())
  const [selectedFontId, setSelectedFontId] = useState<string>('')
  const selectedFontIdRef = useRef('')
  selectedFontIdRef.current = selectedFontId
  const [selectedFontIds, setSelectedFontIds] = useState<string[]>([])
  const [selectionAnchorFontId, setSelectionAnchorFontId] = useState<string>('')
  const [selectionRect, setSelectionRect] = useState<SelectionRectState | null>(null)
  const [detailVisible, setDetailVisible] = useState(false)
  const detailCardClickLockUntilRef = useRef(0)
  const [pendingDetailRevealFontId, setPendingDetailRevealFontId] = useState('')
  const {
    themeMode,
    setThemeMode,
    cardPoolViewMode,
    setStoredCardPoolViewMode,
    listPreviewFontSize,
    setListPreviewFontSize,
  } = useRendererDisplayPreferences()
  const [status, setStatus] = useState('准备就绪')
  const [leaseLockConflictNotice, setLeaseLockConflictNotice] = useState<LeaseLockConflictNotice | null>(null)
  const [developerStatusLog, setDeveloperStatusLog] = useState<DeveloperStatusEntry[]>([])
  const [latestIndexProgress, setLatestIndexProgress] = useState<FontIndexProgressPayload | null>(null)
  const [indexingActive, setIndexingActive] = useState(false)
  const [latestBackgroundTaskEvent, setLatestBackgroundTaskEvent] = useState<unknown>(null)
  const [developerArchitecture, setDeveloperArchitecture] = useState<unknown>(null)
  const [developerSchedulerStatus, setDeveloperSchedulerStatus] = useState<unknown>(null)
  const [developerMigrationDiagnostics, setDeveloperMigrationDiagnostics] = useState<unknown>(null)
  const [developerSharedMetadataDiagnostics, setDeveloperSharedMetadataDiagnostics] = useState<unknown>(null)
  const [developerTasks, setDeveloperTasks] = useState<unknown[]>([])
  const [databaseRefreshToken, setDatabaseRefreshToken] = useState(0)
  const [, setDatabaseQueryResult] = useState<FontQueryResult | null>(null)
  const [databasePageResult, setDatabasePageResult] = useState<FontQueryPageResult | null>(null)
  const [databaseQueryFailedKey, setDatabaseQueryFailedKey] = useState('')
  const [databaseFontMetrics, setDatabaseFontMetrics] = useState<FontMetrics | null>(null)
  const [previewFamilies, setPreviewFamilies] = useState<Record<string, string>>({})
  const [nativePreviewImages, setNativePreviewImages] = useState<Record<string, string>>({})
  const [nativeDetailImage, setNativeDetailImage] = useState<string>('')
  const detailNativePreviewRequestSeqRef = useRef(0)
  const [failedPreviewFontIds, setFailedPreviewFontIds] = useState<Record<string, true>>({})
  const [virtualViewport, setVirtualViewport] = useState<VirtualViewport>({ scrollTop: 0, height: 640, width: 760 })
  const [, setCacheStats] = useState<CacheStats | null>(null)
  const [cacheMenuOpen, setCacheMenuOpen] = useState(false)
  const [newTagName, setNewTagName] = useState('')
  const [newSharedTagName, setNewSharedTagName] = useState('')
  const [assignTagName, setAssignTagName] = useState('')
  const [assignSharedTagName, setAssignSharedTagName] = useState('')
  const [activeLocalTagSuggestionIndex, setActiveLocalTagSuggestionIndex] = useState(0)
  const [activeSharedTagSuggestionIndex, setActiveSharedTagSuggestionIndex] = useState(0)
  const [contextMenu, setContextMenu] = useState<ContextMenuState>(null)
  const [renameTarget, setRenameTarget] = useState<EditableMenuTarget | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [deleteTarget, setDeleteTarget] = useState<EditableMenuTarget | null>(null)
  const loadingFonts = useRef<Set<string>>(new Set())
  const previewRequestTokenRef = useRef('')
  previewRequestTokenRef.current = `${normalizePreviewText(library.previewText)}::${clampListPreviewFontSize(listPreviewFontSize)}`
  const previewQueue = useRef<PreviewQueueEntry[]>([])
  const queuedPreviewFontIds = useRef<Set<string>>(new Set())
  const fontWriteQueue = useRef<QueuedFontWriteState>(createEmptyQueuedFontWriteState())
  const fontWriteFlushTimerRef = useRef<number | null>(null)
  const fontWriteRetryTimerRef = useRef<number | null>(null)
  const fontWriteRetryAttemptRef = useRef(0)
  const fontWriteFlushActiveRef = useRef(false)
  const fontWriteFlushActivePromiseRef = useRef<Promise<boolean> | null>(null)
  const databaseRefreshTimerRef = useRef<number | null>(null)
  const databasePageRequestSeqRef = useRef(0)
  const fontMetricsRequestSeqRef = useRef(0)
  const fontListScrollingRef = useRef(false)
  const fontListScrollIdleTimerRef = useRef<number | null>(null)
  const activePreviewLoads = useRef(0)
  const autoPreviewCacheQueue = useRef<FontItem[]>([])
  const queuedAutoPreviewCacheIds = useRef<Set<string>>(new Set())
  const activeAutoPreviewCacheLoads = useRef(0)
  const autoPreviewCacheRunId = useRef(0)
  const autoPreviewCacheStats = useRef({ total: 0, done: 0, cached: 0, generated: 0, failed: 0 })
  const lazyInstallQueue = useRef<FontItem[]>([])
  const queuedLazyInstallIds = useRef<Set<string>>(new Set())
  const seenLazyInstallIds = useRef<Set<string>>(new Set())
  const knownInstallStatusIds = useRef<Set<string>>(new Set())
  const activeLazyInstallDetect = useRef(false)
  const lazyInstallDetectTimerRef = useRef<number | null>(null)
  const lazyInstallDetectRunId = useRef(0)
  const activeOperationFontIds = useRef<Set<string>>(new Set())
  const fontScrollerRef = useRef<HTMLDivElement | null>(null)
  const scrollRafRef = useRef<number | null>(null)
  const lastScrollTraceAtRef = useRef(0)
  const latestVisibleFontsRef = useRef<FontItem[]>([])
  const latestViewLayoutRef = useRef(VIEW_MODE_LAYOUT.comfortable)
  const lastUserActivityReportAtRef = useRef(0)
  const rendererUserActiveUntilRef = useRef(0)
  const indexOperationRunIdRef = useRef(0)
  const autoRefreshTimerRef = useRef<number | null>(null)
  const selectionBaseFontIdsRef = useRef<string[]>([])
  const libraryLoadedRef = useRef(false)
  const autoInstallStatusRefreshStartedRef = useRef(false)
  const autoInstallStatusRefreshSignatureRef = useRef('')
  const initialLibraryLoadStartedRef = useRef(false)
  const developerStatusRefreshInFlightRef = useRef<Promise<void> | null>(null)
  const sharedMetadataSyncInFlightRef = useRef<Promise<void> | null>(null)
  const lastSharedMetadataSyncCheckAtRef = useRef(0)
  const pageToolbar = pageToolbarStates[sidebarPage]
  const search = pageToolbar.search
  const installStatus = pageToolbar.installStatus || 'all'
  const timeSortMode = pageToolbar.timeSortMode
  const sortMode = pageToolbar.sortMode
  const viewMode = pageToolbar.viewMode
  const selectedWatchedFoldersKey = selectedWatchedFolders.join('\u0000')
  const libraryFoldersKey = (library.folders || []).join('\u0000')
  const selectedFormatsKey = selectedFormats.join('\u0000')
  const selectedScriptsKey = selectedScripts.join('\u0000')
  const activeFilterKey = `${activeFilter.kind}\u0000${activeFilter.id || ''}\u0000${activeFilter.name || ''}`
  const libraryShellSaveKey = useMemo(
    () => libraryShellPersistenceKey(library),
    [library.folders, library.folderAliases, library.folderNodes, library.collections, library.tags, library.localCollections, library.localTags, library.previewText, library.previewMode]
  )

  const {
    setLibrary,
    getCurrentLibrary,
    commitLibraryUpdate,
    saveLibraryImmediately,
    flushLibraryPersistence
  } = useLibraryAutosaveRuntime({
    hfm: window.hfm,
    library,
    libraryShellSaveKey,
    libraryLoadedRef,
    setLibrary: setLibraryState,
    setStatus,
    onPersistenceRecovered: refreshDatabaseDerivedState
  })

  function appendDeveloperStatus(source: string, message: string, payload?: unknown): void {
    if (!IS_DEVELOPMENT) return
    setDeveloperStatusLog((prev) => appendDeveloperStatusEntry(prev, source, message, payload))
  }

  function reportUserActivity(reason = 'interaction', durationMs = USER_ACTIVITY_IDLE_WINDOW_MS): void {
    reportRendererUserActivity({
      activeUntilRef: rendererUserActiveUntilRef,
      lastReportAtRef: lastUserActivityReportAtRef,
      hfm: window.hfm,
      reason,
      durationMs,
      reportIntervalMs: USER_ACTIVITY_REPORT_INTERVAL_MS
    })
  }

  function rendererUserActive(): boolean {
    return isRendererUserActive(rendererUserActiveUntilRef)
  }

  function setCardPoolViewMode(mode: CardPoolViewMode): void {
    if (mode === cardPoolViewMode) return
    runAfterScrollPreservingMutation(
      () => setStoredCardPoolViewMode(mode),
      selectedFontId || selectedFontIds[0] || ''
    )
  }

  function refreshDeveloperStatusDetails(): Promise<void> {
    if (!IS_DEVELOPMENT) return Promise.resolve()
    if (developerStatusRefreshInFlightRef.current) return developerStatusRefreshInFlightRef.current

    const task = refreshDeveloperStatusDetailsRuntime({
      enabled: IS_DEVELOPMENT,
      hfm: window.hfm,
      setArchitecture: setDeveloperArchitecture,
      setSchedulerStatus: setDeveloperSchedulerStatus,
      setMigrationDiagnostics: setDeveloperMigrationDiagnostics,
      setSharedMetadataDiagnostics: setDeveloperSharedMetadataDiagnostics,
      setTasks: setDeveloperTasks,
      appendStatus: appendDeveloperStatus
    }).finally(() => {
      if (developerStatusRefreshInFlightRef.current === task) {
        developerStatusRefreshInFlightRef.current = null
      }
    })

    developerStatusRefreshInFlightRef.current = task
    return task
  }

  function refreshDatabaseDerivedState(): void {
    refreshDatabaseDerivedStateRuntime({
      timerRef: databaseRefreshTimerRef,
      clearTimeout: window.clearTimeout,
      setDatabasePageResult,
      setDatabaseQueryResult,
      setDatabaseFontMetrics,
      setDatabaseRefreshToken,
      databasePageRequestSeqRef,
      fontMetricsRequestSeqRef
    })
  }

  function scheduleDatabaseDerivedStateRefresh(delay = 420): void {
    scheduleDatabaseDerivedStateRefreshRuntime({
      timerRef: databaseRefreshTimerRef,
      delay,
      clearTimeout: window.clearTimeout,
      setTimeout: window.setTimeout,
      requestIdleWindow,
      rendererUserActive,
      scheduleAgain: scheduleDatabaseDerivedStateRefresh,
      setDatabaseRefreshToken
    })
  }

  function refreshDatabaseMetricsNow(): void {
    if (typeof window.hfm.getFontMetrics !== 'function') {
      setDatabaseFontMetrics(null)
      return
    }

    void window.hfm.getFontMetrics()
      .then((metrics) => {
        setDatabaseFontMetrics(normalizeFontMetricsResult(metrics))
      })
      .catch(() => setDatabaseFontMetrics(null))
  }

  function checkSharedMetadataUpdates(reason: string, minIntervalMs = 5000): Promise<void> | null {
    return runSharedMetadataSyncCheckRuntime({
      hfm: window.hfm,
      reason,
      foldersLength: library.folders.length,
      indexingActive,
      libraryLoadedRef,
      inFlightRef: sharedMetadataSyncInFlightRef,
      lastCheckedAtRef: lastSharedMetadataSyncCheckAtRef,
      minIntervalMs,
      refreshDatabaseDerivedState,
      setStatus,
      appendDeveloperStatus
    })
  }

  const fontWriteQueueRuntime = createRendererFontWriteQueueRuntime({
    queueRef: fontWriteQueue,
    timerRef: fontWriteFlushTimerRef,
    retryTimerRef: fontWriteRetryTimerRef,
    retryAttemptRef: fontWriteRetryAttemptRef,
    activeRef: fontWriteFlushActiveRef,
    activePromiseRef: fontWriteFlushActivePromiseRef,
    hfm: window.hfm,
    getFolders: () => getCurrentLibrary().folders || [],
    writeBehindDelayMs: WRITE_BEHIND_DELAY_MS,
    writeBehindMaxItems: WRITE_BEHIND_MAX_ITEMS,
    writeBehindMaxBufferBytes: WRITE_BEHIND_MAX_BUFFER_BYTES,
    memoryPressure: rendererMemoryPressure,
    setTimeout: window.setTimeout,
    clearTimeout: window.clearTimeout,
    setStatus,
    scheduleDatabaseDerivedStateRefresh
  })

  const clearQueuedFontWriteTimer = fontWriteQueueRuntime.clearTimer
  const queueLocalTagsWrite = fontWriteQueueRuntime.queueLocalTagsWrite
  const queueSharedTagsWrite = fontWriteQueueRuntime.queueSharedTagsWrite
  const queueFavoriteWrite = fontWriteQueueRuntime.queueFavoriteWrite
  const queueProtectionWrite = fontWriteQueueRuntime.queueProtectionWrite
  const flushFontWriteQueue = fontWriteQueueRuntime.flush

  const systemActionRuntime = createFontSystemActionRuntime({
    hfm: window.hfm,
    library,
    getCurrentLibrary,
    getCurrentSelectedFontId: () => selectedFontIdRef.current,
    selectedFontId,
    activeOperationFontIds,
    setLibrary,
    setStatus,
    setSelectedFontIds,
    setSelectedFontId,
    setDetailVisible,
    setContextMenu,
    setDatabaseFontMetrics,
    refreshDatabaseDerivedState,
    queueFavoriteWrite
  })
  const updateFont = systemActionRuntime.updateFont
  const toggleFontFavorite = systemActionRuntime.toggleFontFavorite
  const fontsForTag = systemActionRuntime.fontsForTag
  const installFontByCard = systemActionRuntime.installFontByCard
  const removeFontByCard = systemActionRuntime.removeFontByCard
  const deleteFontsBatch = systemActionRuntime.deleteFontsBatch
  const uninstallFontsBatch = systemActionRuntime.uninstallFontsBatch
  const activateFontByCard = systemActionRuntime.activateFontByCard
  const activateFontsBatch = systemActionRuntime.activateFontsBatch
  const deactivateFontByCard = systemActionRuntime.deactivateFontByCard
  const deactivateFontsBatch = systemActionRuntime.deactivateFontsBatch

  const previewQueueRuntime = createFontPreviewQueueRuntime({
    hfm: window.hfm,
    previewFamilies,
    nativePreviewImages,
    failedPreviewFontIds,
    previewText: library.previewText,
    listPreviewFontSize,
    previewRequestTokenRef,
    selectedFontId,
    selectedFontIds,
    indexingActive,
    fontListScrollingRef,
    loadingFonts,
    previewQueue,
    queuedPreviewFontIds,
    activePreviewLoads,
    autoPreviewCacheQueue,
    queuedAutoPreviewCacheIds,
    activeAutoPreviewCacheLoads,
    autoPreviewCacheRunId,
    autoPreviewCacheStats,
    rendererUserActive,
    isBadFontRecord: isDefinitelyBadFontRecord,
    setPreviewFamilies,
    setFailedPreviewFontIds,
    setNativePreviewImages,
    setNativeDetailImage,
    setStatus,
    updateFont
  })
  const resetPreviewRuntimeState = previewQueueRuntime.resetPreviewRuntimeState
  const processPreviewQueue = previewQueueRuntime.processPreviewQueue
  const requestPreviewFont = previewQueueRuntime.requestPreviewFont
  const processAutoPreviewCacheQueue = previewQueueRuntime.processAutoPreviewCacheQueue

  usePreviewTextResetRuntime({
    previewText: library.previewText,
    listPreviewFontSize,
    resetPreviewRuntimeState
  })

  const installStatusRuntime = createFontInstallStatusRuntime({
    hfm: window.hfm,
    library,
    lazyInstallQueue,
    queuedLazyInstallIds,
    seenLazyInstallIds,
    knownInstallStatusIds,
    activeLazyInstallDetect,
    lazyInstallDetectTimerRef,
    lazyInstallDetectRunId,
    setLibrary,
    setStatus,
    setDatabasePageResult,
    setDatabaseQueryResult,
    setDatabaseFontMetrics,
    setDatabaseRefreshToken
  })
  const startBackgroundInstallStatusRefresh = installStatusRuntime.startBackgroundInstallStatusRefresh
  const stopLazyInstallStatusDetect = installStatusRuntime.stopLazyInstallStatusDetect

  const toolbarFilterRuntime = createFontToolbarFilterRuntime({
    sidebarPage,
    setPageToolbarStates,
    reportUserActivity,
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

  const {
    captureFontScrollSnapshot,
    restoreFontScrollSnapshot,
    updateViewModeWithScroll,
    runAfterScrollPreservingMutation
  } = createAppFontScrollRestoreRuntime({
    fontScrollerRef,
    latestVisibleFontsRef,
    latestViewLayoutRef,
    virtualViewportWidth: virtualViewport.width,
    setVirtualViewport,
    panelPadding: VIRTUAL_PANEL_PADDING,
    getVirtualGridColumns,
    viewMode,
    selectedFontId: selectedFontId || selectedFontIds[0] || '',
    updatePageToolbar
  })

  const libraryIndexActionRuntime = createFontLibraryIndexActionRuntime({
    hfm: window.hfm,
    library,
    selectedFolderId,
    autoInstallStatusRefreshStartedRef,
    knownInstallStatusIds,
    setLibrary,
    getCurrentLibrary,
    commitLibraryUpdate,
    setStatus,
    setCacheStats,
    setContextMenu,
    setSelectedFolderId,
    setDatabasePageResult,
    setDatabaseQueryResult,
    setDatabaseFontMetrics,
    setDatabaseRefreshToken,
    setIndexingActive,
    setFailedPreviewFontIds,
    setNativePreviewImages,
    setNativeDetailImage,
    nextIndexOperationRunId,
    isCurrentIndexOperation,
    captureFontScrollSnapshot,
    restoreFontScrollSnapshot,
    saveLibraryImmediately,
    stopLazyInstallStatusDetect,
    startBackgroundInstallStatusRefresh,
    resetPreviewRuntimeState,
    isBadFontRecord: isDefinitelyBadFontRecord
  })
  const loadCacheStats = libraryIndexActionRuntime.loadCacheStats
  const readPhysicalFolderTree = libraryIndexActionRuntime.readPhysicalFolderTree
  const clearAllCacheAction = libraryIndexActionRuntime.clearAllCacheAction
  const addFolder = libraryIndexActionRuntime.addFolder
  const cancelIndexing = libraryIndexActionRuntime.cancelIndexing
  const rescan = libraryIndexActionRuntime.rescan
  const rebuildScanCache = libraryIndexActionRuntime.rebuildScanCache
  const refreshFolderTarget = libraryIndexActionRuntime.refreshFolderTarget

  const contextActionRuntime = createFontContextActionRuntime({
    library,
    contextMenu,
    selectedFontIds,
    menuWidth: CONTEXT_MENU_WIDTH,
    menuMaxHeight: CONTEXT_MENU_MAX_HEIGHT,
    viewport: window,
    setSelectedFontIds,
    setSelectionAnchorFontId,
    setSelectedFontId,
    setContextMenu,
    installFontByCard,
    removeFontByCard,
    activateFontByCard,
    deactivateFontByCard,
    activateFontsBatch,
    deactivateFontsBatch,
    deleteFontsBatch,
    toggleFontDeleteProtection
  })
  const setSingleFontSelection = contextActionRuntime.setSingleFontSelection
  const selectionLabel = contextActionRuntime.selectionLabel
  const contextFontTargets = contextActionRuntime.contextFontTargets
  const openTagMenu = contextActionRuntime.openTagMenu
  const openSharedTagMenu = contextActionRuntime.openSharedTagMenu
  const openFolderMenu = contextActionRuntime.openFolderMenu
  const openFontMenu = contextActionRuntime.openFontMenu
  const runFontContextAction = contextActionRuntime.runFontContextAction

  const folderTreeRuntime = createFontFolderTreeRuntime({
    selectedFolderId,
    selectedFontId,
    draggingFontId,
    autoRefreshTimerRef,
    previewQueue,
    autoPreviewCacheQueue,
    lazyInstallQueue,
    queuedPreviewFontIds,
    queuedAutoPreviewCacheIds,
    queuedLazyInstallIds,
    seenLazyInstallIds,
    loadingFonts,
    clearTimeout: window.clearTimeout,
    hfm: window.hfm,
    readPhysicalFolderTree,
    getCurrentLibrary,
    commitLibraryUpdate,
    saveLibraryImmediately,
    setExpandedFolderIds,
    setSelectedFolderId,
    setDraggingFontId,
    setSelectedFontId,
    setSelectedFontIds,
    setDetailVisible,
    setNativeDetailImage,
    setNativePreviewImages,
    setFailedPreviewFontIds,
    setDatabasePageResult,
    setDatabaseQueryResult,
    setDatabaseFontMetrics,
    setDatabaseRefreshToken,
    setStatus
  })
  const selectFolderFilter = folderTreeRuntime.selectFolderFilter
  const toggleFolderExpanded = folderTreeRuntime.toggleFolderExpanded
  const createSubfolder = folderTreeRuntime.createSubfolder
  const assignFontsToFolder = folderTreeRuntime.assignFontsToFolder
  const fontIdsFromDropEvent = folderTreeRuntime.fontIdsFromDropEvent
  const removeFolderTarget = folderTreeRuntime.removeFolderTarget

  const deferredSearch = useDeferredValue(search)


  async function toggleFontDeleteProtection(fontIds: string[], protect?: boolean): Promise<void> {
    setContextMenu(null)
    const ids = Array.from(new Set(fontIds)).filter((id) => !!library.fonts[id])
    if (!ids.length) return
    const nextValue = typeof protect === 'boolean' ? protect : !ids.every((id) => !!library.fonts[id]?.deleteProtected)
    const targetFonts = ids.map((id) => library.fonts[id]).filter((font): font is FontItem => !!font)

    setLibrary((prev) => {
      const nextFonts = { ...prev.fonts }
      for (const id of ids) {
        const font = nextFonts[id]
        if (!font) continue
        nextFonts[id] = { ...font, deleteProtected: nextValue }
      }
      return { ...prev, fonts: nextFonts }
    })

    for (const font of targetFonts) queueProtectionWrite(font, nextValue)
    setStatus(`${nextValue ? '加入保护' : '取消保护'}已在界面生效，后台队列写入 ${targetFonts.length} 个。`)
  }

  useAppThemeRuntime(themeMode)

  useRendererDeveloperStatusLogRuntime(status, appendDeveloperStatus)

  useEffect(() => {
    const notice = parseLeaseLockConflictNotice(status)
    if (notice) setLeaseLockConflictNotice(notice)
  }, [status])

  useFolderFilterPruneRuntime({
    library,
    setExpandedFolderIds,
    setSelectedWatchedFolders
  })

  useTagSelectionPruneRuntime({
    library,
    selectedTagName,
    selectedSharedTagName,
    setSelectedTagName,
    setSelectedSharedTagName,
    refreshDatabaseDerivedState
  })


  useInitialLibraryShellRuntime({
    hfm: window.hfm,
    initialLibraryLoadStartedRef,
    libraryLoadedRef,
    setLibrary,
    setStatus,
    setDatabasePageResult,
    setDatabaseQueryResult,
    setDatabaseRefreshToken
  })

  useSharedMetadataSyncForegroundRuntime({
    enabled: typeof window.hfm.checkSharedMetadataUpdates === 'function',
    libraryFoldersKey,
    indexingActive,
    checkSharedMetadataUpdates
  })

  useAppFlushOnUnloadRuntime({
    hfm: window.hfm,
    databaseRefreshTimerRef,
    fontListScrollIdleTimerRef,
    clearQueuedFontWriteTimer,
    flushFontWriteQueue,
    flushLibraryPersistence
  })


  useRendererActivityRuntime({
    hfm: window.hfm,
    sidebarPage,
    reportUserActivity
  })


  useWatchedFoldersRuntime({
    hfm: window.hfm,
    folders: library.folders || [],
    setStatus
  })


  useFoldersChangedEventRuntime({
    hfm: window.hfm,
    folders: library.folders || [],
    autoRefreshTimerRef,
    setStatus
  })


  useFontIndexProgressEventRuntime({
    hfm: window.hfm,
    setLatestIndexProgress,
    setIndexingActive,
    setStatus,
    appendDeveloperStatus
  })


  useInstallStatusProgressEventRuntime({
    hfm: window.hfm,
    knownInstallStatusIds,
    autoInstallStatusRefreshStartedRef,
    appendDeveloperStatus,
    setStatus,
    refreshDatabaseDerivedState,
    refreshDatabaseMetricsNow
  })


  usePreviewQueueResumeRuntime({
    indexingActive,
    processPreviewQueue,
    processAutoPreviewCacheQueue
  })


  useBackgroundTaskEventsRuntime({
    enabled: IS_DEVELOPMENT,
    hfm: window.hfm,
    setLatestBackgroundTaskEvent,
    appendDeveloperStatus,
    refreshDeveloperStatusDetails
  })


  useFontIndexChangedEventRuntime({
    hfm: window.hfm,
    selectedFontId,
    previewQueue,
    autoPreviewCacheQueue,
    queuedPreviewFontIds,
    queuedAutoPreviewCacheIds,
    loadingFonts,
    captureFontScrollSnapshot,
    restoreFontScrollSnapshot,
    getCurrentLibrary,
    commitLibraryUpdate,
    saveLibraryImmediately,
    requestPreviewFont,
    loadCacheStats,
    refreshDatabaseDerivedState,
    setSelectedFontIds,
    setNativePreviewImages,
    setFailedPreviewFontIds,
    setSelectedFontId,
    setDetailVisible,
    setNativeDetailImage,
    setStatus
  })


  useFontTagStateSignalEventRuntime({
    hfm: window.hfm,
    getCurrentLibrary,
    commitLibraryUpdate,
    saveLibraryImmediately,
    refreshDatabaseDerivedState,
    setStatus
  })


  function nextIndexOperationRunId(): number {
    indexOperationRunIdRef.current += 1
    return indexOperationRunIdRef.current
  }

  function isCurrentIndexOperation(runId: number): boolean {
    return indexOperationRunIdRef.current === runId
  }

  useContextMenuDismissRuntime(setContextMenu)

  useFontFilterScrollResetRuntime({
    fontScrollerRef,
    setVirtualViewport,
    activeFilterKey,
    selectedWatchedFoldersKey,
    selectedFormatsKey,
    selectedScriptsKey,
    selectedCategory,
    selectedTagName,
    selectedSharedTagName,
    selectedFolderId,
    sidebarPage,
    deferredSearch,
    installStatus,
    timeSortMode,
    sortMode
  })

  useFontViewportResizeObserverRuntime({
    fontScrollerRef,
    setVirtualViewport
  })

  const {
    viewLayout,
    cardPoolViewLayout,
    allFonts
  } = useAppFontShellDerivedRuntime({
    library,
    sidebarPage,
    viewMode,
    cardPoolViewMode,
    listPreviewFontSize,
    virtualViewport
  })
  const familyViewAllowed = isFontFamilyViewAllowed(sidebarPage, activeFilter)
  const effectiveCardPoolMode = resolveEffectiveCardPoolViewMode(cardPoolViewMode, sidebarPage, activeFilter)

  const databaseRuntime = useRendererDatabasePageRuntime({
    hfm: window.hfm,
    library,
    libraryLoadedRef,
    databaseRefreshToken,
    databasePageResult,
    databaseQueryFailedKey,
    virtualViewport,
    viewLayout: cardPoolViewLayout,
    skipPageQuery: effectiveCardPoolMode === 'family',
    allFontsLength: allFonts.length,
    sidebarPage,
    indexingActive,
    deferredSearch,
    activeFilter,
    selectedWatchedFolders,
    selectedFormats,
    selectedScripts,
    selectedCategory,
    selectedTagName,
    selectedSharedTagName,
    selectedFolderId,
    selectedFontId,
    selectedFontIds,
    installStatus,
    timeSortMode,
    sortMode,
    fontListScrollingRef,
    fontMetricsRequestSeqRef,
    databasePageRequestSeqRef,
    rendererUserActive,
    reportTrace: reportRendererTrace,
    setDatabaseFontMetrics,
    setDatabasePageResult,
    setDatabaseQueryResult,
    setDatabaseQueryFailedKey,
    setLibrary,
    setStatus
  })
  const databasePageReady = databaseRuntime.databasePageReady
  const displayDatabasePageReady = databasePageReady && !indexingActive
  const visibleFontTotal = displayDatabasePageReady ? databaseRuntime.visibleFontTotal : 0
  const {
    fontFamilyGroupResult,
    fontFamilyGroupLoading,
    fontFamilyGroupError,
    expandedFontFamilyIds,
    toggleFontFamilyExpanded
  } = useFontFamilyGroupsRuntime({
    hfm: window.hfm,
    cardPoolViewMode: effectiveCardPoolMode,
    databaseQueryRequest: databaseRuntime.databaseQueryRequest,
    databaseQueryKey: databaseRuntime.databaseQueryKey,
    shouldUseDatabaseQuery: databaseRuntime.shouldUseDatabaseQuery && familyViewAllowed,
    databaseRefreshToken,
    sidebarPage
  })

  const {
    fontIndexById,
    favoriteCount,
    installedCount,
    notInstalledCount,
    installStatusMissingCount,
    installStatusReady,
    activeCount,
    formatCounts,
    categoryCounts,
    scriptCounts,
    localTagCounts,
    sharedTagCounts,
    localTagList,
    sharedTagList,
    flatFolderNodes,
    folderCounts,
    advancedFilterCount,
    visibleFonts,
    virtualLayout,
    selectedFont,
    selectedFontPreviewFamily,
    selectedNativePreviewImage,
    selectedFailedPreview,
    localTagSuggestions,
    sharedTagSuggestions,
    selectedFontIdSet,
    contextSelectedFonts
  } = useAppFontDerivedRuntime({
    library,
    sidebarPage,
    databasePageReady: displayDatabasePageReady,
    databasePageResult,
    databaseFontMetrics,
    allFonts,
    cardPoolViewLayout,
    virtualViewport,
    activeFilter,
    selectedWatchedFolders,
    selectedFormats,
    selectedScripts,
    selectedCategory,
    selectedTagName,
    selectedSharedTagName,
    selectedFolderId,
    installStatus,
    timeSortMode,
    sortMode,
    deferredSearch,
    expandedFolderIds,
    selectedFontId,
    selectedFontIds,
    contextMenu,
    previewFamilies,
    nativePreviewImages,
    failedPreviewFontIds,
    assignTagName,
    assignSharedTagName,
    latestVisibleFontsRef,
    latestViewLayoutRef,
    requestPreviewFont,
    contextFontTargets
  })
  const installStatusSyncSuffix = installStatusReady ? '' : ' · 同步中'

  useTagSuggestionResetRuntime({
    assignTagName,
    assignSharedTagName,
    selectedFontId,
    setActiveLocalTagSuggestionIndex,
    setActiveSharedTagSuggestionIndex
  })


  const dialogRuntime = createFontDialogRuntime({
    contextMenu,
    renameTarget,
    renameValue,
    deleteTarget,
    selectedFont,
    library,
    selectedTagName,
    selectedSharedTagName,
    hfm: window.hfm,
    watchedFolders: library.folders || [],
    fontsForTag,
    queueLocalTagsWrite,
    queueSharedTagsWrite,
    removeFolderTarget,
    refreshFolderTarget,
    activateFontsBatch,
    deactivateFontsBatch,
    updateFont,
    setLibrary,
    commitLibraryUpdate,
    saveLibraryImmediately,
    setRenameTarget,
    setRenameValue,
    setDeleteTarget,
    setContextMenu,
    setFolderChildTarget,
    setNewFolderName,
    setExpandedFolderIds,
    setSelectedFolderId,
    setSelectedTagName,
    setSelectedSharedTagName,
    setNewTagName,
    setNewSharedTagName,
    setAssignTagName,
    setAssignSharedTagName,
    setSidebarPage,
    setStatus,
    refreshDatabaseDerivedState,
    flushFontWriteQueue
  })
  const runContextRename = dialogRuntime.runContextRename
  const runContextDelete = dialogRuntime.runContextDelete
  const runContextAddSubfolder = dialogRuntime.runContextAddSubfolder
  const runContextRefreshFolder = dialogRuntime.runContextRefreshFolder
  const runContextBatchActivate = dialogRuntime.runContextBatchActivate
  const runContextBatchDeactivate = dialogRuntime.runContextBatchDeactivate
  const confirmRename = dialogRuntime.confirmRename
  const confirmDelete = dialogRuntime.confirmDelete
  const createTagOnlyFromInput = () => dialogRuntime.createTagOnlyFromInput(newTagName)
  const createSharedTagOnlyFromInput = () => dialogRuntime.createSharedTagOnlyFromInput(newSharedTagName)
  const addTagToSelectedByName = dialogRuntime.addTagToSelectedByName
  const addSharedTagToSelectedByName = dialogRuntime.addSharedTagToSelectedByName
  const removeTagFromSelected = dialogRuntime.removeTagFromSelected
  const removeSharedTagFromSelected = dialogRuntime.removeSharedTagFromSelected

  const detailPanelRuntime = createFontDetailPanelRuntime({
    selectedFont,
    detailVisible,
    selectedFontId,
    previewFamilies,
    library,
    setLibrary,
    setSelectedFontId,
    setDetailVisible,
    setNativeDetailImage,
    hfm: window.hfm,
    localTagSuggestions,
    activeLocalTagSuggestionIndex,
    assignTagName,
    setActiveLocalTagSuggestionIndex,
    addTagToSelectedByName,
    setAssignTagName,
    sharedTagSuggestions,
    activeSharedTagSuggestionIndex,
    assignSharedTagName,
    setActiveSharedTagSuggestionIndex,
    addSharedTagToSelectedByName,
    setAssignSharedTagName,
    installFontByCard,
    removeFontByCard,
    activateFontByCard,
    deactivateFontByCard
  })
  const selectedPreviewFamily = detailPanelRuntime.selectedPreviewFamily
  const closeDetail = detailPanelRuntime.closeDetail
  const toggleFontDetail = detailPanelRuntime.toggleFontDetail
  const generateDetailNativePreview = detailPanelRuntime.generateDetailNativePreview
  const setPreviewText = detailPanelRuntime.setPreviewText
  const handleLocalTagInputKeyDown = detailPanelRuntime.handleLocalTagInputKeyDown
  const handleSharedTagInputKeyDown = detailPanelRuntime.handleSharedTagInputKeyDown
  const installSelected = detailPanelRuntime.installSelected
  const removeSelected = detailPanelRuntime.removeSelected
  const activateSelected = detailPanelRuntime.activateSelected
  const deactivateSelected = detailPanelRuntime.deactivateSelected

  useFontDetailSelectionEffectsRuntime({
    library,
    visibleFonts,
    selectedFontId,
    selectedFont,
    detailVisible,
    setSelectedFontIds,
    setSelectedFontId,
    requestPreviewFont,
    isBadFontRecord: isDefinitelyBadFontRecord
  })

  useFontDetailNativePreviewRuntime({
    hfm: window.hfm,
    detailVisible,
    selectedFont,
    selectedFontPreviewFamily,
    selectedFailedPreview,
    selectedNativePreviewImage,
    previewText: library.previewText,
    requestSeqRef: detailNativePreviewRequestSeqRef,
    setNativeDetailImage,
    isBadFontRecord: isDefinitelyBadFontRecord
  })

  useAutoInstallStatusRefreshRuntime({
    hfm: window.hfm,
    databaseFontMetrics,
    libraryFolders: library.folders,
    indexingActive,
    startedRef: autoInstallStatusRefreshStartedRef,
    signatureRef: autoInstallStatusRefreshSignatureRef,
    startBackgroundInstallStatusRefresh
  })

  const selectionRuntime = createAppFontSelectionInteractionRuntime({
    visibleFonts,
    selectedFontId,
    selectionAnchorFontId,
    selectedFontIds,
    selectionBaseFontIdsRef,
    setSelectedFontIds,
    setSelectionAnchorFontId,
    setSelectedFontId,
    setDetailVisible,
    detailVisible,
    detailCardClickLockUntilRef,
    setSelectionRect,
    setStatus,
    setSingleFontSelection,
    requestDetailReveal: setPendingDetailRevealFontId,
    toggleFontDetail,
    reportUserActivity,
    userActivityIdleWindowMs: USER_ACTIVITY_IDLE_WINDOW_MS
  })

  function handleFontSelect(event: Parameters<typeof selectionRuntime.handleFontSelect>[0], font: FontItem): void {
    hydrateFontForSelectionDetail(font, setLibrary)
    selectionRuntime.handleFontSelect(event, font)
  }

  function handleFontOpenDetail(event: Parameters<typeof selectionRuntime.handleFontOpenDetail>[0], font: FontItem): void {
    hydrateFontForSelectionDetail(font, setLibrary)
    selectionRuntime.handleFontOpenDetail(event, font)
  }

  const { beginMarqueeSelection } = selectionRuntime

  const handleFontScroll = useFontListScrollRuntime({
    sidebarPage,
    virtualLayout,
    databasePageReady: displayDatabasePageReady,
    visibleFontTotal,
    visibleFontsLength: visibleFonts.length,
    scrollRafRef,
    lastScrollTraceAtRef,
    fontListScrollingRef,
    fontListScrollIdleTimerRef,
    previewScrollIdleMs: PREVIEW_SCROLL_IDLE_MS,
    userActivityIdleWindowMs: USER_ACTIVITY_IDLE_WINDOW_MS,
    reportUserActivity,
    processPreviewQueue,
    processAutoPreviewCacheQueue,
    reportTrace: reportRendererTrace,
    setVirtualViewport
  })

  usePendingDetailRevealRuntime({
    detailVisible,
    pendingDetailRevealFontId,
    fontScrollerRef,
    virtualLayout,
    virtualViewport,
    setVirtualViewport,
    setPendingDetailRevealFontId
  })

  const { renderFontCard } = createFontCardRenderer({
    detailVisible,
    selectedFontId: selectedFont?.id,
    selectedFontIdSet,
    previewFamilies,
    nativePreviewImages,
    previewText: library.previewText,
    listPreviewFontSize,
    selectedFontIds,
    handleFontSelect,
    handleFontOpenDetail,
    requestPreviewFont,
    fontListScrolling: () => fontListScrollingRef.current,
    openFontMenu,
    setDraggingFontId
  })

  return (
    <AppRootView
      IS_DEVELOPMENT={IS_DEVELOPMENT}
      status={status}
      themeMode={themeMode}
      setThemeMode={setThemeMode}
      indexingActive={indexingActive}
      cacheMenuOpen={cacheMenuOpen}
      setCacheMenuOpen={setCacheMenuOpen}
      rescan={rescan}
      cancelIndexing={cancelIndexing}
      rebuildScanCache={rebuildScanCache}
      clearAllCacheAction={clearAllCacheAction}
      detailVisible={detailVisible}
      sidebarPage={sidebarPage}
      setSidebarPage={setSidebarPage}
      activeFilter={activeFilter}
      setActiveFilter={setActiveFilter}
      advancedFilterCount={advancedFilterCount}
      refreshDeveloperStatusDetails={refreshDeveloperStatusDetails}
      categoryCounts={categoryCounts}
      allFonts={allFonts}
      favoriteCount={favoriteCount}
      installedCount={installedCount}
      notInstalledCount={notInstalledCount}
      activeCount={activeCount}
      library={library}
      setPreviewText={setPreviewText}
      installStatusReady={installStatusReady}
      installStatusMissingCount={installStatusMissingCount}
      installStatusSyncSuffix={installStatusSyncSuffix}
      expandedFilterGroups={expandedFilterGroups}
      setFilterGroupExpanded={setFilterGroupExpanded}
      selectedWatchedFolders={selectedWatchedFolders}
      setSelectedWatchedFolders={setSelectedWatchedFolders}
      folderCounts={folderCounts}
      selectedFormats={selectedFormats}
      setSelectedFormats={setSelectedFormats}
      formatCounts={formatCounts}
      selectedScripts={selectedScripts}
      setSelectedScripts={setSelectedScripts}
      scriptCounts={scriptCounts}
      selectedCategory={selectedCategory}
      setSelectedCategory={setSelectedCategory}
      clearAdvancedFilters={clearAdvancedFilters}
      newSharedTagName={newSharedTagName}
      setNewSharedTagName={setNewSharedTagName}
      createSharedTagOnlyFromInput={createSharedTagOnlyFromInput}
      sharedTagList={sharedTagList}
      selectedSharedTagName={selectedSharedTagName}
      setSelectedSharedTagName={setSelectedSharedTagName}
      openSharedTagMenu={openSharedTagMenu}
      sharedTagCounts={sharedTagCounts}
      newTagName={newTagName}
      setNewTagName={setNewTagName}
      createTagOnlyFromInput={createTagOnlyFromInput}
      localTagList={localTagList}
      selectedTagName={selectedTagName}
      setSelectedTagName={setSelectedTagName}
      openTagMenu={openTagMenu}
      localTagCounts={localTagCounts}
      addFolder={addFolder}
      selectedFolderId={selectedFolderId}
      setDatabasePageResult={setDatabasePageResult}
      setDatabaseQueryResult={setDatabaseQueryResult}
      setSelectedFolderId={setSelectedFolderId}
      expandedFolderIds={expandedFolderIds}
      dropHoverFolderId={dropHoverFolderId}
      setDropHoverFolderId={setDropHoverFolderId}
      selectFolderFilter={selectFolderFilter}
      openFolderMenu={openFolderMenu}
      fontIdsFromDropEvent={fontIdsFromDropEvent}
      assignFontsToFolder={assignFontsToFolder}
      toggleFolderExpanded={toggleFolderExpanded}
      flatFolderNodes={flatFolderNodes}
      setDeveloperStatusLog={setDeveloperStatusLog}
      latestIndexProgress={latestIndexProgress}
      developerArchitecture={developerArchitecture}
      developerSchedulerStatus={developerSchedulerStatus}
      developerMigrationDiagnostics={developerMigrationDiagnostics}
      developerSharedMetadataDiagnostics={developerSharedMetadataDiagnostics}
      setDeveloperSharedMetadataDiagnostics={setDeveloperSharedMetadataDiagnostics}
      latestBackgroundTaskEvent={latestBackgroundTaskEvent}
      developerTasks={developerTasks}
      developerStatusLog={developerStatusLog}
      timeSortMode={timeSortMode}
      sortMode={sortMode}
      viewMode={viewMode}
      cardPoolViewMode={cardPoolViewMode}
      setCardPoolViewMode={setCardPoolViewMode}
      listPreviewFontSize={listPreviewFontSize}
      setListPreviewFontSize={setListPreviewFontSize}
      updatePageToolbar={updatePageToolbar}
      updateViewModeWithScroll={updateViewModeWithScroll}
      search={search}
      selectedFontIds={selectedFontIds}
      activateFontsBatch={activateFontsBatch}
      deactivateFontsBatch={deactivateFontsBatch}
      deleteFontsBatch={deleteFontsBatch}
      uninstallFontsBatch={uninstallFontsBatch}
      toggleFontDeleteProtection={toggleFontDeleteProtection}
      setSelectedFontIds={setSelectedFontIds}
      closeDetail={closeDetail}
      fontScrollerRef={fontScrollerRef}
      handleFontScroll={handleFontScroll}
      beginMarqueeSelection={beginMarqueeSelection}
      virtualLayout={virtualLayout}
      cardPoolViewLayout={cardPoolViewLayout}
      renderFontCard={renderFontCard}
      databasePageReady={displayDatabasePageReady}
      visibleFontTotal={visibleFontTotal}
      visibleFonts={visibleFonts}
      fontFamilyGroupResult={fontFamilyGroupResult}
      fontFamilyGroupLoading={fontFamilyGroupLoading}
      fontFamilyGroupError={fontFamilyGroupError}
      expandedFontFamilyIds={expandedFontFamilyIds}
      toggleFontFamilyExpanded={toggleFontFamilyExpanded}
      leaseLockConflictNotice={leaseLockConflictNotice}
      setLeaseLockConflictNotice={setLeaseLockConflictNotice}
      selectedFont={selectedFont}
      previewFamilies={previewFamilies}
      selectedPreviewFamily={selectedPreviewFamily}
      nativeDetailImage={nativeDetailImage}
      toggleFontFavorite={toggleFontFavorite}
      installSelected={installSelected}
      removeSelected={removeSelected}
      activateSelected={activateSelected}
      deactivateSelected={deactivateSelected}
      assignTagName={assignTagName}
      setAssignTagName={setAssignTagName}
      handleLocalTagInputKeyDown={handleLocalTagInputKeyDown}
      localTagSuggestions={localTagSuggestions}
      activeLocalTagSuggestionIndex={activeLocalTagSuggestionIndex}
      setActiveLocalTagSuggestionIndex={setActiveLocalTagSuggestionIndex}
      addTagToSelectedByName={addTagToSelectedByName}
      removeTagFromSelected={removeTagFromSelected}
      assignSharedTagName={assignSharedTagName}
      setAssignSharedTagName={setAssignSharedTagName}
      handleSharedTagInputKeyDown={handleSharedTagInputKeyDown}
      sharedTagSuggestions={sharedTagSuggestions}
      activeSharedTagSuggestionIndex={activeSharedTagSuggestionIndex}
      setActiveSharedTagSuggestionIndex={setActiveSharedTagSuggestionIndex}
      addSharedTagToSelectedByName={addSharedTagToSelectedByName}
      removeSharedTagFromSelected={removeSharedTagFromSelected}
      updateFont={updateFont}
      applyInstallCompareToFont={applyInstallCompareToFont}
      renameTarget={renameTarget}
      setRenameTarget={setRenameTarget}
      renameValue={renameValue}
      setRenameValue={setRenameValue}
      confirmRename={confirmRename}
      deleteTarget={deleteTarget}
      setDeleteTarget={setDeleteTarget}
      confirmDelete={confirmDelete}
      folderChildTarget={folderChildTarget}
      setFolderChildTarget={setFolderChildTarget}
      newFolderName={newFolderName}
      setNewFolderName={setNewFolderName}
      createSubfolder={createSubfolder}
      selectionRect={selectionRect}
      normalizedSelectionRect={normalizedSelectionRect}
      contextMenu={contextMenu}
      contextSelectedFonts={contextSelectedFonts}
      selectionLabel={selectionLabel}
      runFontContextAction={runFontContextAction}
      runContextBatchActivate={runContextBatchActivate}
      runContextBatchDeactivate={runContextBatchDeactivate}
      runContextRefreshFolder={runContextRefreshFolder}
      runContextRename={runContextRename}
      runContextAddSubfolder={runContextAddSubfolder}
      runContextDelete={runContextDelete}
    />
  )
}
