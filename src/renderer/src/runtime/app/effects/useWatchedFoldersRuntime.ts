import { useEffect } from 'react'
import type { Dispatch, SetStateAction } from 'react'

export function useWatchedFoldersRuntime(args: {
  hfm: Window['hfm']
  folders: string[]
  setStatus: Dispatch<SetStateAction<string>>
}): void {
  const { hfm, folders, setStatus } = args

  useEffect(() => {
    if (typeof hfm.watchFolders === 'function') {
      void hfm.watchFolders(folders || [])
    } else {
      setStatus('当前 preload 缺少 watchFolders，已跳过自动监听。请使用 v0.8.7 或更新版本。')
    }
  }, [folders])
}
