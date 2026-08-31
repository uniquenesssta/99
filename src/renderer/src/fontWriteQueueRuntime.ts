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
  scheduleDatabaseDerivedStateRefresh: (delay?: number) => void
}

export interface RendererFontWriteQueueRuntime {
  clearTimer: () => void
  scheduleFlush: (reason?: 'delay' | 'threshold' | 'memory') => void
  queueLocalTagsWrite: (item: FontItem, tagNames: string[]) => void
  queueSharedTagsWrite: (item: FontItem, tagNames: string[]) => void
  queueFavoriteWrite: (font: FontItem, favorite: boolean) => void
  queueProtectionWrite: (font: FontItem, protect: boolean) => void
  flush: (reason?: string) => Promise<boolean>
}

function waitForRetry(options: RendererFontWriteQueueRuntimeOptions, delayMs: number): Promise<void> {
  return new Promise((resolve) => options.setTimeout(resolve, delayMs))
}

export function createRendererFontWriteQueueRuntime(
  options: RendererFontWriteQueueRuntimeOptions
): RendererFontWriteQueueRuntime {
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

  const flush = async (reason: string = 'manual'): Promise<boolean> => {
    if (options.activeRef.current) {
      const activePromise = options.activePromiseRef.current
      const activeSaved = activePromise ? await activePromise : true
      if (!activeSaved) return false
      return queuedFontWriteCount(options.queueRef.current) ? flush(reason) : true
    }

    clearTimer()
    options.activeRef.current = true

    const task = (async (): Promise<boolean> => {
      let foregroundRetryIndex = 0
      let totalWroteCount = 0

      while (queuedFontWriteCount(options.queueRef.current)) {
        const queue = options.queueRef.current
        options.queueRef.current = createEmptyQueuedFontWriteState()

        const result = await flushQueuedFontWriteQueue({
          queue,
          hfm: options.hfm,
          folders: options.getFolders()
        })
        totalWroteCount += result.wroteCount

        if (result.wroteCount) {
          const includesTagWrites = queue.localTags.size > 0 || queue.sharedTags.size > 0
          options.scheduleDatabaseDerivedStateRefresh(includesTagWrites ? 80 : reason === 'memory' ? 120 : 520)
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

      if (totalWroteCount >= 20 || reason !== 'delay') {
        options.setStatus(`后台写入队列已落库：${totalWroteCount} 项。`)
      }
      return true
    })().catch((error) => {
      options.setStatus(`后台写入队列异常：${error instanceof Error ? error.message : String(error)}；将继续重试。`)
      scheduleBackgroundRetry()
      return false
    }).finally(() => {
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
      options.queueRef.current.localTags.set(item.id, { item: { ...item, localTagNames: tagNames }, tagNames })
      void flush('local-tags-immediate')
    },
    queueSharedTagsWrite: (item, tagNames) => {
      options.queueRef.current.sharedTags.set(item.id, { item: { ...item, tagNames }, tagNames })
      void flush('shared-tags-immediate')
    },
    queueFavoriteWrite: (font, favorite) => {
      options.queueRef.current.favorite.set(font.id, { font: { ...font, favorite }, favorite })
      scheduleFlush()
    },
    queueProtectionWrite: (font, protect) => {
      options.queueRef.current.protection.set(font.id, { font: { ...font, deleteProtected: protect }, protect })
      scheduleFlush()
    },
    flush
  }
}
