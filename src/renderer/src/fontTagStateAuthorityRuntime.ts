import type { FontItem, LibraryState } from '@shared/types'
import type { OperationTrace } from '../../shared/operationTrace'
import { reportFontOperation } from './fontOperationTrace'
export type FontTagAuthorityScope = 'local' | 'shared'

// Session-only tokens are shared by UI copies and their original queue entry.
// Object identity, not a trace ID or a clock, binds a completion to its edit.
const localIntent = Symbol('localTagIntent')
const sharedIntent = Symbol('sharedTagIntent')
const catalogRevision = Symbol('tagCatalogRevision')
const draftCatalog = Symbol('tagDraftCatalog')
type Phase = 'queued' | 'sending' | 'retry' | 'committed' | 'confirmed' | 'cancelled'
type Intent = {
  generation: number
  tags: string[]
  phase: Phase
  trace?: OperationTrace
  readTags?: string[]
  catalogAfterCommit?: boolean
}
type IntentFont = FontItem & { [localIntent]?: Intent; [sharedIntent]?: Intent }
type AuthorityLibrary = LibraryState & { [catalogRevision]?: Partial<Record<FontTagAuthorityScope, number>>; [draftCatalog]?: Partial<Record<FontTagAuthorityScope, string[]>> }
const intentKey = (scope: FontTagAuthorityScope) => scope === 'local' ? localIntent : sharedIntent
const tagField = (scope: FontTagAuthorityScope) => scope === 'local' ? 'localTagNames' : 'tagNames'
const revisionField = (scope: FontTagAuthorityScope) => scope === 'local' ? '__localTagRevision' : '__sharedTagRevision'
const authorityField = (scope: FontTagAuthorityScope) => scope === 'local' ? '__localTagAuthorityKnown' : '__sharedTagAuthorityKnown'
const intentOf = (font: FontItem | undefined, scope: FontTagAuthorityScope) => (font as IntentFont | undefined)?.[intentKey(scope)]
const sortedUniqueTagNames = (tags: string[]) => Array.from(new Set(tags)).sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'))
const keepEqualTags = (old: string[] | undefined, next: string[]): string[] => old && old.length === next.length && old.every((tag, i) => tag === next[i]) ? old : next
const cleanTagNames = (tags: string[] | undefined) => sortedUniqueTagNames((tags || []).map(tag => String(tag || '').trim()).filter(Boolean))
const numericValue = (value: number | undefined) => Number.isFinite(value) && Number(value) > 0 ? Number(value) : 0
function report(intent: Intent, scope: FontTagAuthorityScope, stage: string, reason: string): void {
  reportFontOperation({ trace: intent.trace, stage, reason: `${scope}-g${intent.generation}-${reason}` })
}

