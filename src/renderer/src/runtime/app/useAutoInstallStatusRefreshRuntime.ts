import type { LibraryState } from '@shared/types'
import { useEffect } from 'react'
import type { MutableRefObject } from 'react'
import type { FontMetrics } from '../../appRuntime'

export function useAutoInstallStatusRefreshRuntime(options: {
  hfm: typeof window.hfm
  databaseFontMetrics: FontMetrics | null
  libraryFolders: LibraryState['folders']
  indexingActive: boolean
  startedRef: MutableRefObject<boolean>
  signatureRef: MutableRefObject<string>
  startBackgroundInstallStatusRefresh: (messagePrefix?: string) => Promise<void>
}): void {
  const {
    hfm,
    databaseFontMetrics,
    libraryFolders,
    indexingActive,
    startedRef,
    signatureRef,
    startBackgroundInstallStatusRefresh
  } = options

  useEffect(() => {
    if (!databaseFontMetrics || !libraryFolders.length || indexingActive) return
    const missing = databaseFontMetrics.installStatusMissingCount || 0
    if (missing <= 0) {
      startedRef.current = false
      return
    }
    if (databaseFontMetrics.total <= 0 || typeof hfm.startInstallStatusRefreshIndex !== 'function') return

    const signature = [
      databaseFontMetrics.total,
      databaseFontMetrics.installStatusKnownCount || 0,
      missing,
      libraryFolders.join('|')
    ].join(':')

    if (startedRef.current) return
    if (signatureRef.current === signature) return

    signatureRef.current = signature
    startedRef.current = true
    void startBackgroundInstallStatusRefresh(`检测到 ${missing} 个字体缺少本机安装状态快照，`)
  }, [databaseFontMetrics, libraryFolders, indexingActive])
}
