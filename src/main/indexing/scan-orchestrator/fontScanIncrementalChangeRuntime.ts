import type { FontIndexChangePayload,FontItem } from '../../../shared/types'

export interface FontScanIncrementalChangeRuntime {
  enqueueUpsert: (rootPath: string, font: FontItem) => void
  flush: (force?: boolean) => void
  emittedCount: () => number
  dispose: () => void
}

function normalizeBatchSizes(batchSizes: number[] | undefined, fallbackBatchSize: number): number[] {
  const normalized = (batchSizes || [])
    .map((value) => Math.floor(Number(value)))
    .filter((value) => Number.isFinite(value) && value > 0)
  if (normalized.length) return normalized
  return [10, 50, 100, fallbackBatchSize]
}

export function createFontScanIncrementalChangeRuntime(options: {
  jobId: string
  batchSize?: number
  batchSizes?: number[]
  minIntervalMs?: number
  signal?: AbortSignal
  sendFontIndexChanged?: (payload: FontIndexChangePayload) => void
  appendStartupLog: (message: string) => void
}): FontScanIncrementalChangeRuntime {
  const sendFontIndexChanged = options.sendFontIndexChanged
  const sustainedBatchSize = Math.max(50, options.batchSize || 200)
  const batchSizes = normalizeBatchSizes(options.batchSizes, sustainedBatchSize)
  const minIntervalMs = Math.max(100, options.minIntervalMs || 350)
  const pendingByRoot = new Map<string, FontItem[]>()
  let lastFlushAt = 0
  let totalEmitted = 0
  let totalPending = 0
  let flushCount = 0
  let disposed = false
  let flushTimer: ReturnType<typeof setTimeout> | undefined

  function nextFlushThreshold(): number {
    return batchSizes[Math.min(flushCount, batchSizes.length - 1)] || sustainedBatchSize
  }

  function clearScheduledFlush(): void {
    if (!flushTimer) return
    clearTimeout(flushTimer)
    flushTimer = undefined
  }

  function dispose(): void {
    if (disposed) return
    disposed = true
    clearScheduledFlush()
    pendingByRoot.clear()
    totalPending = 0
    options.signal?.removeEventListener('abort', dispose)
  }

  function isUnavailable(): boolean {
    if (disposed) return true
    if (!options.signal?.aborted) return false
    dispose()
    return true
  }

  function scheduleFlush(delayMs: number): void {
    if (flushTimer || !sendFontIndexChanged || isUnavailable()) return
    flushTimer = setTimeout(() => {
      flushTimer = undefined
      flush(false)
    }, Math.max(0, delayMs))
    flushTimer.unref?.()
  }

  function flushRoot(rootPath: string, maxItems: number): number {
    if (isUnavailable()) return 0
    const batch = pendingByRoot.get(rootPath)
    if (!batch?.length || !sendFontIndexChanged || maxItems <= 0) return 0
    const upserts = batch.splice(0, maxItems)
    if (batch.length) pendingByRoot.set(rootPath, batch)
    else pendingByRoot.delete(rootPath)
    totalEmitted += upserts.length
    totalPending = Math.max(0, totalPending - upserts.length)
    sendFontIndexChanged({
      folder: rootPath,
      at: new Date().toISOString(),
      upserts,
      deletes: [],
      source: 'scan-stream',
      jobId: options.jobId,
    })
    return upserts.length
  }

  function flushBatch(maxItems: number): number {
    let remaining = maxItems
    let flushed = 0
    for (const rootPath of Array.from(pendingByRoot.keys())) {
      if (remaining <= 0) break
      const count = flushRoot(rootPath, remaining)
      flushed += count
      remaining -= count
    }
    return flushed
  }

  function flush(force = false): void {
    if (!sendFontIndexChanged || totalPending <= 0 || isUnavailable()) return
    if (force) {
      clearScheduledFlush()
      const flushed = flushBatch(totalPending)
      if (flushed > 0) {
        lastFlushAt = Date.now()
        flushCount += 1
      }
      return
    }

    const threshold = nextFlushThreshold()
    if (totalPending < threshold) return

    const now = Date.now()
    const elapsed = lastFlushAt > 0 ? now - lastFlushAt : minIntervalMs
    if (elapsed < minIntervalMs) {
      scheduleFlush(minIntervalMs - elapsed)
      return
    }

    const flushed = flushBatch(threshold)
    if (flushed > 0) {
      lastFlushAt = Date.now()
      flushCount += 1
    }

    if (totalPending >= nextFlushThreshold()) {
      scheduleFlush(minIntervalMs)
    }
  }

  function enqueueUpsert(rootPath: string, font: FontItem): void {
    if (!sendFontIndexChanged || isUnavailable()) return
    const batch = pendingByRoot.get(rootPath) || []
    batch.push(font)
    pendingByRoot.set(rootPath, batch)
    totalPending += 1
    if (totalPending >= nextFlushThreshold()) flush(false)
  }

  options.signal?.addEventListener('abort', dispose, { once: true })

  return {
    enqueueUpsert,
    flush,
    emittedCount: () => totalEmitted,
    dispose,
  }
}
