import { beginFontTagWrite, settleFontTagWrite, cancelFontTagWrite, type FontTagAuthorityScope } from './fontTagStateAuthorityRuntime'
import { dispatchFontWrites, settleFontWrites, cancelFontWrite, fontWriteTrace } from './fontOperationTrace'
import type { OperationTrace } from '../../shared/operationTrace'
import { settleFavoriteIntent } from './fontUserIntentRuntime'
import type { FontItem, FontProtectionResult, FontTagUpdateResult } from '@shared/types'
import type { HfmApi } from '../../preload'
import type { QueuedFontWriteState } from './appTypes'

export function createEmptyQueuedFontWriteState(): QueuedFontWriteState {
  return {
    localTags: new Map(),
    sharedTags: new Map(),
    favorite: new Map(),
    protection: new Map()
  }
}

export function estimateFontWriteBytes(queue: QueuedFontWriteState): number {
  let bytes = 0
  for (const entry of queue.localTags.values()) bytes += 280 + entry.tagNames.join('\u0000').length * 2
  for (const entry of queue.sharedTags.values()) bytes += 320 + entry.tagNames.join('\u0000').length * 2
  bytes += queue.favorite.size * 160
  bytes += queue.protection.size * 160
  return bytes
}

export function queuedFontWriteCount(queue: QueuedFontWriteState): number {
  return queue.localTags.size + queue.sharedTags.size + queue.favorite.size + queue.protection.size
}

export function mergeQueuedFontWritesPreservingNewer(
  target: QueuedFontWriteState,
  retryQueue: QueuedFontWriteState
): void {
  for (const [id, entry] of retryQueue.localTags) {
    if (!target.localTags.has(id)) target.localTags.set(id, entry)
    else { cancelFontTagWrite(entry.item, 'local'); cancelFontWrite(entry, 'newer-queued-intent') }
  }
  for (const [id, entry] of retryQueue.sharedTags) {
    if (!target.sharedTags.has(id)) target.sharedTags.set(id, entry)
    else { cancelFontTagWrite(entry.item, 'shared'); cancelFontWrite(entry, 'newer-queued-intent') }
  }
  for (const [id, entry] of retryQueue.favorite) {
    if (!target.favorite.has(id)) target.favorite.set(id, entry)
    else cancelFontWrite(entry, 'newer-queued-intent')
  }
  for (const [id, entry] of retryQueue.protection) {
    if (!target.protection.has(id)) target.protection.set(id, entry)
    else cancelFontWrite(entry, 'newer-queued-intent')
  }
}

export interface FlushQueuedFontWriteQueueOptions {
  queue: QueuedFontWriteState
  hfm: HfmApi
  folders: string[]
}

export interface FlushQueuedFontWriteQueueResult {
  attemptedCount: number
  wroteCount: number
  failures: string[]
  retryQueue: QueuedFontWriteState
}

type MutationResult = Pick<FontTagUpdateResult, 'ok' | 'updatedIds' | 'failed' | 'message'>
  | Pick<FontProtectionResult, 'ok' | 'updatedIds' | 'failed' | 'message'>

function failedIdsFromResult(result: MutationResult, candidateIds: string[]): Set<string> {
  const failedIds = new Set(
    Array.isArray(result.failed)
      ? result.failed.map((entry) => String(entry?.id || '')).filter(Boolean)
      : []
  )
  if (result.ok !== false) return failedIds

  const updatedIds = new Set(Array.isArray(result.updatedIds) ? result.updatedIds.map(String) : [])
  for (const id of candidateIds) {
    if (!updatedIds.has(id)) failedIds.add(id)
  }
  return failedIds
}

function resultFailureMessage(result: MutationResult, fallback: string): string | null {
  const failed = Array.isArray(result.failed) ? result.failed : []
  if (result.ok !== false && !failed.length) return null
  const first = failed[0]
  const detail = first
    ? `${String(first.fileName || '').trim() || '未知字体'}：${String(first.message || '').trim() || '未知原因'}`
    : ''
  const message = String(result.message || fallback || '').trim()
  return [message, detail].filter(Boolean).join('；') || fallback
}

function retryTagEntries(
  source: QueuedFontWriteState['localTags'],
  failedIds: Set<string>,
  target: QueuedFontWriteState['localTags']
): void {
  for (const id of failedIds) {
    const entry = source.get(id)
    if (entry) target.set(id, entry)
  }
}

