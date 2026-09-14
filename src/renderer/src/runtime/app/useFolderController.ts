import { useRef,useState } from 'react'
import type { MenuTarget } from '../../appRuntime'
import { createFontFolderTreeRuntime } from '../../fontFolderTreeRuntime'
import type { FontFolderTreeRuntimeOptions } from '../../fontFolderTreeRuntime'

type FolderRuntimeExternalOptions = Omit<FontFolderTreeRuntimeOptions,
  'draggingFontId' |
  'clearAutoRefreshTimer' |
  'setExpandedFolderIds' |
  'setDraggingFontId'
>

export function useFolderController() {
  const [expandedFolderIds, setExpandedFolderIds] = useState<Record<string, true>>({})
  const [newFolderName, setNewFolderName] = useState('')
  const [folderChildTarget, setFolderChildTarget] = useState<Extract<MenuTarget, { kind: 'folder' }> | null>(null)
  const [draggingFontId, setDraggingFontId] = useState('')
  const [dropHoverFolderId, setDropHoverFolderId] = useState('')
  const autoRefreshTimerRef = useRef<number | null>(null)

  function clearAutoRefreshTimer(): void {
    if (autoRefreshTimerRef.current === null) return
    window.clearTimeout(autoRefreshTimerRef.current)
    autoRefreshTimerRef.current = null
  }

  function createRuntime(options: FolderRuntimeExternalOptions) {
    return createFontFolderTreeRuntime({
      ...options,
      draggingFontId,
      clearAutoRefreshTimer,
      setExpandedFolderIds,
      setDraggingFontId
    })
  }

  return {
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
    createRuntime
  }
}
