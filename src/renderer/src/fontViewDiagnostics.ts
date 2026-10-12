import type { FontItem } from '@shared/types'
import type { BadFontRecordReason } from './library-normalize/libraryNormalizeBase'

export type FontViewRejectionReason = BadFontRecordReason | 'invalid-record' | 'missing-index' | 'time-range' | 'install-status-unknown' | 'install-status-mismatch' | 'active-filter' | 'watched-folder' | 'format' | 'script' | 'category' | 'local-tag' | 'shared-tag' | 'folder' | 'search'
export type FontViewRejectionStage = 'database-row' | 'user-intent' | 'tag-authority' | 'pending-row' | 'frontend-row'
type Decision = FontViewRejectionReason | null

export interface FontViewMembershipDiagnostics {
  source: 'database-page' | 'frontend-fallback'
  totalSource: 'database-query' | 'complete-visible-result' | 'frontend-visible-result'
  rejected: number
  rejectedDatabaseRows: number
  duplicateDatabaseIds: number
  reasons: Partial<Record<FontViewRejectionReason, number>>
  stages: Partial<Record<FontViewRejectionStage, number>>
  samples: Array<{
    row: string
    id: string
    ordinal: number
    stage: FontViewRejectionStage
    rawReason: Decision
    intentReason: Decision
    reason: FontViewRejectionReason
    installKnown: boolean | null
    systemInstalled: boolean
    active: boolean
    recovered: boolean
  }>
}

// Session-local opaque tokens support repeated-query correlation without
// recording names, paths, tag text, preview errors or possibly path-based IDs.
// Both maps are bounded; evicted rows may receive a new token on a later read.
const tokenLimit = 512
const sampleLimit = 8
const idTokens = new Map<string, string>()
const rowTokens = new Map<string, string>()
let tokenSequence = 0
function opaqueToken(tokens: Map<string, string>, key: string, prefix: string): string {
  const previous = tokens.get(key)
  if (previous) return previous
  const token = `${prefix}-${++tokenSequence}`
  if (tokens.size >= tokenLimit) tokens.delete(tokens.keys().next().value!)
  tokens.set(key, token)
  return token
}

export function createFontViewMembershipDiagnostics(database: boolean, complete: boolean, duplicateDatabaseIds = 0): FontViewMembershipDiagnostics {
  return {
    source: database ? 'database-page' : 'frontend-fallback',
    totalSource: database ? complete ? 'complete-visible-result' : 'database-query' : 'frontend-visible-result',
    rejected: 0, rejectedDatabaseRows: 0, duplicateDatabaseIds, reasons: {}, stages: {}, samples: []
  }
}

export function recordFontViewRejection(diagnostics: FontViewMembershipDiagnostics, font: FontItem, ordinal: number,
  stage: FontViewRejectionStage, rawReason: Decision, intentReason: Decision, reason: FontViewRejectionReason): void {
  diagnostics.rejected += 1
  if (stage === 'database-row' || stage === 'user-intent' || stage === 'tag-authority') diagnostics.rejectedDatabaseRows += 1
  diagnostics.reasons[reason] = (diagnostics.reasons[reason] || 0) + 1
  diagnostics.stages[stage] = (diagnostics.stages[stage] || 0) + 1
  if (diagnostics.samples.length >= sampleLimit) return
  diagnostics.samples.push({
    row: opaqueToken(rowTokens, JSON.stringify([font.id, font.path]), 'row'),
    id: opaqueToken(idTokens, font.id, 'id'), ordinal, stage, rawReason, intentReason, reason,
    installKnown: typeof font.installStatusKnown === 'boolean' ? font.installStatusKnown : null,
    systemInstalled: !!font.systemInstalled, active: !!font.active, recovered: font.recoveryPlaceholder === true
  })
}
