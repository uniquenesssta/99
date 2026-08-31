import { useEffect } from 'react'
import type { Dispatch, MutableRefObject, SetStateAction } from 'react'
import type { VirtualViewport } from '../../../appRuntime'

export function useFontFilterScrollResetRuntime(args: {
  fontScrollerRef: MutableRefObject<HTMLDivElement | null>
  setVirtualViewport: Dispatch<SetStateAction<VirtualViewport>>
  activeFilterKey: string
  selectedWatchedFoldersKey: string
  selectedFormatsKey: string
  selectedScriptsKey: string
  selectedCategory: string
  selectedTagName: string
  selectedSharedTagName: string
  selectedFolderId: string
  sidebarPage: string
  deferredSearch: string
  installStatus: string
  timeSortMode: string
  sortMode: string
}): void {
  const {
    fontScrollerRef,
    setVirtualViewport,
    activeFilterKey,
    selectedWatchedFoldersKey,
    selectedFormatsKey,
    selectedScriptsKey,
    selectedCategory,
    selectedTagName,
    selectedSharedTagName,
    selectedFolderId,
    sidebarPage,
    deferredSearch,
    installStatus,
    timeSortMode,
    sortMode
  } = args

  useEffect(() => {
    const node = fontScrollerRef.current
    if (node) node.scrollTop = 0
    setVirtualViewport((prev) => ({ ...prev, scrollTop: 0 }))
  }, [activeFilterKey, selectedWatchedFoldersKey, selectedFormatsKey, selectedScriptsKey, selectedCategory, selectedTagName, selectedSharedTagName, selectedFolderId, sidebarPage, deferredSearch, installStatus, timeSortMode, sortMode])
}
