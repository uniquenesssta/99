import type { FontItem } from '@shared/types'
import type { RefObject, UIEvent, MouseEvent } from 'react'
import type { CardPoolViewMode, SortMode } from '../../appRuntime'
import type { FontFamilyGroupResult } from '../../runtime/family/fontFamilyGroupingRuntime'

export type FontListPanelProps = {
  sidebarPage: any
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
  developerStatusLog: any[]
  timeSortMode: any
  sortMode: SortMode
  viewMode: any
  cardPoolViewMode: CardPoolViewMode
  activeFilter: any
  setCardPoolViewMode: (mode: CardPoolViewMode) => void
  listPreviewFontSize: number
  setListPreviewFontSize: (value: number) => void
  updatePageToolbar: (key: any, value: any) => void
  updateViewModeWithScroll: (viewMode: any) => void
  search: string
  selectedFontIds: string[]
  library: any
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
  virtualLayout: any
  viewLayout: any
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
