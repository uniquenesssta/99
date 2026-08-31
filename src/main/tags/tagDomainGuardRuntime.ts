import type { FontItem } from '../../shared/types'

const TAG_LOCALE = 'zh-Hans-CN'

export type SharedTagWriteIntent =
  | { mode: 'add'; tag: string }
  | { mode: 'remove'; tag: string }
  | { mode: 'rename'; from: string; to: string }
  | { mode: 'replace' }

export type SharedTagGuardDecision = {
  allowed: boolean
  message?: string
  removedTags: string[]
  addedTags: string[]
}

export function cleanGuardTagNames(tagNamesInput: unknown): string[] {
  return Array.from(
    new Set(
      (Array.isArray(tagNamesInput) ? tagNamesInput : [])
        .map((tag) => String(tag || '').trim())
        .filter(Boolean),
    ),
  ).sort((a, b) => a.localeCompare(b, TAG_LOCALE))
}

function cleanTag(value: unknown): string {
  return String(value || '').trim()
}

export function readSharedTagWriteIntent(item: FontItem | undefined): SharedTagWriteIntent | null {
  const record = item as (FontItem & {
    __sharedTagWriteMode?: unknown
    __sharedTagWriteTag?: unknown
    __sharedTagWriteFrom?: unknown
    __sharedTagWriteTo?: unknown
  }) | undefined
  const mode = cleanTag(record?.__sharedTagWriteMode)
  if (mode === 'add') {
    const tag = cleanTag(record?.__sharedTagWriteTag)
    return tag ? { mode, tag } : null
  }
  if (mode === 'remove') {
    const tag = cleanTag(record?.__sharedTagWriteTag)
    return tag ? { mode, tag } : null
  }
  if (mode === 'rename') {
    const from = cleanTag(record?.__sharedTagWriteFrom)
    const to = cleanTag(record?.__sharedTagWriteTo)
    return from && to && from !== to ? { mode, from, to } : null
  }
  if (mode === 'replace') return { mode }
  return null
}

export function applySharedTagWriteIntent(
  baseTags: unknown,
  requestedTags: unknown,
  intent: SharedTagWriteIntent | null,
): string[] {
  const base = cleanGuardTagNames(baseTags)
  const requested = cleanGuardTagNames(requestedTags)
  if (intent?.mode === 'add') return cleanGuardTagNames([...base, intent.tag])
  if (intent?.mode === 'remove') return cleanGuardTagNames(base.filter((tag) => tag !== intent.tag))
  if (intent?.mode === 'rename') return cleanGuardTagNames(base.map((tag) => tag === intent.from ? intent.to : tag))
  return requested
}

function tagDifference(left: string[], right: string[]): string[] {
  const rightSet = new Set(cleanGuardTagNames(right))
  return cleanGuardTagNames(left).filter((tag) => !rightSet.has(tag))
}

export function guardSharedTagStateChange(options: {
  policy?: string
  baseTags: unknown
  requestedTags: unknown
  intent: SharedTagWriteIntent | null
  allowImplicitReplace?: boolean
}): SharedTagGuardDecision {
  const baseTags = cleanGuardTagNames(options.baseTags)
  const requestedTags = cleanGuardTagNames(options.requestedTags)
  const removedTags = tagDifference(baseTags, requestedTags)
  const addedTags = tagDifference(requestedTags, baseTags)
  if (!removedTags.length) return { allowed: true, removedTags, addedTags }
  if (options.intent?.mode === 'remove' && removedTags.length === 1 && removedTags[0] === options.intent.tag) {
    return { allowed: true, removedTags, addedTags }
  }
  if (options.intent?.mode === 'rename' && removedTags.length === 1 && removedTags[0] === options.intent.from) {
    return { allowed: true, removedTags, addedTags }
  }
  if (options.intent?.mode === 'replace' || options.allowImplicitReplace) {
    return { allowed: true, removedTags, addedTags }
  }
  return {
    allowed: false,
    removedTags,
    addedTags,
    message: `共享标签保护层拦截旧快照覆盖：将移除 ${removedTags.join('、')}，但没有明确删除/重命名意图。`,
  }
}
