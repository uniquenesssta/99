import { useEffect } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import type { LibraryState } from '@shared/types'

export function useTagSelectionPruneRuntime(args: {
  library: LibraryState
  selectedTagName: string
  selectedSharedTagName: string
  setSelectedTagName: Dispatch<SetStateAction<string>>
  setSelectedSharedTagName: Dispatch<SetStateAction<string>>
  refreshDatabaseDerivedState: () => void
}): void {
  const {
    library,
    selectedTagName,
    selectedSharedTagName,
    setSelectedTagName,
    setSelectedSharedTagName,
    refreshDatabaseDerivedState,
  } = args

  useEffect(() => {
    if (!selectedTagName) return
    if ((library.localTags || []).includes(selectedTagName)) return
    setSelectedTagName('')
    refreshDatabaseDerivedState()
  }, [library.localTags, selectedTagName])

  useEffect(() => {
    if (!selectedSharedTagName) return
    if ((library.tags || []).includes(selectedSharedTagName)) return
    setSelectedSharedTagName('')
    refreshDatabaseDerivedState()
  }, [library.tags, selectedSharedTagName])
}
