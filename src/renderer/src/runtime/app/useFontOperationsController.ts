import { missingFontCommandTargetsMessage, resolveFontCommandTargets } from '../../fontCommandTargetsRuntime'
import type { CacheStats,FontItem,FontQueryPageResult,FontQueryResult,LibraryState } from '@shared/types'
import { useRef,useState } from 'react'
import type { Dispatch,SetStateAction } from 'react'
import type { ContextMenuState,FontMetrics,FontScrollRestoreSnapshot,QueuedFontWriteState,SidebarPage } from '../../appRuntime'
import {
  createEmptyQueuedFontWriteState,
  rendererMemoryPressure,
  USER_ACTIVITY_IDLE_WINDOW_MS,
  USER_ACTIVITY_REPORT_INTERVAL_MS,
  WRITE_BEHIND_DELAY_MS,
  WRITE_BEHIND_MAX_BUFFER_BYTES,
  WRITE_BEHIND_MAX_ITEMS
} from '../../appRuntime'
import { createRendererFontWriteQueueRuntime } from '../../fontWriteQueueRuntime'
import {
  isRendererUserActive,
  reportRendererUserActivity
} from '../../rendererActivityRuntime'
import { createFontLibraryIndexActionRuntime } from '../library/fontLibraryIndexActionRuntime'
import { createFontInstallStatusRuntime } from '../system/fontInstallStatusRuntime'
import { createFontSystemActionRuntime } from '../system/fontSystemActionRuntime'
import { useAppFlushOnUnloadRuntime } from './effects/useAppFlushOnUnloadRuntime'
import { useInstallStatusProgressEventRuntime } from './effects/useInstallStatusProgressEventRuntime'
import { useRendererActivityRuntime } from './effects/useRendererActivityRuntime'
import { useAutoInstallStatusRefreshRuntime } from './useAutoInstallStatusRefreshRuntime'
import { useIndexOperationRunRuntime } from './effects/useIndexOperationRunRuntime'

type FontOperationsLibraryPort = {
  library: LibraryState
  getCurrentLibrary: () => LibraryState
  setLibrary: Dispatch<SetStateAction<LibraryState>>
  commitLibraryUpdate: (update: SetStateAction<LibraryState>) => LibraryState
  saveLibraryImmediately: (nextLibrary: LibraryState) => Promise<boolean>
  flushLibraryPersistence: () => Promise<boolean>
  setStatus: Dispatch<SetStateAction<string>>
  selectedFolderId: string
  setSelectedFolderId: Dispatch<SetStateAction<string>>
  indexingActive: boolean
  setIndexingActive: Dispatch<SetStateAction<boolean>>
  setCacheStats: Dispatch<SetStateAction<CacheStats | null>>
  clearDatabaseRefreshTimer: () => void
  refreshDatabaseDerivedState: () => void
  scheduleDatabaseDerivedStateRefresh: (delay?: number) => void
  refreshDatabaseMetricsNow: () => void
}

type FontOperationsDatabasePort = {
  databaseFontMetrics: FontMetrics | null
  setDatabasePageResult: Dispatch<SetStateAction<FontQueryPageResult | null>>
  setDatabaseQueryResult: Dispatch<SetStateAction<FontQueryResult | null>>
  setDatabaseFontMetrics: Dispatch<SetStateAction<FontMetrics | null>>
  setDatabaseRefreshToken: Dispatch<SetStateAction<number>>
}

type FontOperationsSelectionPort = {
  selectedFontId: string
  getCurrentSelectedFontId: () => string
  setSelectedFontIds: Dispatch<SetStateAction<string[]>>
  setSelectedFontId: Dispatch<SetStateAction<string>>
  setDetailVisible: Dispatch<SetStateAction<boolean>>
  setContextMenu: Dispatch<SetStateAction<ContextMenuState>>
}

type FontOperationsIndexPort = {
  captureFontScrollSnapshot: () => FontScrollRestoreSnapshot
  restoreFontScrollSnapshot: (snapshot: FontScrollRestoreSnapshot) => void
  resetPreviewRuntimeState: () => void
  isBadFontRecord: (font: FontItem) => boolean
}

