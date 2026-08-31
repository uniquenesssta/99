import type { FontItem,LibraryState } from '@shared/types'
export type FontTagAuthorityScope = 'local' | 'shared'

const TAG_DIRTY_PROTECTION_MS = 20_000
const TAG_LOCALE = 'zh-Hans-CN'

function sortedUniqueTagNames(tags: string[]): string[] {
  return Array.from(new Set(tags)).sort((a, b) => a.localeCompare(b, TAG_LOCALE))
}

function tagField(scope: FontTagAuthorityScope): 'localTagNames' | 'tagNames' {
  return scope === 'local' ? 'localTagNames' : 'tagNames'
}

function revisionField(scope: FontTagAuthorityScope): '__localTagRevision' | '__sharedTagRevision' {
  return scope === 'local' ? '__localTagRevision' : '__sharedTagRevision'
}

function dirtyUntilField(scope: FontTagAuthorityScope): '__localTagDirtyUntil' | '__sharedTagDirtyUntil' {
  return scope === 'local' ? '__localTagDirtyUntil' : '__sharedTagDirtyUntil'
}

function authorityField(scope: FontTagAuthorityScope): '__localTagAuthorityKnown' | '__sharedTagAuthorityKnown' {
  return scope === 'local' ? '__localTagAuthorityKnown' : '__sharedTagAuthorityKnown'
}

function cleanTagNames(tags: string[] | undefined): string[] {
  return sortedUniqueTagNames((tags || []).map((tag) => String(tag || '').trim()).filter(Boolean))
}

export function isLibraryTagAuthorityKnown(library: LibraryState, scope: FontTagAuthorityScope): boolean {
  return library[authorityField(scope)] === true
}

export function filterFontByLibraryTagAuthority(library: LibraryState, font: FontItem): FontItem {
  let nextFont = font
  for (const scope of ['shared', 'local'] as const) {
    if (!isLibraryTagAuthorityKnown(library, scope)) continue
    const tagsKey = tagField(scope)
    const knownTags = new Set(cleanTagNames(scope === 'local' ? library.localTags : library.tags))
    const currentTags = cleanTagNames((nextFont as any)[tagsKey])
    const nextTags = currentTags.filter((tag) => knownTags.has(tag))
    if (nextTags.length === currentTags.length) continue
    nextFont = { ...nextFont, [tagsKey]: nextTags } as FontItem
  }
  return nextFont
}

function numericValue(value: unknown): number {
  const numberValue = typeof value === 'number' ? value : Number(value || 0)
  return Number.isFinite(numberValue) ? numberValue : 0
}

export function isFontTagStateDirty(font: FontItem | undefined, scope: FontTagAuthorityScope, nowMs = Date.now()): boolean {
  if (!font) return false
  return numericValue((font as any)[dirtyUntilField(scope)]) > nowMs
}

export function markFontTagsOptimistic(
  font: FontItem,
  scope: FontTagAuthorityScope,
  tagNames: string[],
  nowMs = Date.now()
): FontItem {
  const revisionKey = revisionField(scope)
  const dirtyKey = dirtyUntilField(scope)
  const nextRevision = Math.max(numericValue((font as any)[revisionKey]) + 1, nowMs)
  return {
    ...font,
    [tagField(scope)]: cleanTagNames(tagNames),
    [revisionKey]: nextRevision,
    [dirtyKey]: nowMs + TAG_DIRTY_PROTECTION_MS
  } as FontItem
}

export function markFontTagStateClean(font: FontItem, scope: FontTagAuthorityScope, nowMs = Date.now()): FontItem {
  const dirtyKey = dirtyUntilField(scope)
  if (!isFontTagStateDirty(font, scope, nowMs)) return font
  return {
    ...font,
    [dirtyKey]: nowMs
  } as FontItem
}

export function mergeFontTagState(
  existing: FontItem | undefined,
  incoming: FontItem,
  scope: FontTagAuthorityScope,
  nowMs = Date.now()
): Partial<FontItem> {
  const tagsKey = tagField(scope)
  const revisionKey = revisionField(scope)
  const dirtyKey = dirtyUntilField(scope)
  const existingTags = cleanTagNames(existing ? (existing as any)[tagsKey] : undefined)
  const incomingHasTags = Array.isArray((incoming as any)[tagsKey])
  const incomingTags = cleanTagNames(incomingHasTags ? (incoming as any)[tagsKey] : undefined)
  const existingRevision = numericValue(existing ? (existing as any)[revisionKey] : 0)
  const incomingRevision = numericValue((incoming as any)[revisionKey])
  const dirty = isFontTagStateDirty(existing, scope, nowMs)

  if (dirty || (incomingRevision > 0 && existingRevision > incomingRevision)) {
    return {
      [tagsKey]: existingTags,
      [revisionKey]: existingRevision,
      [dirtyKey]: existing ? (existing as any)[dirtyKey] : undefined
    } as Partial<FontItem>
  }

  if (!incomingHasTags && existing) {
    return {
      [tagsKey]: existingTags,
      [revisionKey]: existingRevision,
      [dirtyKey]: existing ? (existing as any)[dirtyKey] : undefined
    } as Partial<FontItem>
  }

  return {
    [tagsKey]: incomingTags,
    [revisionKey]: incomingRevision || existingRevision || undefined,
    [dirtyKey]: undefined
  } as Partial<FontItem>
}