function retryBooleanEntries<T extends { font: FontItem }>(
  source: Map<string, T>,
  failedIds: Set<string>,
  target: Map<string, T>
): void {
  for (const id of failedIds) {
    const entry = source.get(id)
    if (entry) target.set(id, entry)
  }
}

async function flushTagEntries(args: {
  label: string
  scope: FontTagAuthorityScope
  entries: QueuedFontWriteState['localTags']
  retryEntries: QueuedFontWriteState['localTags']
  batch?: (items: Array<{ item: FontItem; tagNames: string[] }>, trace?: OperationTrace) => Promise<FontTagUpdateResult>
  single?: (item: FontItem, tagNames: string[], trace?: OperationTrace) => Promise<FontTagUpdateResult>
}): Promise<{ wroteCount: number; failures: string[] }> {
  const items = Array.from(args.entries.values())
  if (!items.length) return { wroteCount: 0, failures: [] }

  const failures: string[] = []
  const dispatch = (entries: typeof items): OperationTrace | undefined => {
    const trace = dispatchFontWrites(entries)
    for (const entry of entries) beginFontTagWrite(entry.item, args.scope, fontWriteTrace(entry))
    return trace
  }
  const settle = (entries: typeof items, failed: Set<string>): void => {
    for (const entry of entries) settleFontTagWrite(entry.item, args.scope, !failed.has(entry.item.id))
    settleFontWrites(entries, failed, entry => entry.item.id)
  }
  if (args.batch) {
    try {
      const result = await args.batch(items, dispatch(items))
      const candidateIds = items.map((entry) => entry.item.id)
      const failedIds = failedIdsFromResult(result, candidateIds)
      retryTagEntries(args.entries, failedIds, args.retryEntries)
      settle(items, failedIds)
      const failure = resultFailureMessage(result, `${args.label} ${items.length} 个失败`)
      if (failure) failures.push(failure)
      return { wroteCount: items.length - failedIds.size, failures }
    } catch (error) {
      retryTagEntries(args.entries, new Set(items.map((entry) => entry.item.id)), args.retryEntries)
      settle(items, new Set(items.map(entry => entry.item.id)))
      failures.push(`${args.label} ${items.length} 个：${error instanceof Error ? error.message : String(error)}`)
      return { wroteCount: 0, failures }
    }
  }

  if (args.single) {
    let wroteCount = 0
    for (const entry of items) {
      try {
        const result = await args.single(entry.item, entry.tagNames, dispatch([entry]))
        const failedIds = failedIdsFromResult(result, [entry.item.id])
        retryTagEntries(args.entries, failedIds, args.retryEntries)
        settle([entry], failedIds)
        const failure = resultFailureMessage(result, `${args.label} ${entry.item.fileName || entry.item.id} 失败`)
        if (failure) failures.push(failure)
        else wroteCount += 1
      } catch (error) {
        args.retryEntries.set(entry.item.id, entry)
        settle([entry], new Set([entry.item.id]))
        failures.push(`${args.label} ${entry.item.fileName || entry.item.id}：${error instanceof Error ? error.message : String(error)}`)
      }
    }
    return { wroteCount, failures }
  }

  retryTagEntries(args.entries, new Set(items.map((entry) => entry.item.id)), args.retryEntries)
  settle(items, new Set(items.map(entry => entry.item.id)))
  failures.push(`${args.label}写入接口不可用。`)
  return { wroteCount: 0, failures }
}

