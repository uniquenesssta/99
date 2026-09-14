import { useEffect } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import { folderChangeStatusText } from '../../../fontIndexEventRuntime'

export function useFoldersChangedEventRuntime(args: {
  hfm: Window['hfm']
  folders: string[]
  clearAutoRefreshTimer: () => void
  setStatus: Dispatch<SetStateAction<string>>
}): void {
  const { hfm, folders, clearAutoRefreshTimer, setStatus } = args

  useEffect(() => {
    if (typeof hfm.onFoldersChanged !== 'function') {
      return
    }

    const dispose = hfm.onFoldersChanged((payload) => {
      if (!folders.length) return
      setStatus(folderChangeStatusText(payload))
    })

    return () => {
      dispose()
      clearAutoRefreshTimer()
    }
  }, [folders])
}
