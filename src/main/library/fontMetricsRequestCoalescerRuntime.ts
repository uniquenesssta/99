import { createFontQueryTask, joinFontQueryTask, assertFontQueryActive, type FontQueryTask } from './fontQueryTaskRuntime'
import type { FontMetricsResult } from '../../shared/types'

const DEFAULT_METRICS_RESULT_TTL_MS = 2_500

export type FontMetricsRequestCoalescerRuntime = {
  run: (args: {
    appendLog: (message: string) => void
    load: () => Promise<FontMetricsResult>
    key?: string
  }) => Promise<FontMetricsResult>
  clear: () => void
}

type MetricsCacheEntry = {
  result: FontMetricsResult
  expiresAt: number
  key: string
}

function cloneMetricsResult(result: FontMetricsResult): FontMetricsResult {
  return { ...result }
}

function isDefaultMetricsKey(key: string): boolean {
  return key === 'metrics:default' || key === 'default'
}

function canReuseRecentMetricsAcrossKeys(previousKey: string, nextKey: string): boolean {
  return previousKey === nextKey || isDefaultMetricsKey(previousKey) || isDefaultMetricsKey(nextKey)
}

export function createFontMetricsRequestCoalescerRuntime(
  ttlMs = DEFAULT_METRICS_RESULT_TTL_MS,
): FontMetricsRequestCoalescerRuntime {
  const cachedByKey = new Map<string, MetricsCacheEntry>()
  const inFlightByKey = new Map<string, FontQueryTask<FontMetricsResult>>()
  let latestCacheEntry: MetricsCacheEntry | null = null
  let cacheGeneration = 0
  let nextRequestId = 0

  async function run(args: {
    appendLog: (message: string) => void
    load: () => Promise<FontMetricsResult>
    key?: string
  }): Promise<FontMetricsResult> {
    assertFontQueryActive()
    const now = Date.now()
    const requestId = ++nextRequestId
    // Diagnostics must not turn a successful cache/read into a failed request.
    const trace = (stage: string, details = ''): void => {
      try { args.appendLog(`font metrics timing: request=${requestId}, generation=${cacheGeneration}, stage=${stage}, elapsed=${Date.now() - now}ms${details ? `, ${details}` : ''}`) } catch { /* best effort */ }
    }
    const key = args.key || 'default'
    const cached = cachedByKey.get(key)
    if (cached && cached.expiresAt > now) {
      trace('cache-hit')
      return cloneMetricsResult(cached.result)
    }

    if (
      latestCacheEntry &&
      latestCacheEntry.expiresAt > now &&
      canReuseRecentMetricsAcrossKeys(latestCacheEntry.key, key)
    ) {
      args.appendLog(`font metrics request reused recent result: from=${latestCacheEntry.key}, to=${key}`)
      trace('recent-hit')
      return cloneMetricsResult(latestCacheEntry.result)
    }

    const joinedGeneration = cacheGeneration
    const physicalKey = `${cacheGeneration}:${key}`
    const inFlight = inFlightByKey.get(physicalKey)
    if (inFlight) {
      args.appendLog(`font metrics request joined in-flight: key=${key}`)
      try { const result = await joinFontQueryTask(inFlight); assertFontQueryActive(); if (joinedGeneration !== cacheGeneration) return run(args); trace('joined'); return cloneMetricsResult(result) }
      catch (error) { assertFontQueryActive(); if (inFlight.controller.signal.aborted) return run(args); throw error }
    }

    const requestGeneration = cacheGeneration
    trace('load-start')
    const task = createFontQueryTask(args.load)
    inFlightByKey.set(physicalKey, task)
    void task.pending.finally(() => {
      if (inFlightByKey.get(physicalKey) === task) inFlightByKey.delete(physicalKey)
    }).catch(() => undefined)
    try {
      const result = await joinFontQueryTask(task)
      assertFontQueryActive()
      if (requestGeneration !== cacheGeneration) return run(args)
      if (requestGeneration === cacheGeneration) {
        const entry = { result: cloneMetricsResult(result), expiresAt: Date.now() + ttlMs, key }
        cachedByKey.set(key, entry); latestCacheEntry = entry
      }
      trace('load-end')
      return cloneMetricsResult(result)
    } catch (error) {
      assertFontQueryActive()
      if (requestGeneration !== cacheGeneration) return run(args)
      trace('load-error'); throw error
    }
  }

  function clear(): void {
    cacheGeneration += 1
    cachedByKey.clear()
    for (const task of inFlightByKey.values()) task.controller.abort()
    latestCacheEntry = null
  }

  return { run, clear }
}