export async function flushQueuedFontWriteQueue(
  options: FlushQueuedFontWriteQueueOptions
): Promise<FlushQueuedFontWriteQueueResult> {
  const { queue, hfm, folders } = options
  const failures: string[] = []
  const retryQueue = createEmptyQueuedFontWriteState()
  let wroteCount = 0

  const localTagResult = await flushTagEntries({
    label: '本地标签',
    scope: 'local',
    entries: queue.localTags,
    retryEntries: retryQueue.localTags,
    batch: typeof hfm.setLocalTagsBatch === 'function'
      ? (items, trace) => hfm.setLocalTagsBatch(items, trace)
      : undefined,
    single: typeof hfm.setLocalTags === 'function'
      ? (item, tagNames, trace) => hfm.setLocalTags(item, tagNames, trace)
      : undefined
  })
  wroteCount += localTagResult.wroteCount
  failures.push(...localTagResult.failures)

  const sharedTagResult = await flushTagEntries({
    label: '共享标签',
    scope: 'shared',
    entries: queue.sharedTags,
    retryEntries: retryQueue.sharedTags,
    batch: typeof hfm.setSharedTagsBatch === 'function'
      ? (items, trace) => hfm.setSharedTagsBatch(items, folders, trace)
      : undefined,
    single: typeof hfm.setSharedTags === 'function'
      ? (item, tagNames, trace) => hfm.setSharedTags([item], folders, tagNames, trace)
      : undefined
  })
  wroteCount += sharedTagResult.wroteCount
  failures.push(...sharedTagResult.failures)

  const favoriteGroups = new Map<boolean, FontItem[]>()
  for (const entry of queue.favorite.values()) {
    const list = favoriteGroups.get(entry.favorite) || []
    list.push(entry.font)
    favoriteGroups.set(entry.favorite, list)
  }
  for (const [favorite, fonts] of favoriteGroups) {
    const label = favorite ? '收藏' : '取消收藏'
    if (typeof hfm.setFavorite !== 'function') {
      retryBooleanEntries(queue.favorite, new Set(fonts.map((font) => font.id)), retryQueue.favorite)
      settleFontWrites(fonts.map(font => queue.favorite.get(font.id)!), new Set(fonts.map(font => font.id)), entry => entry.font.id)
      failures.push(`${label}写入接口不可用。`)
      continue
    }
    try {
      const result = await hfm.setFavorite(fonts, folders, favorite, dispatchFontWrites(fonts.map(font => queue.favorite.get(font.id)!)))
      const failedIds = failedIdsFromResult(result, fonts.map((font) => font.id))
      retryBooleanEntries(queue.favorite, failedIds, retryQueue.favorite)
      settleFontWrites(fonts.map(font => queue.favorite.get(font.id)!), failedIds, entry => entry.font.id)
      for (const font of fonts) if (!failedIds.has(font.id)) settleFavoriteIntent(font)
      wroteCount += fonts.length - failedIds.size
      const failure = resultFailureMessage(result, `${label} ${fonts.length} 个失败`)
      if (failure) failures.push(failure)
    } catch (error) {
      retryBooleanEntries(queue.favorite, new Set(fonts.map((font) => font.id)), retryQueue.favorite)
      settleFontWrites(fonts.map(font => queue.favorite.get(font.id)!), new Set(fonts.map(font => font.id)), entry => entry.font.id)
      failures.push(`${label} ${fonts.length} 个：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const protectionGroups = new Map<boolean, FontItem[]>()
  for (const entry of queue.protection.values()) {
    const list = protectionGroups.get(entry.protect) || []
    list.push(entry.font)
    protectionGroups.set(entry.protect, list)
  }
  for (const [protect, fonts] of protectionGroups) {
    const label = protect ? '加入保护' : '取消保护'
    if (typeof hfm.setDeleteProtection !== 'function') {
      retryBooleanEntries(queue.protection, new Set(fonts.map((font) => font.id)), retryQueue.protection)
      settleFontWrites(fonts.map(font => queue.protection.get(font.id)!), new Set(fonts.map(font => font.id)), entry => entry.font.id)
      failures.push(`${label}写入接口不可用。`)
      continue
    }
    try {
      const result = await hfm.setDeleteProtection(fonts, folders, protect, dispatchFontWrites(fonts.map(font => queue.protection.get(font.id)!)))
      const failedIds = failedIdsFromResult(result, fonts.map((font) => font.id))
      retryBooleanEntries(queue.protection, failedIds, retryQueue.protection)
      settleFontWrites(fonts.map(font => queue.protection.get(font.id)!), failedIds, entry => entry.font.id)
      wroteCount += fonts.length - failedIds.size
      const failure = resultFailureMessage(result, `${label} ${fonts.length} 个失败`)
      if (failure) failures.push(failure)
    } catch (error) {
      retryBooleanEntries(queue.protection, new Set(fonts.map((font) => font.id)), retryQueue.protection)
      settleFontWrites(fonts.map(font => queue.protection.get(font.id)!), new Set(fonts.map(font => font.id)), entry => entry.font.id)
      failures.push(`${label} ${fonts.length} 个：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  return {
    attemptedCount: queuedFontWriteCount(queue),
    wroteCount,
    failures,
    retryQueue
  }
}