export function isLibraryTagAuthorityKnown(library: LibraryState, scope: FontTagAuthorityScope): boolean {
  return library[authorityField(scope)] === true
}
export function isFontTagStateDirty(font: FontItem | undefined, scope: FontTagAuthorityScope, _nowMs = Date.now()): boolean {
  const intent = intentOf(font, scope)
  return !!intent && intent.phase !== 'confirmed' && intent.phase !== 'cancelled'
}
export function markFontTagsOptimistic(font: FontItem, scope: FontTagAuthorityScope, tagNames: string[], _nowMs = Date.now()): FontItem {
  const previous = intentOf(font, scope)
  const tags = cleanTagNames(tagNames)
  const intent: Intent = { generation: (previous?.generation || 0) + 1, tags, phase: 'queued' }
  return { ...font, [tagField(scope)]: tags, [intentKey(scope)]: intent }
}
export function beginFontTagWrite(font: FontItem, scope: FontTagAuthorityScope, trace?: OperationTrace): void {
  const intent = intentOf(font, scope)
  if (!intent || intent.phase === 'cancelled') return
  intent.trace = trace
  intent.phase = 'sending'
  report(intent, scope, 'intent-dispatch', 'intent-sending')
}
export function settleFontTagWrite(font: FontItem, scope: FontTagAuthorityScope, success: boolean): void {
  const intent = intentOf(font, scope)
  if (!intent || intent.phase === 'cancelled') return
  intent.phase = success ? 'committed' : 'retry'
  intent.catalogAfterCommit = false
  report(intent, scope, success ? 'intent-committed' : 'intent-retry', success ? 'own-write-ack' : 'intent-retained')
}
export function isSameFontTagIntent(current: FontItem | undefined, written: FontItem, scope: FontTagAuthorityScope): boolean {
  return !!intentOf(written, scope) && intentOf(current, scope) === intentOf(written, scope)
}
// Capture only writes acknowledged BEFORE this request. An accepted fresh read
// may reflect a later external edit or an empty tag page, so equality is not required.
export function captureFontTagReadConfirmation(library: LibraryState): (current: LibraryState, items?: FontItem[]) => LibraryState {
  const pending: Array<{ id: string; scope: FontTagAuthorityScope; intent: Intent }> = []
  for (const font of Object.values(library.fonts || {})) for (const scope of ['local', 'shared'] as const) {
    const intent = intentOf(font, scope)
    if (intent?.phase === 'committed') pending.push({ id: font.id, scope, intent })
  }
  return (current, items = []) => {
    const incoming = new Map(items.map(font => [font.id, font]))
    let fonts = current.fonts
    for (const { id, scope, intent } of pending) {
      if (intentOf(current.fonts[id], scope) !== intent || intent.phase !== 'committed') continue
      const tags = incoming.get(id)?.[tagField(scope)]
      // A page may omit the edited font. Its absence alone does not mean a
      // successful tag was deleted; only a newer catalog can establish that.
      intent.readTags = Array.isArray(tags) ? cleanTagNames(tags) : intent.catalogAfterCommit ? undefined : intent.tags
      intent.phase = 'confirmed'
      report(intent, scope, 'view-apply', 'post-ack-read-confirmed')
      if (fonts === current.fonts) fonts = { ...fonts }
      fonts[id] = { ...fonts[id] }
    }
    return fonts === current.fonts ? current : ensureLibraryTagNamesContainFontTags({ ...current, fonts })
  }
}
export function applyFontTagEdit(current: FontItem, edited: FontItem, scope: FontTagAuthorityScope): FontItem {
  return { ...current, [tagField(scope)]: edited[tagField(scope)], [intentKey(scope)]: intentOf(edited, scope) }
}
export function cancelFontTagWrite(font: FontItem, scope: FontTagAuthorityScope): void {
  const intent = intentOf(font, scope)
  if (!intent) return
  intent.phase = 'cancelled'
  report(intent, scope, 'cancel', 'newer-intent')
}
// Compatibility callers cannot clean an intent without its specific write result.
export function markFontTagStateClean(font: FontItem, _scope: FontTagAuthorityScope, _nowMs = Date.now()): FontItem { return font }

