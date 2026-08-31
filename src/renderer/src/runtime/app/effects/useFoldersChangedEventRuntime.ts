import { useEffect } from 'react'
import type { Dispatch, MutableRefObject, SetStateAction } from 'react'
import { folderChangeStatusText } from '../../../fontIndexEventRuntime'

export function useFoldersChangedEventRuntime(args: {
  hfm: Window['hfm']
  folders: string[]
  autoRefreshTimerRef: MutableRefObject<number | null>
  setStatus: Dispatch<SetStateAction<string>>
}): void {
  const { hfm, folders, autoRefreshTimerRef, setStatus } = args

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
      if (autoRefreshTimerRef.current !== null) {
        window.clearTimeout(autoRefreshTimerRef.current)
        autoRefreshTimerRef.current = null
      }
    }
  }, [folders])
}