export function useFontOperationsController(options: {
  hfm: Window['hfm']
  library: FontOperationsLibraryPort
  database: FontOperationsDatabasePort
  selection: FontOperationsSelectionPort
  index: FontOperationsIndexPort
  sidebarPage: SidebarPage
  clearFontListScrollIdleTimer: () => void
  appendDeveloperStatus: (source: string, message: string, payload?: unknown) => void
}) {
  const [cacheMenuOpen, setCacheMenuOpen] = useState(false)
  const [newTagName, setNewTagName] = useState('')
  const [newSharedTagName, setNewSharedTagName] = useState('')
  const fontWriteQueue = useRef<QueuedFontWriteState>(createEmptyQueuedFontWriteState())
  const fontWriteFlushTimerRef = useRef<number | null>(null)
  const fontWriteRetryTimerRef = useRef<number | null>(null)
  const fontWriteRetryAttemptRef = useRef(0)
  const fontWriteFlushActiveRef = useRef(false)
  const fontWriteFlushActivePromiseRef = useRef<Promise<boolean> | null>(null)
  const lazyInstallQueue = useRef<FontItem[]>([])
  const queuedLazyInstallIds = useRef<Set<string>>(new Set())
  const seenLazyInstallIds = useRef<Set<string>>(new Set())
  const knownInstallStatusIds = useRef<Set<string>>(new Set())
  const activeLazyInstallDetect = useRef(false)
  const lazyInstallDetectTimerRef = useRef<number | null>(null)
  const lazyInstallDetectRunId = useRef(0)
  const activeOperationFontIds = useRef<Set<string>>(new Set())
  const lastUserActivityReportAtRef = useRef(0)
  const rendererUserActiveUntilRef = useRef(0)
  const indexOperationRunIdRef = useRef(0)
  const autoInstallStatusRefreshStartedRef = useRef(false)
  const autoInstallStatusRefreshSignatureRef = useRef('')

  function reportUserActivity(reason = 'interaction', durationMs = USER_ACTIVITY_IDLE_WINDOW_MS): void {
    reportRendererUserActivity({
      activeUntilRef: rendererUserActiveUntilRef,
      lastReportAtRef: lastUserActivityReportAtRef,
      hfm: options.hfm,
      reason,
      durationMs,
      reportIntervalMs: USER_ACTIVITY_REPORT_INTERVAL_MS
    })
  }

  function rendererUserActive(): boolean {
    return isRendererUserActive(rendererUserActiveUntilRef)
  }

  const fontWriteQueueRuntime = createRendererFontWriteQueueRuntime({
    queueRef: fontWriteQueue,
    timerRef: fontWriteFlushTimerRef,
    retryTimerRef: fontWriteRetryTimerRef,
    retryAttemptRef: fontWriteRetryAttemptRef,
    activeRef: fontWriteFlushActiveRef,
    activePromiseRef: fontWriteFlushActivePromiseRef,
    hfm: options.hfm,
    getFolders: () => options.library.getCurrentLibrary().folders || [],
    writeBehindDelayMs: WRITE_BEHIND_DELAY_MS,
    writeBehindMaxItems: WRITE_BEHIND_MAX_ITEMS,
    writeBehindMaxBufferBytes: WRITE_BEHIND_MAX_BUFFER_BYTES,
    memoryPressure: rendererMemoryPressure,
    setTimeout: window.setTimeout,
    clearTimeout: window.clearTimeout,
    setStatus: options.library.setStatus,
    scheduleDatabaseDerivedStateRefresh: options.library.scheduleDatabaseDerivedStateRefresh
  })

  const systemActionRuntime = createFontSystemActionRuntime({
    hfm: options.hfm,
    library: options.library.library,
    getCurrentLibrary: options.library.getCurrentLibrary,
    getCurrentSelectedFontId: options.selection.getCurrentSelectedFontId,
    selectedFontId: options.selection.selectedFontId,
    activeOperationFontIds,
    setLibrary: options.library.setLibrary,
    setStatus: options.library.setStatus,
    setSelectedFontIds: options.selection.setSelectedFontIds,
    setSelectedFontId: options.selection.setSelectedFontId,
    setDetailVisible: options.selection.setDetailVisible,
    setContextMenu: (value) => options.selection.setContextMenu(value),
    setDatabaseFontMetrics: options.database.setDatabaseFontMetrics,
    refreshDatabaseDerivedState: options.library.refreshDatabaseDerivedState,
    queueFavoriteWrite: fontWriteQueueRuntime.queueFavoriteWrite
  })

  const installStatusRuntime = createFontInstallStatusRuntime({
    hfm: options.hfm,
    library: options.library.library,
    lazyInstallQueue,
    queuedLazyInstallIds,
    seenLazyInstallIds,
    knownInstallStatusIds,
    activeLazyInstallDetect,
    lazyInstallDetectTimerRef,
    lazyInstallDetectRunId,
    setLibrary: options.library.setLibrary,
    setStatus: options.library.setStatus,
    setDatabasePageResult: options.database.setDatabasePageResult,
    setDatabaseQueryResult: options.database.setDatabaseQueryResult,
    setDatabaseFontMetrics: options.database.setDatabaseFontMetrics,
    setDatabaseRefreshToken: options.database.setDatabaseRefreshToken
  })

  const { nextIndexOperationRunId, isCurrentIndexOperation } = useIndexOperationRunRuntime(indexOperationRunIdRef)
  const libraryIndexActionRuntime = createFontLibraryIndexActionRuntime({
    hfm: options.hfm,
    library: options.library.library,
    selectedFolderId: options.library.selectedFolderId,
    autoInstallStatusRefreshStartedRef,
    knownInstallStatusIds,
    setLibrary: options.library.setLibrary,
    getCurrentLibrary: options.library.getCurrentLibrary,
    commitLibraryUpdate: options.library.commitLibraryUpdate,
    setStatus: options.library.setStatus,
    setCacheStats: options.library.setCacheStats,
    setContextMenu: (value) => options.selection.setContextMenu(value),
    setSelectedFolderId: options.library.setSelectedFolderId,
    setDatabasePageResult: options.database.setDatabasePageResult,
    setDatabaseQueryResult: options.database.setDatabaseQueryResult,
    setDatabaseFontMetrics: options.database.setDatabaseFontMetrics,
    setDatabaseRefreshToken: options.database.setDatabaseRefreshToken,
    setIndexingActive: options.library.setIndexingActive,
    nextIndexOperationRunId,
    isCurrentIndexOperation,
    captureFontScrollSnapshot: options.index.captureFontScrollSnapshot,
    restoreFontScrollSnapshot: options.index.restoreFontScrollSnapshot,
    saveLibraryImmediately: options.library.saveLibraryImmediately,
    stopLazyInstallStatusDetect: installStatusRuntime.stopLazyInstallStatusDetect,
    startBackgroundInstallStatusRefresh: installStatusRuntime.startBackgroundInstallStatusRefresh,
    resetPreviewRuntimeState: options.index.resetPreviewRuntimeState,
    isBadFontRecord: options.index.isBadFontRecord
  })

  async function toggleFontDeleteProtection(fontIds: string[], protect?: boolean, available: FontItem[] = []): Promise<void> {
    options.selection.setContextMenu(null)
    const resolved = resolveFontCommandTargets(fontIds, options.library.getCurrentLibrary(), available)
    if (resolved.missingIds.length) {
      options.library.setStatus(missingFontCommandTargetsMessage(resolved.missingIds))
      return
    }
    const ids = resolved.selectedIds, targetFonts = resolved.fonts
    if (!ids.length) return
    const nextValue = typeof protect === 'boolean' ? protect : !targetFonts.every(font => !!font.deleteProtected)

    options.library.setLibrary((prev) => {
      const nextFonts = { ...prev.fonts }
      for (const target of targetFonts) {
        const font = nextFonts[target.id] || target
        nextFonts[target.id] = { ...font, deleteProtected: nextValue }
      }
      return { ...prev, fonts: nextFonts }
    })

    for (const font of targetFonts) fontWriteQueueRuntime.queueProtectionWrite(font, nextValue)
    options.library.setStatus(`${nextValue ? '加入保护' : '取消保护'}已在界面生效，后台队列写入 ${targetFonts.length} 个。`)
  }

  function removeFontIds(removedFontIds: ReadonlySet<string>): void {
    if (!removedFontIds.size) return
    lazyInstallQueue.current = lazyInstallQueue.current.filter((font) => !removedFontIds.has(font.id))
    for (const id of removedFontIds) {
      queuedLazyInstallIds.current.delete(id)
      seenLazyInstallIds.current.delete(id)
    }
  }

  useRendererActivityRuntime({
    hfm: options.hfm,
    sidebarPage: options.sidebarPage,
    reportUserActivity
  })

  useInstallStatusProgressEventRuntime({
    hfm: options.hfm,
    knownInstallStatusIds,
    autoInstallStatusRefreshStartedRef,
    appendDeveloperStatus: options.appendDeveloperStatus,
    setStatus: options.library.setStatus,
    refreshDatabaseDerivedState: options.library.refreshDatabaseDerivedState,
    refreshDatabaseMetricsNow: options.library.refreshDatabaseMetricsNow
  })

  useAutoInstallStatusRefreshRuntime({
    hfm: options.hfm,
    databaseFontMetrics: options.database.databaseFontMetrics,
    libraryFolders: options.library.library.folders,
    indexingActive: options.library.indexingActive,
    startedRef: autoInstallStatusRefreshStartedRef,
    signatureRef: autoInstallStatusRefreshSignatureRef,
    startBackgroundInstallStatusRefresh: installStatusRuntime.startBackgroundInstallStatusRefresh
  })

  useAppFlushOnUnloadRuntime({
    hfm: options.hfm,
    clearDatabaseRefreshTimer: options.library.clearDatabaseRefreshTimer,
    clearFontListScrollIdleTimer: options.clearFontListScrollIdleTimer,
    clearQueuedFontWriteTimer: fontWriteQueueRuntime.clearTimer,
    flushFontWriteQueue: fontWriteQueueRuntime.flush,
    flushLibraryPersistence: options.library.flushLibraryPersistence
  })

  return {
    cacheMenuOpen,
    setCacheMenuOpen,
    newTagName,
    setNewTagName,
    newSharedTagName,
    setNewSharedTagName,
    reportUserActivity,
    rendererUserActive,
    updateFont: systemActionRuntime.updateFont,
    toggleFontFavorite: systemActionRuntime.toggleFontFavorite,
    fontsForTag: systemActionRuntime.fontsForTag,
    installFontByCard: systemActionRuntime.installFontByCard,
    removeFontByCard: systemActionRuntime.removeFontByCard,
    deleteFontsBatch: systemActionRuntime.deleteFontsBatch,
    uninstallFontsBatch: systemActionRuntime.uninstallFontsBatch,
    activateFontByCard: systemActionRuntime.activateFontByCard,
    activateFontsBatch: systemActionRuntime.activateFontsBatch,
    deactivateFontByCard: systemActionRuntime.deactivateFontByCard,
    deactivateFontsBatch: systemActionRuntime.deactivateFontsBatch,
    refreshInstallStatus: installStatusRuntime.refreshInstallStatus,
    startBackgroundInstallStatusRefresh: installStatusRuntime.startBackgroundInstallStatusRefresh,
    stopLazyInstallStatusDetect: installStatusRuntime.stopLazyInstallStatusDetect,
    loadCacheStats: libraryIndexActionRuntime.loadCacheStats,
    readPhysicalFolderTree: libraryIndexActionRuntime.readPhysicalFolderTree,
    clearAllCacheAction: libraryIndexActionRuntime.clearAllCacheAction,
    addFolder: libraryIndexActionRuntime.addFolder,
    cancelIndexing: libraryIndexActionRuntime.cancelIndexing,
    rescan: libraryIndexActionRuntime.rescan,
    rebuildScanCache: libraryIndexActionRuntime.rebuildScanCache,
    refreshFolderTarget: libraryIndexActionRuntime.refreshFolderTarget,
    queueLocalTagsWrite: fontWriteQueueRuntime.queueLocalTagsWrite,
    queueSharedTagsWrite: fontWriteQueueRuntime.queueSharedTagsWrite,
    flushFontWriteQueue: fontWriteQueueRuntime.flush,
    toggleFontDeleteProtection,
    removeFontIds
  }
}
