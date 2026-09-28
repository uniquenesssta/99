import type { FontRefreshField } from './databaseDerivedStateRuntime'
import { hasUnsettledFavoriteIntent, isSameFavoriteIntent } from './fontUserIntentRuntime'
import { cancelFontWrite, trackFontWrite } from './fontOperationTrace'
import type { FontItem } from '@shared/types'
import type { HfmApi } from '../../preload'
import type { QueuedFontWriteState } from './appTypes'
import {
  createEmptyQueuedFontWriteState,
  estimateFontWriteBytes,
  flushQueuedFontWriteQueue,
  mergeQueuedFontWritesPreservingNewer,
  queuedFontWriteCount
} from './fontWriteQueue'

type TimerRef = { current: number | null }
type BooleanRef = { current: boolean }
type NumberRef = { current: number }
type PromiseRef = { current: Promise<boolean> | null }
type QueueRef = { current: QueuedFontWriteState }
type WriteField = keyof QueuedFontWriteState
const WRITE_FIELDS: WriteField[] = ['localTags', 'sharedTags', 'favorite', 'protection']
// Runtime factories are recreated by React. Ownership follows the stable queue ref,
// not a render closure; the maps in queueRef remain the only pending-write store.
const activeFieldsByQueue = new WeakMap<QueueRef, Map<WriteField, Promise<boolean>>>()

function takeQueuedField<K extends WriteField>(queueRef: QueueRef, field: K): QueuedFontWriteState {
  const snapshot = createEmptyQueuedFontWriteState()
  const empty = snapshot[field]
  snapshot[field] = queueRef.current[field]
  // Preserve prior snapshots just as the original whole-queue drain did.
  queueRef.current = { ...queueRef.current, [field]: empty }
  return snapshot
}

const FOREGROUND_RETRY_DELAYS_MS = [120, 360, 900]
const BACKGROUND_RETRY_DELAYS_MS = [1800, 4000, 8000]

export interface RendererFontWriteQueueRuntimeOptions {
  queueRef: QueueRef
  timerRef: TimerRef
  retryTimerRef: TimerRef
  retryAttemptRef: NumberRef
  activeRef: BooleanRef
  activePromiseRef: PromiseRef
  hfm: HfmApi
  getFolders: () => string[]
  writeBehindDelayMs: number
  writeBehindMaxItems: number
  writeBehindMaxBufferBytes: number
  memoryPressure: () => 'normal' | 'soft' | 'hard'
  setTimeout: Window['setTimeout']
  clearTimeout: Window['clearTimeout']
  setStatus: (status: string) => void
  scheduleDatabaseDerivedStateRefresh: (delay?: number, fields?: FontRefreshField[]) => void
}

export interface RendererFontWriteQueueRuntime {
  clearTimer: () => void
  scheduleFlush: (reason?: 'delay' | 'threshold' | 'memory') => void
  queueLocalTagsWrite: (item: FontItem, tagNames: string[]) => void
  queueSharedTagsWrite: (item: FontItem, tagNames: string[]) => void
  queueFavoriteWrite: (font: FontItem, favorite: boolean) => void
  queueFavoriteWrites: (fonts: FontItem[], favorite: boolean) => Promise<void>
  queueProtectionWrite: (font: FontItem, protect: boolean) => void
  flush: (reason?: string, scope?: 'local' | 'shared') => Promise<boolean>
}

function waitForRetry(options: RendererFontWriteQueueRuntimeOptions, delayMs: number): Promise<void> {
  return new Promise((resolve) => options.setTimeout(resolve, delayMs))
}

