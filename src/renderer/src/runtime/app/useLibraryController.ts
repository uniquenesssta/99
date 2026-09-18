import { fontUserIntentRevision,hasUnsettledFavoriteIntent } from '../../fontUserIntentRuntime'
import type { CacheStats,FontQueryPageResult,FontQueryResult,LibraryState } from '@shared/types'
import { useEffect,useMemo,useRef,useState } from 'react'
import type { Dispatch,MutableRefObject,SetStateAction } from 'react'
import type { FontMetrics } from '../../appRuntime'
import {
  createEmptyLibrary,
  normalizeFontMetricsResult,
  requestIdleWindow
} from '../../appRuntime'
import { fontMutationRefreshScope,type FontRefreshField,refreshDatabaseDerivedStateRuntime,scheduleDatabaseDerivedStateRefreshRuntime } from '../../databaseDerivedStateRuntime'
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
  activeFilterKind?: string
  hasDatabasePageSnapshot?: boolean
  database: LibraryDatabasePorts
  rendererUserActive: () => boolean
  appendDeveloperStatus: (source: string, message: string, payload?: unknown) => void
}) {
  const [library, setLibraryState] = useState<LibraryState>(createEmptyLibrary())
  const [status, setStatus] = useState('准备就绪')
  const [leaseLockConflictNotice, setLeaseLockConflictNotice] = useState<LeaseLockConflictNotice | null>(null)
  const [indexingActive, setIndexingActive] = useState(false)
  const [databaseRefreshToken, setDatabaseRefreshToken] = useState(0)
  const [databaseMetricsRefreshToken, setDatabaseMetricsRefreshToken] = useState(0)
  const pendingRefreshScope = useRef({ page: false, metrics: false })
  const activeFilterKindRef = useRef({ kind: options.activeFilterKind || 'all', hasPage: options.hasDatabasePageSnapshot !== false })
  activeFilterKindRef.current = { kind: options.activeFilterKind || 'all', hasPage: options.hasDatabasePageSnapshot !== false }
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

  function refreshDatabaseDerivedState(fields?: FontRefreshField[]): void {
    if (fields) { scheduleDatabaseDerivedStateRefresh(0, fields); return }
    pendingRefreshScope.current = { page: false, metrics: false }
    setDatabaseMetricsRefreshToken(value => value + 1)
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

  function scheduleDatabaseDerivedStateRefresh(delay = 420, fields?: FontRefreshField[]): void {
    const scope = fields ? fontMutationRefreshScope(fields, activeFilterKindRef.current.kind) : { page: true, metrics: true }
    if (fields?.length && !activeFilterKindRef.current.hasPage) scope.page = true
    const pending = pendingRefreshScope.current
    pending.page ||= scope.page
    pending.metrics ||= scope.metrics
    if (!pending.page && !pending.metrics) return
    scheduleDatabaseDerivedStateRefreshRuntime({
      timerRef: databaseRefreshTimerRef,
      delay,
      clearTimeout: window.clearTimeout,
      setTimeout: window.setTimeout,
      requestIdleWindow,
      rendererUserActive: options.rendererUserActive,
      scheduleAgain: nextDelay => scheduleDatabaseDerivedStateRefresh(nextDelay, []),
      setDatabaseRefreshToken: () => {
        const pending = pendingRefreshScope.current
        pendingRefreshScope.current = { page: false, metrics: false }
        if (pending.page) setDatabaseRefreshToken(value => value + 1)
        if (pending.metrics) setDatabaseMetricsRefreshToken(value => value + 1)
      }
    })
  }

  function refreshDatabaseMetricsNow(): void {
    if (typeof options.hfm.getFontMetrics !== 'function') {
      options.database.setDatabaseFontMetrics(null)
      return
    }

    const requestSeq = ++options.database.fontMetricsRequestSeqRef.current
    const intentRevision = fontUserIntentRevision()
    const pendingFavorite = Object.values(library.fonts || {}).some(hasUnsettledFavoriteIntent)
    const isCurrent = () => requestSeq === options.database.fontMetricsRequestSeqRef.current &&
      intentRevision === fontUserIntentRevision() && !pendingFavorite
    void options.hfm.getFontMetrics()
      .then((metrics) => {
        if (!isCurrent()) return
        options.database.setDatabaseFontMetrics(normalizeFontMetricsResult(metrics))
      })
      .catch(() => { if (isCurrent()) options.database.setDatabaseFontMetrics(null) })
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
    databaseMetricsRefreshToken,
    // Legacy structural/install callers invalidate both domains.
    setDatabaseRefreshToken: (update: SetStateAction<number>) => {
      setDatabaseRefreshToken(update)
      setDatabaseMetricsRefreshToken(value => value + 1)
    },
    setCacheStats,
    libraryLoadedRef: libraryLoadedRef as Readonly<{ current: boolean }>,
    refreshDatabaseDerivedState,
    scheduleDatabaseDerivedStateRefresh,
    refreshDatabaseMetricsNow,
    clearDatabaseRefreshTimer
  }
}
