import { isApplicationClosing, onApplicationClosing } from '../../app/shutdownCoordinatorRuntime'
import { withPhysicalIoCompletion } from '../../path/ioDeadlineRuntime'
import type { PreviewCacheHydrationRow } from './previewCacheHydrationRuntime'
import type { PreviewCacheStorage } from './previewRuntimeTypes'
import { createPreviewTaskGenerationRuntime } from './previewTaskGenerationRuntime'

export type PreviewCachePrefetchRuntimeOptions = {
  appendStartupLog: (message: string) => void
  hydratePreviewCacheRows: (storage: PreviewCacheStorage, rows: PreviewCacheHydrationRow[], current?: () => boolean) => Promise<Set<string>>
}

const DEFAULT_PREFETCH_ENABLED = true
const DEFAULT_PREFETCH_BATCH_SIZE = 100
const DEFAULT_PREFETCH_MAX_IN_FLIGHT = 1
const DEFAULT_PREFETCH_IDLE_DELAY_MS = 5000
const DEFAULT_PREFETCH_QUEUE_LIMIT = 2000
const DEFAULT_STATS_LOG_INTERVAL_MS = 10000

function parseEnvInt(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const parsed = Number(raw)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.min(max, Math.floor(parsed)))
}

function envEnabled(name: string, fallback: boolean): boolean {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  return raw !== '0' && raw.toLowerCase() !== 'false' && raw.toLowerCase() !== 'off'
}

function prefetchEnabled(): boolean {
  return envEnabled('HFM_PREVIEW_BACKGROUND_PREFETCH', DEFAULT_PREFETCH_ENABLED)
}

function prefetchBatchSize(): number {
  return parseEnvInt('HFM_PREVIEW_PREFETCH_BATCH_SIZE', DEFAULT_PREFETCH_BATCH_SIZE, 20, 500)
}

function prefetchMaxInFlight(): number {
  return parseEnvInt('HFM_PREVIEW_PREFETCH_MAX_IN_FLIGHT', DEFAULT_PREFETCH_MAX_IN_FLIGHT, 1, 4)
}

function prefetchIdleDelayMs(): number {
  return parseEnvInt('HFM_PREVIEW_PREFETCH_IDLE_DELAY_MS', DEFAULT_PREFETCH_IDLE_DELAY_MS, 500, 60000)
}

function prefetchQueueLimit(): number {
  return parseEnvInt('HFM_PREVIEW_PREFETCH_QUEUE_LIMIT', DEFAULT_PREFETCH_QUEUE_LIMIT, 100, 20000)
}

function storageKey(storage: PreviewCacheStorage): string {
  return storage.shared?.rootPath || storage.rootPath || storage.indexDbPath || storage.dir
}

