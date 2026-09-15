import type { CacheStats,FontQueryPageResult,FontQueryResult,LibraryState } from '@shared/types'
import { useEffect,useMemo,useRef,useState } from 'react'
import type { Dispatch,MutableRefObject,SetStateAction } from 'react'
import type { FontMetrics } from '../../appRuntime'
import {
  createEmptyLibrary,
  normalizeFontMetricsResult,
  requestIdleWindow
} from '../../appRuntime'
import { refreshDatabaseDerivedStateRuntime,scheduleDatabaseDerivedStateRefreshRuntime } from '../../databaseDerivedStateRuntime'
import { runSharedMetadataSyncCheckRuntime } from '../../sharedMetadataSyncRuntime'
import type { LeaseLockConflictNotice } from '../lease-lock/leaseLockConflictNoticeRuntime'
import { parseLeaseLockConflictNotice } from '../lease-lock/leaseLockConflictNoticeRuntime'
import { useInitialLibraryShellRuntime } from './effects/useInitialLibraryShellRuntime'
import { libraryShellPersistenceKey,useLibraryAutosaveRuntime } from './effects/useLibraryAutosaveRuntime'
import { useSharedMetadataSyncForegroundRuntime } from './effects/useSharedMetadataSyncForegroundRuntime'

export type LibraryDatabasePorts = {
  setDatabasePageResult: Dispatch<SetStateAction<FontQueryPageResult | null>>
  setDatabaseQueryResult: Dispatch<SetStateAction<FontQueryResult | null>>
  setDatabaseFontMetrics: Dispatch<SetStateAction<FontMetrics | null>>
  databasePageRequestSeqRef: MutableRefObject<number>
  fontMetricsRequestSeqRef: MutableRefObject<number>
}

export function useLibraryController(options: {
  hfm: Window['hfm']
  database: LibraryDatabasePorts
  rendererUserActive: () => boolean
  appendDeveloperStatus: (source: string, message: string, payload?: unknown) => void
}) {
  const [library, setLibraryState] = useState<LibraryState>(createEmptyLibrary())
  const [status, setStatus] = useState('准备就绪')
  const [leaseLockConflictNotice, setLeaseLockConflictNotice] = useState<LeaseLockConflictNotice | null>(null)
  const [indexingActive, setIndexingActive] = useState(false)
  const [databaseRefreshToken, setDatabaseRefreshToken] = useState(0)
  const [, setCacheStats] = useState<CacheStats | null>(null)
  const databaseRefreshTimerRef = useRef<number | null>(null)
  const libraryLoadedRef = useRef(false)
  const initialLibraryLoadStartedRef = useRef(false)
  const sharedMetadataSyncInFlightRef = useRef<Promise<void> | null>(null)
  const lastSharedMetadataSyncCheckAtRef = useRef(0)
  const libraryFoldersKey = (library.folders || []).join('\u0000')
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
    hfm: options.hfm,
    library,
    libraryShellSaveKey,
    libraryLoadedRef,
    setLibrary: setLibraryState,
    setStatus,
    onPersistenceRecovered: refreshDatabaseDerivedState
  })

  function refreshDatabaseDerivedState(): void {
    refreshDatabaseDerivedStateRuntime({
      timerRef: databaseRefreshTimerRef,
      clearTimeout: window.clearTimeout,
      setDatabasePageResult: options.database.setDatabasePageResult,
      setDatabaseQueryResult: options.database.setDatabaseQueryResult,
      setDatabaseFontMetrics: options.database.setDatabaseFontMetrics,
      setDatabaseRefreshToken,
      databasePageRequestSeqRef: options.database.databasePageRequestSeqRef,
      fontMetricsRequestSeqRef: options.database.fontMetricsRequestSeqRef
    })
  }

  function scheduleDatabaseDerivedStateRefresh(delay = 420): void {
    scheduleDatabaseDerivedStateRefreshRuntime({
      timerRef: databaseRefreshTimerRef,
      delay,
      clearTimeout: window.clearTimeout,
      setTimeout: window.setTimeout,
      requestIdleWindow,
      rendererUserActive: options.rendererUserActive,
      scheduleAgain: scheduleDatabaseDerivedStateRefresh,
      setDatabaseRefreshToken
    })
  }

  function refreshDatabaseMetricsNow(): void {
    if (typeof options.hfm.getFontMetrics !== 'function') {
      options.database.setDatabaseFontMetrics(null)
      return
    }

    void options.hfm.getFontMetrics()
      .then((metrics) => {
        options.database.setDatabaseFontMetrics(normalizeFontMetricsResult(metrics))
      })
      .catch(() => options.database.setDatabaseFontMetrics(null))
  }

  function checkSharedMetadataUpdates(reason: string, minIntervalMs = 5000): Promise<void> | null {
    return runSharedMetadataSyncCheckRuntime({
      hfm: options.hfm,
      reason,
      foldersLength: library.folders.length,
      indexingActive,
      libraryLoadedRef,
      inFlightRef: sharedMetadataSyncInFlightRef,
      lastCheckedAtRef: lastSharedMetadataSyncCheckAtRef,
      minIntervalMs,
      refreshDatabaseDerivedState,
      setStatus,
      appendDeveloperStatus: options.appendDeveloperStatus
    })
  }

  function clearDatabaseRefreshTimer(): void {
    if (databaseRefreshTimerRef.current === null) return
    window.clearTimeout(databaseRefreshTimerRef.current)
    databaseRefreshTimerRef.current = null
  }

  useEffect(() => {
    const notice = parseLeaseLockConflictNotice(status)
    if (notice) setLeaseLockConflictNotice(notice)
  }, [status])

  useInitialLibraryShellRuntime({
    hfm: options.hfm,
    initialLibraryLoadStartedRef,
    libraryLoadedRef,
    setLibrary,
    setStatus,
    setDatabasePageResult: options.database.setDatabasePageResult,
    setDatabaseQueryResult: options.database.setDatabaseQueryResult,
    setDatabaseRefreshToken
  })

  useSharedMetadataSyncForegroundRuntime({
    enabled: typeof options.hfm.checkSharedMetadataUpdates === 'function',
    libraryFoldersKey,
    indexingActive,
    checkSharedMetadataUpdates
  })

  return {
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
    libraryLoadedRef: libraryLoadedRef as Readonly<{ current: boolean }>,
    refreshDatabaseDerivedState,
    scheduleDatabaseDerivedStateRefresh,
    refreshDatabaseMetricsNow,
    clearDatabaseRefreshTimer
  }
}
