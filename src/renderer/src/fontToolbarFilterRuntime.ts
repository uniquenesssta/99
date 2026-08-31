import type { FontFormat,FontScript } from '@shared/types'
import type { Dispatch,SetStateAction } from 'react'
import type { FilterGroupId,FontCategory,PageToolbarState,SidebarPage } from './appRuntime'
import { createClearedAdvancedFilterState,nextExpandedFilterGroups } from './fontFilterStateRuntime'

export type FontToolbarFilterRuntimeOptions = {
  sidebarPage: SidebarPage
  setPageToolbarStates: Dispatch<SetStateAction<Record<SidebarPage, PageToolbarState>>>
  reportUserActivity: (reason?: string, durationMs?: number) => void
  userActivityIdleWindowMs: number
  setSelectedWatchedFolders: Dispatch<SetStateAction<string[]>>
  setSelectedFormats: Dispatch<SetStateAction<FontFormat[]>>
  setSelectedScripts: Dispatch<SetStateAction<FontScript[]>>
  setSelectedCategory: Dispatch<SetStateAction<FontCategory>>
  setExpandedFilterGroups: Dispatch<SetStateAction<Partial<Record<FilterGroupId, true>>>>
}

export function createFontToolbarFilterRuntime(options: FontToolbarFilterRuntimeOptions): {
  updatePageToolbar: <K extends keyof PageToolbarState>(key: K, value: PageToolbarState[K]) => void
  clearAdvancedFilters: () => void
  setFilterGroupExpanded: (groupId: FilterGroupId, expanded: boolean) => void
} {
  return {
    updatePageToolbar<K extends keyof PageToolbarState>(key: K, value: PageToolbarState[K]): void {
      options.reportUserActivity(`toolbar:${String(key)}`, options.userActivityIdleWindowMs)
      options.setPageToolbarStates((prev) => ({
        ...prev,
        [options.sidebarPage]: {
          ...prev[options.sidebarPage],
          [key]: value
        }
      }))
    },

    clearAdvancedFilters(): void {
      const next = createClearedAdvancedFilterState()
      options.setSelectedWatchedFolders(next.watchedFolders)
      options.setSelectedFormats(next.formats)
      options.setSelectedScripts(next.scripts)
      options.setSelectedCategory(next.category)
    },

    setFilterGroupExpanded(groupId: FilterGroupId, expanded: boolean): void {
      options.setExpandedFilterGroups((prev) => nextExpandedFilterGroups(prev, groupId, expanded))
    }
  }
}