export function filterFontByLibraryTagAuthority(library: LibraryState, font: FontItem): FontItem {
  let nextFont = font
  for (const scope of ['shared', 'local'] as const) {
    if (!isLibraryTagAuthorityKnown(library, scope) || isFontTagStateDirty(font, scope)) continue
    const key = tagField(scope)
    const known = new Set(cleanTagNames(scope === 'local' ? library.localTags : library.tags))
    const tags = cleanTagNames(nextFont[key])
    const filtered = tags.filter(tag => known.has(tag))
    if (filtered.length !== tags.length) nextFont = { ...nextFont, [key]: filtered }
  }
  return nextFont
}
export function mergeFontTagState(existing: FontItem | undefined, incoming: FontItem, scope: FontTagAuthorityScope, _nowMs = Date.now()): Partial<FontItem> {
  const key = tagField(scope), revisionKey = revisionField(scope)
  const intent = intentOf(existing, scope)
  const incomingHasTags = Array.isArray(incoming[key])
  const incomingTags = cleanTagNames(incoming[key])
  const oldRevision = numericValue(existing?.[revisionKey]), revision = numericValue(incoming[revisionKey])
  const stale = revision > 0 && oldRevision > revision
  if (intent?.phase === 'committed' && incomingHasTags && !stale && JSON.stringify(incomingTags) === JSON.stringify(intent.tags)) {
    intent.phase = 'confirmed'
    intent.readTags = incomingTags
    report(intent, scope, 'view-apply', 'matching-read-confirmed')
  }
  const protect = isFontTagStateDirty(existing, scope)
  return {
    [key]: protect || stale || (!incomingHasTags && existing) ? cleanTagNames(existing?.[key]) : incomingTags,
    [revisionKey]: stale ? oldRevision : revision || oldRevision || undefined,
    [intentKey(scope)]: intent,
    ...(scope === 'local' ? { __localTagDirtyUntil: undefined } : { __sharedTagDirtyUntil: undefined })
  }
}
export function mergeFontTagsFromIncoming(existing: FontItem | undefined, incoming: FontItem, nowMs = Date.now()): Partial<FontItem> {
  return { ...mergeFontTagState(existing, incoming, 'shared', nowMs), ...mergeFontTagState(existing, incoming, 'local', nowMs) }
}
export function mergeFontWithTagAuthority(existing: FontItem | undefined, incoming: FontItem, nowMs = Date.now()): FontItem {
  return { ...incoming, ...mergeFontTagsFromIncoming(existing, incoming, nowMs) }
}
export function ensureLibraryTagNamesContainFontTags(library: LibraryState): LibraryState {
  // Keep draft-only catalog additions distinguishable from backend authority.
  // Otherwise a rejected old catalog is polluted permanently by pending tags.
  const drafts = (library as AuthorityLibrary)[draftCatalog] || {}
  const sharedTags = new Set(cleanTagNames(library.tags).filter(tag => !drafts.shared?.includes(tag)))
  const localTags = new Set(cleanTagNames(library.localTags).filter(tag => !drafts.local?.includes(tag)))
  // Confirmed read evidence supersedes the preceding catalog. A later catalog
  // signal clears this evidence, so explicit external deletions still win.
  for (const font of Object.values(library.fonts || {})) {
    for (const scope of ['local', 'shared'] as const) {
      const tags = scope === 'local' ? localTags : sharedTags
      for (const tag of intentOf(font, scope)?.readTags || []) tags.add(tag)
    }
  }
  const authority = { ...library, tags: [...sharedTags], localTags: [...localTags] }
  const nextDrafts: Record<FontTagAuthorityScope, string[]> = { local: [], shared: [] }
  let changed = false
  const fonts: LibraryState['fonts'] = {}
  for (const [id, original] of Object.entries(library.fonts || {})) {
    const font = filterFontByLibraryTagAuthority(authority, original)
    changed ||= font !== original
    fonts[id] = font
    for (const scope of ['local', 'shared'] as const) {
      const tags = scope === 'local' ? localTags : sharedTags
      if (!isLibraryTagAuthorityKnown(library, scope) || isFontTagStateDirty(font, scope)) {
        for (const tag of cleanTagNames(font[tagField(scope)])) {
          if (!tags.has(tag) && isLibraryTagAuthorityKnown(library, scope)) nextDrafts[scope].push(tag)
          tags.add(tag)
        }
      }
    }
  }
  return { ...library, fonts: changed ? fonts : library.fonts, tags: keepEqualTags(library.tags, sortedUniqueTagNames([...sharedTags])), localTags: keepEqualTags(library.localTags, sortedUniqueTagNames([...localTags])), [draftCatalog]: nextDrafts } as AuthorityLibrary
}
export function applyFontTagMutationSignalToLibrary(library: LibraryState, signal: {
  scope?: FontTagAuthorityScope; changedIds?: string[]; updatedAt?: string; localRevision?: number; sharedRevision?: number; knownTags?: string[]; trace?: OperationTrace
}, _nowMs = Date.now()): LibraryState {
  const scope = signal.scope === 'shared' ? 'shared' : 'local'
  const revisions = (library as AuthorityLibrary)[catalogRevision] || {}
  const revision = numericValue(scope === 'local' ? signal.localRevision : signal.sharedRevision)
  if (revision > 0 && revision <= (revisions[scope] || 0)) {
    reportFontOperation({ trace: signal.trace, stage: 'view-reject', reason: `${scope}-stale-catalog-revision` })
    return library
  }
  for (const font of Object.values(library.fonts || {})) {
    const intent = intentOf(font, scope)
    if (!intent) continue
    if (Array.isArray(signal.knownTags)) {
      intent.readTags = undefined
      if (intent.phase === 'committed') intent.catalogAfterCommit = true
    }
    if (!isFontTagStateDirty(font, scope)) continue
    // Broadcasts carry no per-edit identity, including after an IPC success.
    report(intent, scope, 'view-reject', 'broadcast-cannot-ack-intent')
  }
  const hasKnownTags = Array.isArray(signal.knownTags)
  let next: AuthorityLibrary = { ...library, [catalogRevision]: { ...revisions, ...(revision > 0 ? { [scope]: revision } : {}) } }
  if (hasKnownTags) {
    next = { ...next, [draftCatalog]: { ...(library as AuthorityLibrary)[draftCatalog], [scope]: [] }, ...(scope === 'local'
      ? { localTags: keepEqualTags(library.localTags, cleanTagNames(signal.knownTags)), __localTagAuthorityKnown: true }
      : { tags: keepEqualTags(library.tags, cleanTagNames(signal.knownTags)), __sharedTagAuthorityKnown: true }) }
  }
  return ensureLibraryTagNamesContainFontTags(next)
}
