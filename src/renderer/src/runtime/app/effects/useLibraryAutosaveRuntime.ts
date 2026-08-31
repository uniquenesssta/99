import { useCallback, useEffect, useRef } from 'react'
import type { Dispatch, MutableRefObject, SetStateAction } from 'react'
import type { LibraryState } from '@shared/types'

const AUTOSAVE_DELAY_MS = 300
const SAVE_RETRY_DELAYS_MS = [120, 360, 900]
const BACKGROUND_RETRY_DELAY_MS = 1800

export function libraryShellPersistenceKey(library: LibraryState): string {
  return JSON.stringify({
    folders: library.folders || [],
    folderAliases: library.folderAliases || {},
    folderNodes: library.folderNodes || [],
    collections: library.collections || [],
    tags: library.tags || [],
    localCollections: library.localCollections || [],
    localTags: library.localTags || [],
    previewText: library.previewText,
    previewMode: library.previewMode
  })
}

type PendingLibrarySave = {
  revision: number
  library: LibraryState
  key: string
}

export type LibraryPersistenceRuntime = {
  setLibrary: Dispatch<SetStateAction<LibraryState>>
  getCurrentLibrary: () => LibraryState
  commitLibraryUpdate: (update: SetStateAction<LibraryState>) => LibraryState
  saveLibraryImmediately: (nextLibrary: LibraryState) => Promise<boolean>
  flushLibraryPersistence: () => Promise<boolean>
}

function waitForRetry(delayMs: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, delayMs))
}