export function createRendererFontWriteQueueRuntime(
  options: RendererFontWriteQueueRuntimeOptions
): RendererFontWriteQueueRuntime {
  let activeFields = activeFieldsByQueue.get(options.queueRef)
  if (!activeFields) {
    activeFields = new Map()
    activeFieldsByQueue.set(options.queueRef, activeFields)
  }
  const fieldTasks = activeFields
  const clearWriteTimer = (): void => {
    if (options.timerRef.current === null) return
    options.clearTimeout(options.timerRef.current)
    options.timerRef.current = null
  }

  const clearRetryTimer = (): void => {
    if (options.retryTimerRef.current === null) return
    options.clearTimeout(options.retryTimerRef.current)
    options.retryTimerRef.current = null
  }

  const clearTimer = (): void => {
    clearWriteTimer()
    clearRetryTimer()
  }

  const scheduleBackgroundRetry = (): void => {
    if (!queuedFontWriteCount(options.queueRef.current) || options.retryTimerRef.current !== null) return
    const attempt = Math.min(options.retryAttemptRef.current, BACKGROUND_RETRY_DELAYS_MS.length - 1)
    const delayMs = BACKGROUND_RETRY_DELAYS_MS[attempt]
    options.retryAttemptRef.current += 1
    options.retryTimerRef.current = options.setTimeout(() => {
      options.retryTimerRef.current = null
      void flush('background-retry')
    }, delayMs)
  }

  const flushField = async (field: WriteField, reason: string, refresh: RendererFontWriteQueueRuntimeOptions['scheduleDatabaseDerivedStateRefresh'] = options.scheduleDatabaseDerivedStateRefresh): Promise<boolean> => {
    const active = fieldTasks.get(field)
    if (active) {
      if (!await active) return false
      return options.queueRef.current[field].size ? flushField(field, reason, refresh) : true
    }

    const task = (async (): Promise<boolean> => {
      let foregroundRetryIndex = 0
      let totalWroteCount = 0

      while (options.queueRef.current[field].size) {
        const folders = options.getFolders()
        const queue = takeQueuedField(options.queueRef, field)

        const result = await flushQueuedFontWriteQueue({
          queue,
          hfm: options.hfm,
          folders
        })
        totalWroteCount += result.wroteCount

        if (result.wroteCount) {
          const includesTagWrites = queue.localTags.size > 0 || queue.sharedTags.size > 0
          const fields: FontRefreshField[] = []
          if (queue.favorite.size) fields.push('favorite')
          if (queue.localTags.size) fields.push('localTags')
          if (queue.sharedTags.size) fields.push('sharedTags')
          if (queue.protection.size) fields.push('protection')
          refresh(queue.favorite.size > 0 ? 0 : includesTagWrites ? 80 : reason === 'memory' ? 120 : 520, fields)
        }

        const retryCount = queuedFontWriteCount(result.retryQueue)
        if (retryCount) {
          mergeQueuedFontWritesPreservingNewer(options.queueRef.current, result.retryQueue)
          if (foregroundRetryIndex < FOREGROUND_RETRY_DELAYS_MS.length) {
            const retryDelay = FOREGROUND_RETRY_DELAYS_MS[foregroundRetryIndex]
            foregroundRetryIndex += 1
            await waitForRetry(options, retryDelay)
            continue
          }

          options.setStatus(`后台写入仍有 ${retryCount} 项未保存：${result.failures.slice(0, 2).join('；')}${result.failures.length > 2 ? '……' : ''}；将继续重试。`)
          scheduleBackgroundRetry()
          return false
        }

        foregroundRetryIndex = 0
        options.retryAttemptRef.current = 0
      }

      if (totalWroteCount > 0 && (totalWroteCount >= 20 || reason !== 'delay')) {
        options.setStatus(`后台写入队列已落库：${totalWroteCount} 项。`)
      }
      return true
    })().catch((error) => {
      options.setStatus(`后台写入队列异常：${error instanceof Error ? error.message : String(error)}；将继续重试。`)
      scheduleBackgroundRetry()
      return false
    }).finally(() => {
      if (fieldTasks.get(field) === task) fieldTasks.delete(field)
    })

    fieldTasks.set(field, task)
    return task
  }

  const flush = async (reason: string = 'manual', scope?: 'local' | 'shared'): Promise<boolean> => {
    // A catalog operation waits only for writes that could recreate its tags.
    // Do not join a global drain stalled on an unrelated shared database.
    if (scope) return flushField(scope === 'shared' ? 'sharedTags' : 'localTags', reason)
    if (options.activeRef.current) {
      const activeSaved = options.activePromiseRef.current ? await options.activePromiseRef.current : true
      if (!activeSaved) return false
      return queuedFontWriteCount(options.queueRef.current) || fieldTasks.size ? flush(reason) : true
    }
    clearTimer()
    options.activeRef.current = true
    const task = (async (): Promise<boolean> => {
      do {
        let saved = true
        let refreshDelay = Infinity
        const changedFields = new Set<FontRefreshField>()
        const collectRefresh: RendererFontWriteQueueRuntimeOptions['scheduleDatabaseDerivedStateRefresh'] = (delay = 0, fields = []) => {
          refreshDelay = Math.min(refreshDelay, delay)
          for (const field of fields) changedFields.add(field)
        }
        // Full drains (including window close) still join every field, even
        // when an in-flight snapshot has already left the pending maps.
        for (const field of WRITE_FIELDS) if (!await flushField(field, reason, collectRefresh)) saved = false
        // Preserve one merged refresh for a full pass; scoped foreground drains
        // retain their own refresh and do not wait for unrelated fields.
        if (changedFields.size) options.scheduleDatabaseDerivedStateRefresh(refreshDelay, (['favorite', 'localTags', 'sharedTags', 'protection'] as FontRefreshField[]).filter(field => changedFields.has(field)))
        if (!saved) return false
      } while (queuedFontWriteCount(options.queueRef.current) || fieldTasks.size)
      return true
    })().finally(() => {
      options.activeRef.current = false
      if (options.activePromiseRef.current === task) options.activePromiseRef.current = null
    })
    options.activePromiseRef.current = task
    return task
  }

  const scheduleFlush = (reason: 'delay' | 'threshold' | 'memory' = 'delay'): void => {
    const queue = options.queueRef.current
    const queuedCount = queuedFontWriteCount(queue)
    if (!queuedCount) return

    const queuedBytes = estimateFontWriteBytes(queue)
    const memory = options.memoryPressure()
    const shouldFlushNow =
      reason !== 'delay' ||
      queuedCount >= options.writeBehindMaxItems ||
      queuedBytes >= options.writeBehindMaxBufferBytes ||
      memory !== 'normal'

    if (shouldFlushNow) {
      clearTimer()
      options.setTimeout(() => void flush(reason), 0)
      return
    }

    if (options.timerRef.current !== null || options.retryTimerRef.current !== null) return
    options.timerRef.current = options.setTimeout(() => {
      options.timerRef.current = null
      void flush('delay')
    }, options.writeBehindDelayMs)
  }

  return {
    clearTimer,
    scheduleFlush,
    queueLocalTagsWrite: (item, tagNames) => {
      options.queueRef.current.localTags.set(item.id, trackFontWrite({ item: { ...item, localTagNames: tagNames }, tagNames }, 'localTags', options.queueRef.current.localTags.get(item.id)))
      void flush('local-tags-immediate', 'local')
    },
    queueSharedTagsWrite: (item, tagNames) => {
      options.queueRef.current.sharedTags.set(item.id, trackFontWrite({ item: { ...item, tagNames }, tagNames }, 'sharedTags', options.queueRef.current.sharedTags.get(item.id)))
      void flush('shared-tags-immediate', 'shared')
    },
    queueFavoriteWrites: async (fonts, favorite) => {
      for (const font of fonts) options.queueRef.current.favorite.set(font.id, trackFontWrite({ font: { ...font, favorite }, favorite }, 'favorite', options.queueRef.current.favorite.get(font.id)))
      await flush('favorite-batch')
      // A rejected batch is explicitly rolled back by its action owner. Never
      // leave its retry queued to silently reapply it later, or cancel a newer one.
      for (const font of fonts) {
        const queued = options.queueRef.current.favorite.get(font.id)
        if (hasUnsettledFavoriteIntent(font) && queued && isSameFavoriteIntent(queued.font, font)) {
          options.queueRef.current.favorite.delete(font.id)
          cancelFontWrite(queued, 'favorite-batch-rollback')
        }
      }
      if (!queuedFontWriteCount(options.queueRef.current)) clearRetryTimer()
    },
    queueFavoriteWrite: (font, favorite) => {
      options.queueRef.current.favorite.set(font.id, trackFontWrite({ font: { ...font, favorite }, favorite }, 'favorite', options.queueRef.current.favorite.get(font.id)))
      void flush('favorite-immediate')
    },
    queueProtectionWrite: (font, protect) => {
      options.queueRef.current.protection.set(font.id, trackFontWrite({ font: { ...font, deleteProtected: protect }, protect }, 'protection', options.queueRef.current.protection.get(font.id)))
      scheduleFlush()
    },
    flush
  }
}
