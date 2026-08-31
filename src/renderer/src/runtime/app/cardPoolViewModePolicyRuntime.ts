import type { CardPoolViewMode } from '../../appRuntime'

type ActiveFilterLike = { kind?: string } | null | undefined

export function isFontFamilyViewAllowed(sidebarPage: string, activeFilter: ActiveFilterLike): boolean {
  return sidebarPage !== 'tags' && sidebarPage !== 'sharedTags' && activeFilter?.kind !== 'favorites'
}

export function effectiveCardPoolViewMode(
  cardPoolViewMode: CardPoolViewMode,
  sidebarPage: string,
  activeFilter: ActiveFilterLike
): CardPoolViewMode {
  if (isFontFamilyViewAllowed(sidebarPage, activeFilter)) return cardPoolViewMode
  return cardPoolViewMode === 'list' ? 'list' : 'grid'
}