export function useLibraryAutosaveRuntime(args: {
  hfm: Window['hfm']
  library: LibraryState
  libraryShellSaveKey: string
  libraryLoadedRef: MutableRefObject<boolean>
  setLibrary: Dispatch<SetStateAction<LibraryState>>
  setStatus: Dispatch<SetStateAction<string>>
  onPersistenceRecovered?: () => void
}): LibraryPersistenceRuntime {
  const {
    hfm,
    library,
    libraryShellSaveKey,
    libraryLoadedRef,
    setLibrary,
    setStatus,
    onPersistenceRecovered
  } = args
  const currentLibraryRef = useRef(library)
  const lastPersistedKeyRef = useRef<string | null>(null)
  const pendingSaveRef = useRef<PendingLibrarySave | null>(null)
  const saveLoopRef = useRef<Promise<boolean> | null>(null)
  const autosaveTimerRef = useRef<number | null>(null)
  const backgroundRetryTimerRef = useRef<number | null>(null)
  const nextRevisionRef = useRef(0)
  const persistenceFailureActiveRef = useRef(false)
  const onPersistenceRecoveredRef = useRef(onPersistenceRecovered)

  currentLibraryRef.current = library
  onPersistenceRecoveredRef.current = onPersistenceRecovered

  const getCurrentLibrary = useCallback((): LibraryState => currentLibraryRef.current, [])

  const commitLibraryUpdate = useCallback((update: SetStateAction<LibraryState>): LibraryState => {
    const previous = currentLibraryRef.current
    const nextLibrary = typeof update === 'function'
      ? (update as (value: LibraryState) => LibraryState)(previous)
      : update
    currentLibraryRef.current = nextLibrary
    setLibrary(nextLibrary)
    return nextLibrary
  }, [setLibrary])

  const setSynchronizedLibrary = useCallback((update: SetStateAction<LibraryState>): void => {
    commitLibraryUpdate(update)
  }, [commitLibraryUpdate])

  const clearBackgroundRetry = useCallback((): void => {
    if (backgroundRetryTimerRef.current === null) return
    window.clearTimeout(backgroundRetryTimerRef.current)
    backgroundRetryTimerRef.current = null
  }, [])

  const queueLatestLibrary = useCallback((requestedLibrary?: LibraryState): PendingLibrarySave | null => {
    if (!libraryLoadedRef.current) return null

    const latestLibrary = currentLibraryRef.current
    const latestKey = libraryShellPersistenceKey(latestLibrary)
    const requestedKey = requestedLibrary ? libraryShellPersistenceKey(requestedLibrary) : latestKey
    const libraryToPersist = requestedLibrary && requestedKey === latestKey ? requestedLibrary : latestLibrary
    const keyToPersist = requestedLibrary && requestedKey === latestKey ? requestedKey : latestKey

    if (lastPersistedKeyRef.current === keyToPersist && !pendingSaveRef.current) return null

    const pending = pendingSaveRef.current
    if (pending?.key === keyToPersist) return pending

    const nextPending: PendingLibrarySave = {
      revision: ++nextRevisionRef.current,
      library: libraryToPersist,
      key: keyToPersist
    }
    pendingSaveRef.current = nextPending
    return nextPending
  }, [libraryLoadedRef])

  const runSaveLoop = useCallback((retryDelaysMs: number[]): Promise<boolean> => {
    if (!libraryLoadedRef.current) return Promise.resolve(false)
    if (saveLoopRef.current) return saveLoopRef.current

    const task = (async (): Promise<boolean> => {
      while (pendingSaveRef.current) {
        const target = pendingSaveRef.current
        let saved = false
        let lastError: unknown = null

        for (let attempt = 0; attempt <= retryDelaysMs.length; attempt += 1) {
          try {
            const confirmed = await hfm.saveLibrary(target.library)
            if (confirmed !== true) throw new Error('主进程未确认库状态保存成功')
            saved = true
            break
          } catch (error) {
            lastError = error
            if (attempt < retryDelaysMs.length) await waitForRetry(retryDelaysMs[attempt])
          }
        }

        if (!saved) {
          if (!persistenceFailureActiveRef.current) {
            setStatus(`保存失败：${lastError instanceof Error ? lastError.message : String(lastError)}；后台将继续重试。`)
          }
          persistenceFailureActiveRef.current = true
          return false
        }

        lastPersistedKeyRef.current = target.key
        if (pendingSaveRef.current?.revision === target.revision) {
          pendingSaveRef.current = null
        }

        if (persistenceFailureActiveRef.current) {
          persistenceFailureActiveRef.current = false
          onPersistenceRecoveredRef.current?.()
        }
      }

      clearBackgroundRetry()
      return true
    })().finally(() => {
      if (saveLoopRef.current === task) saveLoopRef.current = null
    })

    saveLoopRef.current = task
    return task
  }, [clearBackgroundRetry, hfm, libraryLoadedRef, setStatus])

  const scheduleBackgroundRetry = useCallback((): void => {
    if (!libraryLoadedRef.current || backgroundRetryTimerRef.current !== null || !pendingSaveRef.current) return
    backgroundRetryTimerRef.current = window.setTimeout(() => {
      backgroundRetryTimerRef.current = null
      void runSaveLoop(SAVE_RETRY_DELAYS_MS).then((saved) => {
        if (!saved) scheduleBackgroundRetry()
      })
    }, BACKGROUND_RETRY_DELAY_MS)
  }, [libraryLoadedRef, runSaveLoop])

  const saveLibraryImmediately = useCallback(async (requestedLibrary: LibraryState): Promise<boolean> => {
    if (!queueLatestLibrary(requestedLibrary)) return libraryLoadedRef.current
    clearBackgroundRetry()
    const saved = await runSaveLoop(SAVE_RETRY_DELAYS_MS)
    if (!saved) scheduleBackgroundRetry()
    return saved
  }, [clearBackgroundRetry, libraryLoadedRef, queueLatestLibrary, runSaveLoop, scheduleBackgroundRetry])

  const flushLibraryPersistence = useCallback(async (): Promise<boolean> => {
    if (!libraryLoadedRef.current) return true
    if (autosaveTimerRef.current !== null) {
      window.clearTimeout(autosaveTimerRef.current)
      autosaveTimerRef.current = null
    }
    clearBackgroundRetry()
    queueLatestLibrary(currentLibraryRef.current)
    const saved = await runSaveLoop(SAVE_RETRY_DELAYS_MS)
    if (!saved) scheduleBackgroundRetry()
    return saved
  }, [clearBackgroundRetry, libraryLoadedRef, queueLatestLibrary, runSaveLoop, scheduleBackgroundRetry])

  useEffect(() => {
    if (!libraryLoadedRef.current || lastPersistedKeyRef.current === libraryShellSaveKey) return
    if (autosaveTimerRef.current !== null) window.clearTimeout(autosaveTimerRef.current)
    autosaveTimerRef.current = window.setTimeout(() => {
      autosaveTimerRef.current = null
      void saveLibraryImmediately(currentLibraryRef.current)
    }, AUTOSAVE_DELAY_MS)

    return () => {
      if (autosaveTimerRef.current !== null) {
        window.clearTimeout(autosaveTimerRef.current)
        autosaveTimerRef.current = null
      }
    }
  }, [libraryShellSaveKey, libraryLoadedRef, saveLibraryImmediately])

  useEffect(() => () => {
    if (autosaveTimerRef.current !== null) window.clearTimeout(autosaveTimerRef.current)
    if (backgroundRetryTimerRef.current !== null) window.clearTimeout(backgroundRetryTimerRef.current)
  }, [])

  return {
    setLibrary: setSynchronizedLibrary,
    getCurrentLibrary,
    commitLibraryUpdate,
    saveLibraryImmediately,
    flushLibraryPersistence
  }
}
