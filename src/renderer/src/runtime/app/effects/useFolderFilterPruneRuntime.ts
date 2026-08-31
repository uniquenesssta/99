import { useEffect } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import type { FilterGroupId, FontCategory } from '../../../appRuntime'
import type { LibraryState } from '@shared/types'
import { pruneExpandedFolderIds, pruneSelectedWatchedFolders } from '../../../fontFilterStateRuntime'

export function useFolderFilterPruneRuntime(args: {
  library: LibraryState
  setExpandedFolderIds: Dispatch<SetStateAction<Record<string, true>>>
  setSelectedWatchedFolders: Dispatch<SetStateAction<string[]>>
}): void {
  const { library, setExpandedFolderIds, setSelectedWatchedFolders } = args

  useEffect(() => {
    setExpandedFolderIds((prev) => pruneExpandedFolderIds(prev, library.folders, library.folderNodes))
  }, [library.folders, library.folderNodes])

  useEffect(() => {
    setSelectedWatchedFolders((prev) => pruneSelectedWatchedFolders(prev, library.folders))
  }, [library.folders])
}
