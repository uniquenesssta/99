import type { FontItem } from '@shared/types'
import type { OperationTrace } from '../../shared/operationTrace'
import { createFontOperationTrace, reportFontOperation } from './fontOperationTrace'

// Diagnostic identity only. The array lifetime bounds this association; no selection owner.
const entries = new WeakMap<FontItem[], OperationTrace>()
export function activationTargetDigest(ids: string[]): string {
  let hash = 2166136261
  for (const id of ids) {
    for (let i = 0; i < id.length; i++) hash = Math.imul(hash ^ id.charCodeAt(i), 16777619)
    hash = Math.imul(hash ^ 0, 16777619)
  }
  return `ids-${(hash >>> 0).toString(16)}:${ids.length}`
}

export function traceActivationEntry(fonts: FontItem[], entry: string, selected = fonts.length, context?: string): FontItem[] {
  const trace = createFontOperationTrace('font-activation')
  entries.set(fonts, trace)
  reportFontOperation({ trace, stage: 'entry', reason: entry, outcome: context })
  reportFontOperation({ trace: { ...trace, target: activationTargetDigest(fonts.map(font => font.id)) }, stage: 'resolved',
    reason: `selected:${selected}.resolved:${fonts.length}.missing:${Math.max(0, selected - fonts.length)}` })
  return fonts
}

export function activationEntryTrace(fonts: FontItem[]): OperationTrace {
  if (!entries.has(fonts)) traceActivationEntry(fonts, 'other-batch')
  const trace = entries.get(fonts)!
  entries.delete(fonts)
  return trace
}

export function reportActivationTargets(trace: OperationTrace, fonts: FontItem[]): void {
  reportFontOperation({ trace: { ...trace, target: activationTargetDigest(fonts.map(font => font.id)) }, stage: 'targets', reason: `count:${fonts.length}` })
}

export function reportActivationResult(trace: OperationTrace, fonts: FontItem[], results: Record<string, { ok?: boolean; temporaryActivated?: boolean }>): void {
  let activated = 0, failed = 0, skipped = 0
  for (const [index, font] of fonts.entries()) {
    const item = results[font.id]
    const outcome = !item?.ok ? 'unconfirmed' : item.temporaryActivated ? 'activated' : 'not-temporary'
    if (outcome === 'activated') activated++
    else if (outcome === 'unconfirmed') failed++
    else skipped++
    if (index < 16) reportFontOperation({ trace: { ...trace, target: activationTargetDigest([font.id]) }, stage: 'item-result', outcome })
  }
  reportFontOperation({ trace: { ...trace, omitted: Math.max(0, fonts.length - 16) }, stage: 'operation-result',
    outcome: failed ? activated ? 'partial-failure' : 'failed' : activated ? 'activated' : 'all-skipped',
    reason: `activated:${activated}.unconfirmed:${failed}.skipped:${skipped}` })
}
