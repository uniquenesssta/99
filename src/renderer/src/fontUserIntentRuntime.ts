import type { FontItem } from '@shared/types'

// Symbols survive renderer object spreads, but are excluded from IPC/JSON persistence.
const intentKey = Symbol('fontUserIntent')
type ActiveState = Pick<FontItem, 'active' | 'activeSince' | 'managedInstallPath' | 'managedRegistryName'>
type Intent = { active?: ActiveState; favorite?: { value: boolean; settled: boolean } }
type IntentFont = FontItem & { [intentKey]?: Intent }
let revision = 0

export function fontUserIntentRevision(): number { return revision }

export function markActiveIntent(font: FontItem): FontItem {
  revision += 1
  const { active, activeSince, managedInstallPath, managedRegistryName } = font
  return { ...font, [intentKey]: { ...(font as IntentFont)[intentKey], active: { active, activeSince, managedInstallPath, managedRegistryName } } } as IntentFont
}

export function markFavoriteIntent(font: FontItem, value: boolean): FontItem {
  revision += 1
  return { ...font, favorite: value, [intentKey]: { ...(font as IntentFont)[intentKey], favorite: { value, settled: false } } } as IntentFont
}

export function settleFavoriteIntent(font: FontItem): void {
  const favorite = (font as IntentFont)[intentKey]?.favorite
  if (!favorite || favorite.settled) return
  favorite.settled = true
  revision += 1
}

export function hasFontUserIntent(font: FontItem): boolean {
  const intent = (font as IntentFont)[intentKey]
  return !!(intent?.active || intent?.favorite)
}

export function hasFavoriteIntent(font: FontItem): boolean {
  return !!(font as IntentFont)[intentKey]?.favorite
}

export function mergeFontUserIntent(existing: FontItem | undefined, incoming: FontItem): FontItem {
  const intent = (existing as IntentFont | undefined)?.[intentKey]
  if (!intent) return incoming
  const favorite = intent.favorite
  // A successful write plus a matching read acknowledges the optimistic membership.
  const keepFavorite = favorite && (!favorite.settled || incoming.favorite !== favorite.value)
  return {
    ...incoming,
    ...intent.active,
    ...(keepFavorite ? { favorite: favorite.value } : {}),
    [intentKey]: { active: intent.active, favorite: keepFavorite ? favorite : undefined }
  } as IntentFont
}
