import { useEffect } from 'react'
import type { Dispatch, MutableRefObject, SetStateAction } from 'react'
import type { FontQueryPageResult, FontQueryResult, LibraryState } from '@shared/types'
import { createEmptyLibrary, markPartialLibrary, normalizeLibrary } from '../../../appRuntime'

export function useInitialLibraryShellRuntime(args: {
  hfm: Window['hfm']
  initialLibraryLoadStartedRef: MutableRefObject<boolean>
  libraryLoadedRef: MutableRefObject<boolean>
  setLibrary: Dispatch<SetStateAction<LibraryState>>
  setStatus: Dispatch<SetStateAction<string>>
  setDatabasePageResult: Dispatch<SetStateAction<FontQueryPageResult | null>>
  setDatabaseQueryResult: Dispatch<SetStateAction<FontQueryResult | null>>
  setDatabaseRefreshToken: Dispatch<SetStateAction<number>>
}): void {
  const {
    hfm,
    initialLibraryLoadStartedRef,
    libraryLoadedRef,
    setLibrary,
    setStatus,
    setDatabasePageResult,
    setDatabaseQueryResult,
    setDatabaseRefreshToken
  } = args

  useEffect(() => {
    if (initialLibraryLoadStartedRef.current) return
    initialLibraryLoadStartedRef.current = true

    const loadInitialLibrary = async (): Promise<void> => {
      try {
        const shell = typeof hfm.loadLibraryShell === 'function'
          ? await hfm.loadLibraryShell()
          : null
        const normalized = markPartialLibrary(normalizeLibrary({
          ...(shell || createEmptyLibrary()),
          fonts: {},
          fontFolderIds: {}
        } as LibraryState))

        libraryLoadedRef.current = true
        setLibrary(normalized)
        const loadStatus = `已载入库配置，数据库中共有 ${shell?.totalFonts || 0} 个共享索引字体；列表按需分页加载。`
        setStatus(loadStatus)
        setDatabasePageResult(null)
        setDatabaseQueryResult(null)
        setDatabaseRefreshToken((value) => value + 1)
      } catch (error) {
        setStatus(`库配置加载失败：${error instanceof Error ? error.message : String(error)}`)
        libraryLoadedRef.current = true
        setLibrary(markPartialLibrary(normalizeLibrary(createEmptyLibrary())))
      }
    }

    void loadInitialLibrary()
  }, [])
}