function taskKey(storage: PreviewCacheStorage, row: PreviewCacheHydrationRow): string {
  return `${storageKey(storage)}:${row.previewKey}`
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function createPreviewCachePrefetchRuntime(options: PreviewCachePrefetchRuntimeOptions) {
  const queue = new Map<string, { storage: PreviewCacheStorage; row: PreviewCacheHydrationRow; generation: number }>()
  const generationRuntime = createPreviewTaskGenerationRuntime({
    appendStartupLog: options.appendStartupLog,
    label: 'preview cache prefetch',
  })
  let timer: ReturnType<typeof setTimeout> | null = null
  let active = 0
  let lastStatsLogAt = 0
  const stats = {
    queued: 0,
    dropped: 0,
    cancelled: 0,
    hydrated: 0,
    failed: 0,
  }

  function logStats(force = false): void {
    const now = Date.now()
    if (!force && now - lastStatsLogAt < DEFAULT_STATS_LOG_INTERVAL_MS) return
    const total = stats.queued + stats.dropped + stats.cancelled + stats.hydrated + stats.failed
    if (!total) return
    lastStatsLogAt = now
    options.appendStartupLog(`preview cache prefetch summary: queued=${stats.queued}, hydrated=${stats.hydrated}, failed=${stats.failed}, dropped=${stats.dropped}, cancelled=${stats.cancelled}`)
    stats.queued = 0
    stats.dropped = 0
    stats.hydrated = 0
    stats.failed = 0
    stats.cancelled = 0
  }

  function trimQueue(): void {
    const limit = prefetchQueueLimit()
    while (queue.size > limit) {
      const firstKey = queue.keys().next().value as string | undefined
      if (!firstKey) break
      queue.delete(firstKey)
      stats.dropped += 1
    }
  }

  function schedulePump(immediate = false): void {
    if (isApplicationClosing() || !prefetchEnabled()) return
    if (timer && !immediate) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      pump()
    }, immediate ? 0 : prefetchIdleDelayMs())
  }

  function nextBatch(): { generation: number; storage: PreviewCacheStorage; rows: PreviewCacheHydrationRow[] } | null {
    while (queue.size) {
      const first = queue.entries().next().value as [string, { storage: PreviewCacheStorage; row: PreviewCacheHydrationRow; generation: number }] | undefined
      if (!first) return null
      const [firstKey, firstTask] = first
      if (!generationRuntime.isCurrentGeneration(firstTask.generation)) {
        queue.delete(firstKey)
        stats.cancelled += 1
        continue
      }

      const firstStorageKey = storageKey(firstTask.storage)
      const firstGeneration = firstTask.generation
      const rows: PreviewCacheHydrationRow[] = []
      let storage = firstTask.storage
      for (const [key, task] of queue) {
        if (!generationRuntime.isCurrentGeneration(task.generation)) {
          queue.delete(key)
          stats.cancelled += 1
          continue
        }
        if (storageKey(task.storage) !== firstStorageKey || task.generation !== firstGeneration) continue
        queue.delete(key)
        storage = task.storage
        rows.push(task.row)
        if (rows.length >= prefetchBatchSize()) break
      }
      if (rows.length) return { storage, rows, generation: firstGeneration }
    }
    return null
  }

  function pump(): void {
    if (isApplicationClosing() || !prefetchEnabled()) {
      stats.cancelled += queue.size
      queue.clear()
      return
    }

    while (active < prefetchMaxInFlight() && queue.size) {
      const batch = nextBatch()
      if (!batch) break
      active += 1
      withPhysicalIoCompletion(() => options.hydratePreviewCacheRows(batch.storage, batch.rows, () => !isApplicationClosing() && generationRuntime.isCurrentGeneration(batch.generation)))
        .then((hydratedIds) => {
          stats.hydrated += hydratedIds.size
          stats.failed += Math.max(0, batch.rows.length - hydratedIds.size)
        })
        .catch((error) => {
          stats.failed += batch.rows.length
          options.appendStartupLog(`preview cache prefetch failed: ${errorMessage(error)}`)
        })
        .finally(() => {
          active = Math.max(0, active - 1)
          logStats()
          if (queue.size) schedulePump()
        })
    }
  }

  function schedulePreviewCachePrefetch(storage: PreviewCacheStorage, rows: PreviewCacheHydrationRow[], immediate = false): void {
    if (isApplicationClosing() || !prefetchEnabled() || !storage.shared || !rows.length) return
    for (const row of rows) {
      if (!row?.id || !row.previewKey || !row.outputPath) continue
      queue.set(taskKey(storage, row), { storage, row, generation: generationRuntime.currentGeneration() })
      stats.queued += 1
    }
    trimQueue()
    schedulePump(immediate)
    logStats()
  }

  function beginPreviewCachePrefetchGeneration(reason?: string): number {
    stats.cancelled += queue.size
    queue.clear()
    return generationRuntime.beginGeneration(reason)
  }

  onApplicationClosing(() => {
    if (timer) clearTimeout(timer)
    timer = null
    beginPreviewCachePrefetchGeneration('closing')
  })
  return {
    schedulePreviewCachePrefetch,
    beginPreviewCachePrefetchGeneration,
    logStats,
  }
}
