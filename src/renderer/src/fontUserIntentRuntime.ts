import type { FontItem } from '@shared/types'

// Symbols survive renderer object spreads, but are excluded from IPC/JSON persistence.
const intentKey = Symbol('fontUserIntent')
type ActiveState = Pick<FontItem, 'active' | 'activeSince' | 'managedInstallPath' | 'managedRegistryName'>
type Intent = { active?: ActiveState; favorite?: { value: boolean; settled: boolean; confirmed: { value: boolean } } }
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
  return { ...font, favorite: value, [intentKey]: { ...(font as IntentFont)[intentKey], favorite: { value, settled: false, confirmed: (font as IntentFont)[intentKey]?.favorite?.confirmed || { value: !!font.favorite } } } } as IntentFont
}

export function settleFavoriteIntent(font: FontItem): void {
  const favorite = (font as IntentFont)[intentKey]?.favorite
  if (!favorite || favorite.settled) return
  favorite.confirmed.value = favorite.value
  favorite.settled = true
  revision += 1
}

export function isSameFavoriteIntent(current: FontItem | undefined, request: FontItem): boolean {
  const expected = (request as IntentFont)[intentKey]?.favorite
  return !!expected && (current as IntentFont | undefined)?.[intentKey]?.favorite === expected
}

export function rollbackFavoriteIntent(current: FontItem, request: FontItem): FontItem {
  if (!isSameFavoriteIntent(current, request)) return current
  const previous = (request as IntentFont)[intentKey]!.favorite!
  revision += 1
  // A prior in-flight write may have committed after this request was created.
  // Restore the latest confirmed local value, not a previous optimistic value.
  return { ...current, favorite: previous.confirmed.value, [intentKey]: {
    ...(current as IntentFont)[intentKey],
    favorite: { value: previous.confirmed.value, settled: true, confirmed: previous.confirmed }
  } } as IntentFont
}

export function hasFontUserIntent(font: FontItem): boolean {
  const intent = (font as IntentFont)[intentKey]
  return !!(intent?.active || intent?.favorite)
}

export function hasUnsettledFavoriteIntent(font: FontItem): boolean {
  const favorite = (font as IntentFont)[intentKey]?.favorite
  return !!favorite && !favorite.settled
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