export function mergeFontTagsFromIncoming(existing: FontItem | undefined, incoming: FontItem, nowMs = Date.now()): Partial<FontItem> {
  return {
    ...mergeFontTagState(existing, incoming, 'shared', nowMs),
    ...mergeFontTagState(existing, incoming, 'local', nowMs)
  }
}

export function mergeFontWithTagAuthority(existing: FontItem | undefined, incoming: FontItem, nowMs = Date.now()): FontItem {
  if (!existing) {
    return {
      ...incoming,
      tagNames: cleanTagNames(incoming.tagNames),
      localTagNames: cleanTagNames(incoming.localTagNames)
    }
  }
  return {
    ...incoming,
    ...mergeFontTagsFromIncoming(existing, incoming, nowMs)
  }
}

export function ensureLibraryTagNamesContainFontTags(library: LibraryState): LibraryState {
  const sharedAuthorityKnown = isLibraryTagAuthorityKnown(library, 'shared')
  const localAuthorityKnown = isLibraryTagAuthorityKnown(library, 'local')
  const sharedTags = new Set(cleanTagNames(library.tags))
  const localTags = new Set(cleanTagNames(library.localTags))
  let fontsChanged = false
  const nextFonts: LibraryState['fonts'] = {}

  for (const [fontId, originalFont] of Object.entries(library.fonts || {})) {
    const font = filterFontByLibraryTagAuthority(library, originalFont)
    if (font !== originalFont) fontsChanged = true
    nextFonts[fontId] = font

    if (!sharedAuthorityKnown) {
      for (const tag of cleanTagNames(font.tagNames)) sharedTags.add(tag)
    }
    if (!localAuthorityKnown) {
      for (const tag of cleanTagNames(font.localTagNames)) localTags.add(tag)
    }
  }

  return {
    ...library,
    fonts: fontsChanged ? nextFonts : library.fonts,
    tags: sortedUniqueTagNames(Array.from(sharedTags)),
    localTags: sortedUniqueTagNames(Array.from(localTags))
  }
}

export function applyFontTagMutationSignalToLibrary(
  library: LibraryState,
  signal: {
    scope?: FontTagAuthorityScope
    changedIds?: string[]
    updatedAt?: string
    localRevision?: number
    sharedRevision?: number
    knownTags?: string[]
  },
  nowMs = Date.now()
): LibraryState {
  const scope = signal.scope === 'shared' ? 'shared' : 'local'
  const revisionKey = revisionField(scope)
  const dirtyKey = dirtyUntilField(scope)
  const changedIds = new Set((signal.changedIds || []).map((id) => String(id || '').trim()).filter(Boolean))
  const appliesToAllKnownFonts = changedIds.size === 0
  const signalRevision = scope === 'local' ? numericValue(signal.localRevision) : numericValue(signal.sharedRevision)
  const updatedAtRevision = Number.isFinite(Date.parse(signal.updatedAt || '')) ? Date.parse(signal.updatedAt || '') : 0
  const nextRevisionBase = Math.max(signalRevision, updatedAtRevision, nowMs)
  let changed = false
  const nextFonts: LibraryState['fonts'] = {}

  for (const [fontId, font] of Object.entries(library.fonts || {})) {
    if (!appliesToAllKnownFonts && !changedIds.has(fontId)) {
      nextFonts[fontId] = font
      continue
    }
    const currentRevision = numericValue((font as any)[revisionKey])
    const nextRevision = Math.max(currentRevision, nextRevisionBase)
    const currentDirtyUntil = numericValue((font as any)[dirtyKey])
    if (currentRevision === nextRevision && currentDirtyUntil <= nowMs) {
      nextFonts[fontId] = font
      continue
    }
    nextFonts[fontId] = {
      ...font,
      [revisionKey]: nextRevision,
      [dirtyKey]: nowMs
    } as FontItem
    changed = true
  }

  const hasKnownTags = Array.isArray(signal.knownTags)
  const knownTags = cleanTagNames(signal.knownTags)
  let authoritativeFonts = changed ? nextFonts : library.fonts
  if (hasKnownTags) {
    const knownTagSet = new Set(knownTags)
    const tagsKey = tagField(scope)
    let filtered = false
    const filteredFonts: LibraryState['fonts'] = {}
    for (const [fontId, font] of Object.entries(authoritativeFonts || {})) {
      const currentTags = cleanTagNames((font as any)[tagsKey])
      const nextTags = currentTags.filter((tag) => knownTagSet.has(tag))
      if (nextTags.length !== currentTags.length) {
        filteredFonts[fontId] = { ...font, [tagsKey]: nextTags } as FontItem
        filtered = true
      } else {
        filteredFonts[fontId] = font
      }
    }
    if (filtered) authoritativeFonts = filteredFonts
  }

  const nextLibrary = {
    ...library,
    fonts: authoritativeFonts,
    ...(hasKnownTags
      ? scope === 'local'
        ? { localTags: knownTags, __localTagAuthorityKnown: true }
        : { tags: knownTags, __sharedTagAuthorityKnown: true }
      : {})
  }

  return ensureLibraryTagNamesContainFontTags(nextLibrary)
}
