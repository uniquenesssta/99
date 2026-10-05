import type { FontItem } from '../../shared/types'
import { normalizePathForCacheCompare as key } from '../path/cachePath'

export function recoveryCandidate(old: FontItem, next: FontItem): boolean {
  return old.fileSize > 0 && old.fileSize === next.fileSize && old.format === next.format
    && (!old.postscriptName || old.postscriptName === next.postscriptName && old.style === next.style)
}

export function sameRecoveryFont(old: FontItem, next: FontItem): boolean {
  return old.fileSize > 0 && old.fileSize === next.fileSize && old.format === next.format && !!old.recoveryContentHash
    && /^[a-f0-9]{64}$/.test(old.recoveryContentHash) && old.recoveryContentHash === next.recoveryContentHash
}

export function uniqueRecoveryPairs(missing: FontItem[], candidates: FontItem[], compare = key): Array<[FontItem, FontItem]> {
  const unique = [...new Map(candidates.map(font => [compare(font.path), font])).values()]
  const choices = missing.map(old => ({ old, matches: unique.filter(next => compare(old.path) !== compare(next.path) && sameRecoveryFont(old, next)) }))
  return choices.flatMap(({ old, matches }) => matches.length === 1 && choices.filter(choice => choice.matches.some(next => compare(next.path) === compare(matches[0].path))).length === 1
    ? [[old, matches[0]] as [FontItem, FontItem]] : [])
}
