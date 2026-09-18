import { flushSync } from 'react-dom'
import type { FontItem } from '@shared/types'
import { useDeferredValue } from 'react'
import { useBrowseController } from './runtime/app/useBrowseController'
import type {
CardPoolViewMode,
} from './appRuntime'
import {
libraryWithMergedFonts,
CONTEXT_MENU_MAX_HEIGHT,
CONTEXT_MENU_WIDTH,
getVirtualGridColumns,
IS_DEVELOPMENT,
isDefinitelyBadFontRecord,
PREVIEW_PREFETCH_LIMIT,
PREVIEW_SCROLL_IDLE_MS,
reportRendererTrace,
USER_ACTIVITY_IDLE_WINDOW_MS,
VIRTUAL_PANEL_PADDING,
} from './appRuntime'
import { AppRootView } from './components/app/AppRootView'
import type { AppRootViewProps } from './components/app/AppRootView'
import { useFontCardRenderer } from './components/app/FontCardRenderer'
import { createAppMenuDialogRuntime } from './runtime/app/createAppMenuDialogRuntime'
import { createAppDetailSelectionRuntime } from './runtime/app/createAppDetailSelectionRuntime'
import { createAppControllerPorts } from './runtime/app/createAppControllerPorts'
import {
pruneExpandedFolderIds,
pruneSelectedWatchedFolders
} from './fontFilterStateRuntime'
import {
applyInstallCompareToFont
} from './fontInstallStateRuntime'
import {
normalizedSelectionRect
} from './fontSelectionRuntime'
import { buildTagSuggestions,buildVirtualLayout,buildVisibleFonts } from './fontViewRuntime'
import type { FontFamilyGroupResult } from './runtime/family/fontFamilyGroupingRuntime'
import { fontFamilyQueryScopeKey,loadFontFamilyGroups } from './runtime/family/fontFamilyGroupingRuntime'
import { useFontDetailNativePreviewRuntime } from './runtime/app/useFontDetailNativePreviewRuntime'
import { useFontDetailSelectionEffectsRuntime } from './runtime/app/useFontDetailSelectionEffectsRuntime'
import { useFontListScrollRuntime } from './runtime/app/useFontListScrollRuntime'
import { usePendingDetailRevealRuntime } from './runtime/app/usePendingDetailRevealRuntime'
import { useRendererDisplayPreferences } from './runtime/app/useRendererDisplayPreferencesRuntime'
import { useRendererReadyNotification } from './runtime/app/useRendererReadyNotificationRuntime'
import { useAppFontShellDerivedRuntime } from './runtime/app/useAppFontShellDerivedRuntime'
import { useAppFontDerivedRuntime } from './runtime/app/useAppFontDerivedRuntime'
import { createAppFontScrollRestoreRuntime } from './runtime/app/useFontScrollRestoreRuntime'
import { useFolderController } from './runtime/app/useFolderController'
import { useDeveloperController } from './runtime/app/useDeveloperController'
import { useFontOperationsController } from './runtime/app/useFontOperationsController'
import { useLibraryController } from './runtime/app/useLibraryController'
import { usePreviewController } from './runtime/app/usePreviewController'
import { useSelectionController } from './runtime/app/useSelectionController'
import { useRendererDatabasePageRuntime } from './runtime/database/useRendererDatabasePageRuntime'
import { setupFloatingScrollbars } from './utils/floatingScrollbars'
import { useAppThemeRuntime } from './runtime/app/effects/useAppThemeRuntime'
import { useFolderFilterPruneRuntime } from './runtime/app/effects/useFolderFilterPruneRuntime'
import { useTagSelectionPruneRuntime } from './runtime/app/effects/useTagSelectionPruneRuntime'
import { useWatchedFoldersRuntime } from './runtime/app/effects/useWatchedFoldersRuntime'
import { useFoldersChangedEventRuntime } from './runtime/app/effects/useFoldersChangedEventRuntime'
import { useFontIndexProgressEventRuntime } from './runtime/app/effects/useFontIndexProgressEventRuntime'
import { usePreviewQueueResumeRuntime } from './runtime/app/effects/usePreviewQueueResumeRuntime'
import { useFontIndexChangedEventRuntime } from './runtime/app/effects/useFontIndexChangedEventRuntime'
import { useFontTagStateSignalEventRuntime } from './runtime/app/effects/useFontTagStateSignalEventRuntime'
import { useContextMenuDismissRuntime } from './runtime/app/effects/useContextMenuDismissRuntime'
import { useFontFilterScrollResetRuntime } from './runtime/app/effects/useFontFilterScrollResetRuntime'
import { useFontViewportResizeObserverRuntime } from './runtime/app/effects/useFontViewportResizeObserverRuntime'
import { useTagSuggestionResetRuntime } from './runtime/app/effects/useTagSuggestionResetRuntime'
import { useFontFamilyGroupsRuntime } from './runtime/app/useFontFamilyGroupsRuntime'
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

  const controllerPorts = createAppControllerPorts()

  useRendererReadyNotification()

  const {
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
  } = useBrowseController({ reportUserActivity })
  const {
    expandedFolderIds,
    setExpandedFolderIds,
    newFolderName,
    setNewFolderName,
    folderChildTarget,
    setFolderChildTarget,
    draggingFontId,
    setDraggingFontId,
    dropHoverFolderId,
    setDropHoverFolderId,
    clearAutoRefreshTimer,
    createRuntime: createFolderRuntime
  } = useFolderController()
  const {
    selectedFontId,
    selectedFontIdRef,
    setSelectedFontId,
    selectedFontIds,
    setSelectedFontIds,
    selectionAnchorFontId,
    setSelectionAnchorFontId,
    selectionRect,
    detailVisible,
    setDetailVisible,
    pendingDetailRevealFontId,
    setPendingDetailRevealFontId,
    assignTagName,
    setAssignTagName,
    assignSharedTagName,
    setAssignSharedTagName,
    activeLocalTagSuggestionIndex,
    setActiveLocalTagSuggestionIndex,
    activeSharedTagSuggestionIndex,
    setActiveSharedTagSuggestionIndex,
    contextMenu,
    setContextMenu,
    renameTarget,
    setRenameTarget,
    renameValue,
    setRenameValue,
    deleteTarget,
    setDeleteTarget,
    removeFontIds: removeSelectedFontIds,
    createInteractionRuntime: createSelectionInteractionRuntime
  } = useSelectionController(JSON.stringify([sidebarPage, activeFilterKey, selectedFolderId, selectedTagName, selectedSharedTagName, search, installStatus, timeSortMode, selectedWatchedFoldersKey, selectedFormatsKey, selectedScriptsKey, selectedCategory]))
  const {
    themeMode,
    setThemeMode,
    cardPoolViewMode,
    setStoredCardPoolViewMode,
    listPreviewFontSize,
    setListPreviewFontSize,
  } = useRendererDisplayPreferences()
  const {
    library,
    setLibrary,
    getCurrentLibrary,
    commitLibraryUpdate,
    saveLibraryImmediately,
    flushLibraryPersistence,
    status,
    setStatus,
    leaseLockConflictNotice,
    setLeaseLockConflictNotice,
    indexingActive,
    setIndexingActive,
    databaseRefreshToken,
    setDatabaseRefreshToken,
    setCacheStats,
    libraryLoadedRef,
    refreshDatabaseDerivedState,
    scheduleDatabaseDerivedStateRefresh,
    refreshDatabaseMetricsNow,
    clearDatabaseRefreshTimer
  } = useLibraryController({
    hfm: window.hfm,
    database: {
      setDatabasePageResult,
      setDatabaseQueryResult,
      setDatabaseFontMetrics,
      databasePageRequestSeqRef,
      fontMetricsRequestSeqRef
    },
    rendererUserActive,
    appendDeveloperStatus
  })

  function appendDeveloperStatus(source: string, message: string, payload?: unknown): void {
    controllerPorts.developer().appendDeveloperStatus(source, message, payload)
  }

  function reportUserActivity(reason = 'interaction', durationMs = USER_ACTIVITY_IDLE_WINDOW_MS): void {
    controllerPorts.operations().reportUserActivity(reason, durationMs)
  }

  function rendererUserActive(): boolean {
    return controllerPorts.operations().rendererUserActive()
  }

  function updateFontFromOperations(fontId: string, updater: (font: FontItem) => FontItem): void {
    controllerPorts.operations().updateFont(fontId, updater)
  }

  const {
    previewFamilies,
    nativePreviewImages,
    nativeDetailImage,
    setNativeDetailImage,
    detailNativePreviewRequestSeqRef,
    failedPreviewFontIds,
    resetPreviewRuntimeState,
    processPreviewQueue,
    requestPreviewFont,
    processAutoPreviewCacheQueue,
    removeFontIds: removePreviewFontIds,
    beginFontListScroll,
    clearFontListScrollIdleTimer,
    fontListScrollingRef,
    isFontListScrolling
  } = usePreviewController({
    hfm: window.hfm,
    previewText: library.previewText,
    listPreviewFontSize,
    selectedFontId,
    selectedFontIds,
    indexingActive,
    rendererUserActive,
    isBadFontRecord: isDefinitelyBadFontRecord,
    setStatus,
    updateFont: updateFontFromOperations
  })

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

  function setCardPoolViewMode(mode: CardPoolViewMode): void {
    if (mode === cardPoolViewMode) return
    runAfterScrollPreservingMutation(
      () => setStoredCardPoolViewMode(mode),
      selectedFontId || selectedFontIds[0] || ''
    )
  }

  const operationsController = useFontOperationsController({
    hfm: window.hfm,
    library: {
      library,
      getCurrentLibrary,
      setLibrary,
      commitLibraryUpdate,
      saveLibraryImmediately,
      flushLibraryPersistence,
      setStatus,
      selectedFolderId,
      setSelectedFolderId,
      indexingActive,
      setIndexingActive,
      setCacheStats,
      clearDatabaseRefreshTimer,
      refreshDatabaseDerivedState,
      scheduleDatabaseDerivedStateRefresh,
      refreshDatabaseMetricsNow
    },
    database: {
      databaseFontMetrics,
      setDatabasePageResult,
      setDatabaseQueryResult,
      setDatabaseFontMetrics,
      setDatabaseRefreshToken
    },
    selection: {
      selectedFontId,
      getCurrentSelectedFontId: () => selectedFontIdRef.current,
      setSelectedFontIds,
      setSelectedFontId,
      setDetailVisible,
      setContextMenu
    },
    index: {
      captureFontScrollSnapshot,
      restoreFontScrollSnapshot,
      resetPreviewRuntimeState,
      isBadFontRecord: isDefinitelyBadFontRecord
    },
    sidebarPage,
    clearFontListScrollIdleTimer,
    appendDeveloperStatus
  })
  controllerPorts.bindOperations({
    reportUserActivity: operationsController.reportUserActivity,
    rendererUserActive: operationsController.rendererUserActive,
    updateFont: operationsController.updateFont
  })
  const {
    cacheMenuOpen,
    setCacheMenuOpen,
    newTagName,
    setNewTagName,
    newSharedTagName,
    setNewSharedTagName,
    updateFont,
    setFontsFavorite,
    fontsForTag,
    installFontsBatch,
    installFontByCard,
    removeFontByCard,
    deleteFontsBatch,
    uninstallFontsBatch,
    activateFontByCard,
    activateFontsBatch,
    deactivateFontByCard,
    deactivateFontsBatch,
    loadCacheStats,
    readPhysicalFolderTree,
    clearAllCacheAction,
    addFolder,
    cancelIndexing,
    rescan,
    rebuildScanCache,
    refreshFolderTarget,
    queueLocalTagsWrite,
    queueSharedTagsWrite,
    flushFontWriteQueue,
    toggleFontDeleteProtection,
    removeFontIds: removeOperationFontIds
  } = operationsController

  const developerController = useDeveloperController({
    enabled: IS_DEVELOPMENT,
    hfm: window.hfm,
    status
  })
  controllerPorts.bindDeveloper({ appendDeveloperStatus: developerController.appendDeveloperStatus })
  const {
    developerStatusLog,
    setDeveloperStatusLog,
    latestIndexProgress,
    setLatestIndexProgress,
    latestBackgroundTaskEvent,
    developerArchitecture,
    developerSchedulerStatus,
    developerMigrationDiagnostics,
    developerSharedMetadataDiagnostics,
    setDeveloperSharedMetadataDiagnostics,
    developerTasks,
    refreshDeveloperStatusDetails
  } = developerController

  const contextActionRuntime = createAppMenuDialogRuntime({
    getCurrentLibrary,
    installFontsBatch,
    uninstallFontsBatch,
    setFontsFavorite,
    editFontTags: (fonts, scope) => {
      flushSync(() => {
        setLibrary(prev => libraryWithMergedFonts(prev, fonts.filter(font => !prev.fonts[font.id]), fonts.map(font => font.id)))
        setSelectedFontId(fonts[0].id)
        setDetailVisible(true)
      })
      document.getElementById(scope === 'local' ? 'font-local-tag-input' : 'font-shared-tag-input')?.focus()
    },
    getVisibleFonts: () => latestVisibleFontsRef.current,
    setStatus,
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
  const { runFontCommand, contextTargetCount, setSingleFontSelection, contextFontTargets, openTagMenu, openSharedTagMenu, openFolderMenu, openFontMenu, runFontContextAction } = contextActionRuntime

  const folderTreeRuntime = createFolderRuntime({
    selectedFolderId,
    cleanupRemovedFontState: cleanupRemovedFolderFontState,
    hfm: window.hfm,
    readPhysicalFolderTree,
    getCurrentLibrary,
    commitLibraryUpdate,
    saveLibraryImmediately,
    setSelectedFolderId,
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

  function cleanupRemovedFontViewState(removedFontIds: string[]): void {
    if (!removedFontIds.length) return
    const removed = new Set(removedFontIds)
    const selectedFontRemoved = removeSelectedFontIds(removed)
    removePreviewFontIds(removed, selectedFontRemoved)
  }

  function cleanupRemovedFolderFontState(removedFontIds: Set<string>): void {
    cleanupRemovedFontViewState(Array.from(removedFontIds))
    removeOperationFontIds(removedFontIds)
  }

  useAppThemeRuntime(themeMode)

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
  useWatchedFoldersRuntime({
    hfm: window.hfm,
    folders: library.folders || [],
    setStatus
  })


  useFoldersChangedEventRuntime({
    hfm: window.hfm,
    folders: library.folders || [],
    clearAutoRefreshTimer,
    setStatus
  })


  useFontIndexProgressEventRuntime({
    hfm: window.hfm,
    setLatestIndexProgress,
    setIndexingActive,
    setStatus,
    appendDeveloperStatus
  })
  usePreviewQueueResumeRuntime({
    indexingActive,
    processPreviewQueue,
    processAutoPreviewCacheQueue
  })
  useFontIndexChangedEventRuntime({
    hfm: window.hfm,
    cleanupRemovedFontState: cleanupRemovedFontViewState,
    captureFontScrollSnapshot,
    restoreFontScrollSnapshot,
    getCurrentLibrary,
    commitLibraryUpdate,
    saveLibraryImmediately,
    requestPreviewFont,
    loadCacheStats,
    refreshDatabaseDerivedState,
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


  const dialogRuntime = contextActionRuntime.createDialogs({
    selectedFontIds,
    getVisibleFonts: () => latestVisibleFontsRef.current,
    renameTarget,
    renameValue,
    deleteTarget,
    selectedFont,
    selectedTagName,
    selectedSharedTagName,
    hfm: window.hfm,
    watchedFolders: library.folders || [],
    fontsForTag,
    queueLocalTagsWrite,
    queueSharedTagsWrite,
    removeFolderTarget,
    refreshFolderTarget,
    updateFont,
    setLibrary,
    commitLibraryUpdate,
    saveLibraryImmediately,
    setRenameTarget,
    setRenameValue,
    setDeleteTarget,
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
  }, newTagName, newSharedTagName)
  const { runContextRename, runContextDelete, runContextAddSubfolder, runContextRefreshFolder, runContextBatchActivate, runContextBatchDeactivate, confirmRename, confirmDelete, addTagToSelectedByName, addSharedTagToSelectedByName, removeTagFromSelected, removeSharedTagFromSelected, createTagOnlyFromInput, createSharedTagOnlyFromInput } = dialogRuntime

  const detailPanelRuntime = createAppDetailSelectionRuntime({
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
  const { selectedPreviewFamily, closeDetail, toggleFontDetail, generateDetailNativePreview, setPreviewText, handleLocalTagInputKeyDown, handleSharedTagInputKeyDown } = detailPanelRuntime

  useFontDetailSelectionEffectsRuntime({
    favoritesOnly: sidebarPage === 'library' && activeFilter.kind === 'favorites',
    library,
    selectedFontIds,
    setLibrary,
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

  const selectionRuntime = detailPanelRuntime.createSelection(createSelectionInteractionRuntime, {
    visibleFonts,
    setStatus,
    setSingleFontSelection,
    reportUserActivity,
    userActivityIdleWindowMs: USER_ACTIVITY_IDLE_WINDOW_MS
  })
  const { handleFontSelect, handleFontOpenDetail, beginMarqueeSelection } = selectionRuntime

  const handleFontScroll = useFontListScrollRuntime({
    sidebarPage,
    virtualLayout,
    databasePageReady: displayDatabasePageReady,
    visibleFontTotal,
    visibleFontsLength: visibleFonts.length,
    scrollRafRef,
    lastScrollTraceAtRef,
    beginFontListScroll,
    previewScrollIdleMs: PREVIEW_SCROLL_IDLE_MS,
    userActivityIdleWindowMs: USER_ACTIVITY_IDLE_WINDOW_MS,
    reportUserActivity,
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

  const { renderFontCard } = useFontCardRenderer({
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
    fontListScrolling: isFontListScrolling,
    openFontMenu,
    setDraggingFontId
  })

  const topbarViewProps: AppRootViewProps['topbar'] = {
    themeMode: themeMode,
    setThemeMode: setThemeMode,
    indexingActive: indexingActive,
    cacheMenuOpen: cacheMenuOpen,
    setCacheMenuOpen: setCacheMenuOpen,
    rescan: rescan,
    cancelIndexing: cancelIndexing,
    rebuildScanCache: rebuildScanCache,
    clearAllCacheAction: clearAllCacheAction,
  }

  const sidebarViewProps: AppRootViewProps['sidebar'] = {
    sidebarPage: sidebarPage,
    setSidebarPage: setSidebarPage,
    activeFilter: activeFilter,
    setActiveFilter: setActiveFilter,
    advancedFilterCount: advancedFilterCount,
    refreshDeveloperStatusDetails: refreshDeveloperStatusDetails,
    categoryCounts: categoryCounts,
    allFonts: allFonts,
    favoriteCount: favoriteCount,
    installedCount: installedCount,
    notInstalledCount: notInstalledCount,
    activeCount: activeCount,
    previewText: library.previewText,
    setPreviewText: setPreviewText,
    installStatusReady: installStatusReady,
    installStatusMissingCount: installStatusMissingCount,
    installStatusSyncSuffix: installStatusSyncSuffix,
    expandedFilterGroups: expandedFilterGroups,
    setFilterGroupExpanded: setFilterGroupExpanded,
    selectedWatchedFolders: selectedWatchedFolders,
    setSelectedWatchedFolders: setSelectedWatchedFolders,
    library: library,
    folderCounts: folderCounts,
    selectedFormats: selectedFormats,
    setSelectedFormats: setSelectedFormats,
    formatCounts: formatCounts,
    selectedScripts: selectedScripts,
    setSelectedScripts: setSelectedScripts,
    scriptCounts: scriptCounts,
    selectedCategory: selectedCategory,
    setSelectedCategory: setSelectedCategory,
    clearAdvancedFilters: clearAdvancedFilters,
    newSharedTagName: newSharedTagName,
    setNewSharedTagName: setNewSharedTagName,
    createSharedTagOnlyFromInput: createSharedTagOnlyFromInput,
    sharedTagList: sharedTagList,
    selectedSharedTagName: selectedSharedTagName,
    setSelectedSharedTagName: setSelectedSharedTagName,
    openSharedTagMenu: openSharedTagMenu,
    sharedTagCounts: sharedTagCounts,
    newTagName: newTagName,
    setNewTagName: setNewTagName,
    createTagOnlyFromInput: createTagOnlyFromInput,
    localTagList: localTagList,
    selectedTagName: selectedTagName,
    setSelectedTagName: setSelectedTagName,
    openTagMenu: openTagMenu,
    localTagCounts: localTagCounts,
    addFolder: addFolder,
    selectedFolderId: selectedFolderId,
    setDatabasePageResult: setDatabasePageResult,
    setDatabaseQueryResult: setDatabaseQueryResult,
    setSelectedFolderId: setSelectedFolderId,
    expandedFolderIds: expandedFolderIds,
    dropHoverFolderId: dropHoverFolderId,
    setDropHoverFolderId: setDropHoverFolderId,
    selectFolderFilter: selectFolderFilter,
    openFolderMenu: openFolderMenu,
    fontIdsFromDropEvent: fontIdsFromDropEvent,
    assignFontsToFolder: assignFontsToFolder,
    toggleFolderExpanded: toggleFolderExpanded,
    flatFolderNodes: flatFolderNodes,
    setDeveloperStatusLog: setDeveloperStatusLog,
  }

  const contentViewProps: AppRootViewProps['content'] = {
    sidebarPage: sidebarPage,
    timeSortMode: timeSortMode,
    sortMode: sortMode,
    viewMode: viewMode,
    cardPoolViewMode: cardPoolViewMode,
    activeFilter: activeFilter,
    setCardPoolViewMode: setCardPoolViewMode,
    listPreviewFontSize: listPreviewFontSize,
    setListPreviewFontSize: setListPreviewFontSize,
    updatePageToolbar: updatePageToolbar,
    updateViewModeWithScroll: updateViewModeWithScroll,
    search: search,
    selectedFontIds: selectedFontIds,
    runFontCommand: runFontCommand,
    setSelectedFontIds: setSelectedFontIds,
    closeDetail: closeDetail,
    fontScrollerRef: fontScrollerRef,
    handleFontScroll: handleFontScroll,
    beginMarqueeSelection: beginMarqueeSelection,
    virtualLayout: virtualLayout,
    viewLayout: cardPoolViewLayout,
    renderFontCard: renderFontCard,
    databasePageReady: displayDatabasePageReady,
    visibleFontTotal: visibleFontTotal,
    visibleFonts: visibleFonts,
    fontFamilyGroupResult: fontFamilyGroupResult,
    fontFamilyGroupLoading: fontFamilyGroupLoading,
    fontFamilyGroupError: fontFamilyGroupError,
    expandedFontFamilyIds: expandedFontFamilyIds,
    toggleFontFamilyExpanded: toggleFontFamilyExpanded,
  }

  const detailViewProps: AppRootViewProps['detail'] = {
    visible: detailVisible,
    selectedFont: selectedFont,
    previewText: library.previewText,
    previewFamilies: previewFamilies,
    selectedPreviewFamily: selectedPreviewFamily,
    nativeDetailImage: nativeDetailImage,
    selectedFontIds: selectedFontIds,
    runFontCommand: runFontCommand,
    assignTagName: assignTagName,
    setAssignTagName: setAssignTagName,
    handleLocalTagInputKeyDown: handleLocalTagInputKeyDown,
    localTagSuggestions: localTagSuggestions,
    activeLocalTagSuggestionIndex: activeLocalTagSuggestionIndex,
    setActiveLocalTagSuggestionIndex: setActiveLocalTagSuggestionIndex,
    addTagToSelectedByName: addTagToSelectedByName,
    removeTagFromSelected: removeTagFromSelected,
    assignSharedTagName: assignSharedTagName,
    setAssignSharedTagName: setAssignSharedTagName,
    handleSharedTagInputKeyDown: handleSharedTagInputKeyDown,
    sharedTagSuggestions: sharedTagSuggestions,
    activeSharedTagSuggestionIndex: activeSharedTagSuggestionIndex,
    setActiveSharedTagSuggestionIndex: setActiveSharedTagSuggestionIndex,
    addSharedTagToSelectedByName: addSharedTagToSelectedByName,
    removeSharedTagFromSelected: removeSharedTagFromSelected,
    updateFont: updateFont,
    applyCompare: applyInstallCompareToFont,
  }

  const overlaysViewProps: AppRootViewProps['overlays'] = {
    renameTarget: renameTarget,
    setRenameTarget: setRenameTarget,
    renameValue: renameValue,
    setRenameValue: setRenameValue,
    confirmRename: confirmRename,
    deleteTarget: deleteTarget,
    setDeleteTarget: setDeleteTarget,
    confirmDelete: confirmDelete,
    folderChildTarget: folderChildTarget,
    setFolderChildTarget: setFolderChildTarget,
    newFolderName: newFolderName,
    setNewFolderName: setNewFolderName,
    createSubfolder: createSubfolder,
    selectionRect: selectionRect,
    normalizedSelectionRect: normalizedSelectionRect,
    contextMenu: contextMenu,
    contextSelectedFonts: contextSelectedFonts,
    runFontContextAction: runFontContextAction,
    contextTargetCount: contextTargetCount,
    runContextBatchActivate: runContextBatchActivate,
    runContextBatchDeactivate: runContextBatchDeactivate,
    runContextRefreshFolder: runContextRefreshFolder,
    runContextRename: runContextRename,
    runContextAddSubfolder: runContextAddSubfolder,
    runContextDelete: runContextDelete,
    leaseLockConflictNotice: leaseLockConflictNotice,
    setLeaseLockConflictNotice: setLeaseLockConflictNotice,
  }

  const developerViewProps: AppRootViewProps['developer'] = {
    IS_DEVELOPMENT: IS_DEVELOPMENT,
    status: status,
    refreshDeveloperStatusDetails: refreshDeveloperStatusDetails,
    latestIndexProgress: latestIndexProgress,
    developerArchitecture: developerArchitecture,
    developerSchedulerStatus: developerSchedulerStatus,
    developerMigrationDiagnostics: developerMigrationDiagnostics,
    developerSharedMetadataDiagnostics: developerSharedMetadataDiagnostics,
    setDeveloperSharedMetadataDiagnostics: setDeveloperSharedMetadataDiagnostics,
    latestBackgroundTaskEvent: latestBackgroundTaskEvent,
    developerTasks: developerTasks,
    developerStatusLog: developerStatusLog,
  }

  return (
    <AppRootView
      topbar={topbarViewProps}
      sidebar={sidebarViewProps}
      content={contentViewProps}
      detail={detailViewProps}
      overlays={overlaysViewProps}
      developer={developerViewProps}
    />
  )
}
