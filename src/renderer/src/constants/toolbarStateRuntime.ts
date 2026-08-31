import type { PageToolbarState,SidebarPage } from '../appTypes'

export function createDefaultPageToolbarState(): PageToolbarState {
  return {
    search: '',
    installStatus: 'all',
    timeSortMode: 'created',
    sortMode: 'smart',
    viewMode: 'comfortable'
  }
}

export function createDefaultPageToolbarStates(): Record<SidebarPage, PageToolbarState> {
  return {
    library: createDefaultPageToolbarState(),
    filters: createDefaultPageToolbarState(),
    tags: createDefaultPageToolbarState(),
    sharedTags: createDefaultPageToolbarState(),
    folders: createDefaultPageToolbarState(),
    developer: createDefaultPageToolbarState()
  }
}
