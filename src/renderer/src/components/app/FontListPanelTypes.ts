import type { FontItem, LibraryState } from '@shared/types'
import type { RefObject, UIEvent, MouseEvent } from 'react'
import type { CardPoolViewMode, SortMode, SidebarPage, ActiveFilter, PageToolbarState, DeveloperStatusEntry, VirtualLayout, VIEW_MODE_LAYOUT } from '../../appRuntime'
import type { FontFamilyGroupResult } from '../../runtime/family/fontFamilyGroupingRuntime'

export type FontListPanelProps = {
  sidebarPage: SidebarPage
  refreshDeveloperStatusDetails: () => Promise<void>
  status: string
  latestIndexProgress: unknown
  developerArchitecture: unknown
  developerSchedulerStatus: unknown
  developerMigrationDiagnostics: unknown
  developerSharedMetadataDiagnostics: unknown
  setDeveloperSharedMetadataDiagnostics: (value: unknown) => void
  latestBackgroundTaskEvent: unknown
  developerTasks: unknown[]
  developerStatusLog: DeveloperStatusEntry[]
  timeSortMode: PageToolbarState['timeSortMode']
  sortMode: SortMode
  viewMode: PageToolbarState['viewMode']
  cardPoolViewMode: CardPoolViewMode
  activeFilter: ActiveFilter
  setCardPoolViewMode: (mode: CardPoolViewMode) => void
  listPreviewFontSize: number
  setListPreviewFontSize: (value: number) => void
  updatePageToolbar: <K extends keyof PageToolbarState>(key: K, value: PageToolbarState[K]) => void
  updateViewModeWithScroll: (viewMode: PageToolbarState['viewMode']) => void
  search: string
  selectedFontIds: string[]
  library: LibraryState
  activateFontsBatch: (fonts: FontItem[], label: string) => Promise<void>
  deactivateFontsBatch: (fonts: FontItem[], label: string) => Promise<void>
  deleteFontsBatch: (fonts: FontItem[], label: string) => Promise<void>
  uninstallFontsBatch: (fonts: FontItem[], label: string) => Promise<void>
  toggleFontDeleteProtection: (fontIds: string[], protect?: boolean) => Promise<void>
  setSelectedFontIds: (ids: string[]) => void
  closeDetail: () => void
  fontScrollerRef: RefObject<HTMLDivElement>
  handleFontScroll: (event: UIEvent<HTMLDivElement>) => void
  beginMarqueeSelection: (event: MouseEvent<HTMLDivElement>) => void
  virtualLayout: VirtualLayout
  viewLayout: (typeof VIEW_MODE_LAYOUT)[keyof typeof VIEW_MODE_LAYOUT]
  renderFontCard: (font: FontItem, compact?: boolean) => JSX.Element
  databasePageReady: boolean
  visibleFontTotal: number
  visibleFonts: FontItem[]
  fontFamilyGroupResult: FontFamilyGroupResult | null
  fontFamilyGroupLoading: boolean
  fontFamilyGroupError: string
  expandedFontFamilyIds: Record<string, true>
  toggleFontFamilyExpanded: (groupId: string) => void
}
