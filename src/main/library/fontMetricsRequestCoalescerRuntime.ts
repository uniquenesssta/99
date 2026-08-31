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
  const inFlightByKey = new Map<string, Promise<FontMetricsResult>>()
  let latestCacheEntry: MetricsCacheEntry | null = null
  let cacheGeneration = 0

  async function run(args: {
    appendLog: (message: string) => void
    load: () => Promise<FontMetricsResult>
    key?: string
  }): Promise<FontMetricsResult> {
    const now = Date.now()
    const key = args.key || 'default'
    const cached = cachedByKey.get(key)
    if (cached && cached.expiresAt > now) {
      return cloneMetricsResult(cached.result)
    }

    if (
      latestCacheEntry &&
      latestCacheEntry.expiresAt > now &&
      canReuseRecentMetricsAcrossKeys(latestCacheEntry.key, key)
    ) {
      args.appendLog(`font metrics request reused recent result: from=${latestCacheEntry.key}, to=${key}`)
      return cloneMetricsResult(latestCacheEntry.result)
    }

    const inFlight = inFlightByKey.get(key)
    if (inFlight) {
      args.appendLog(`font metrics request joined in-flight: key=${key}`)
      return inFlight.then(cloneMetricsResult)
    }

    const requestGeneration = cacheGeneration
    let promise!: Promise<FontMetricsResult>
    promise = args.load().then((result) => {
      if (requestGeneration === cacheGeneration) {
        const entry = { result: cloneMetricsResult(result), expiresAt: Date.now() + ttlMs, key }
        cachedByKey.set(key, entry)
        latestCacheEntry = entry
      }
      return result
    }).finally(() => {
      if (inFlightByKey.get(key) === promise) inFlightByKey.delete(key)
    })
    inFlightByKey.set(key, promise)

    return promise.then(cloneMetricsResult)
  }

  function clear(): void {
    cacheGeneration += 1
    cachedByKey.clear()
    inFlightByKey.clear()
    latestCacheEntry = null
  }

  return { run, clear }
}
