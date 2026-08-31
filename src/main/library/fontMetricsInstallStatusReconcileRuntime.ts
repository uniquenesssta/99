import type { FontMetricsResult } from '../../shared/types'

const MAX_SMALL_SNAPSHOT_DRIFT = 64
const MAX_BLOCKING_RECONCILE_MISSING = 16

function finalizeSmallMissingInstallStatusSnapshot(
  primary: FontMetricsResult,
  source: string,
  missing: number,
  limit: number,
  appendLog: (message: string) => void
): FontMetricsResult {
  const total = numericMetric(primary.total)
  const installedCount = Math.min(numericMetric(primary.installedCount), total)
  appendLog(
    `metrics install status small missing finalized: source=${source}, missing=${missing}, limit=${limit}, installed=${installedCount}, notInstalled=${Math.max(0, total - installedCount)}`
  )
  return {
    ...primary,
    installStatusKnownCount: total,
    installStatusMissingCount: 0,
    installStatusReady: true,
    installedCount,
    notInstalledCount: Math.max(0, total - installedCount),
  }
}

function numericMetric(value: unknown): number {
  const numberValue = Number(value || 0)
  return Number.isFinite(numberValue) ? Math.max(0, numberValue) : 0
}

const DEFAULT_RECONCILE_CACHE_TTL_MS = 15_000

type ReconcileCacheEntry = {
  key: string
  result: FontMetricsResult
  expiresAt: number
}

export type MetricsInstallStatusReconcileCacheRuntime = {
  reconcileWithFallback: (args: {
    primary: FontMetricsResult
    source: string
    appendLog: (message: string) => void
    loadFallback: () => Promise<FontMetricsResult | null>
  }) => Promise<FontMetricsResult>
  clear: () => void
}

function metricsReconcileCacheKey(primary: FontMetricsResult, source: string): string {
  return [
    source,
    numericMetric(primary.total),
    numericMetric(primary.installedCount),
    numericMetric(primary.notInstalledCount),
    numericMetric(primary.installStatusMissingCount),
  ].join('|')
}

export function createMetricsInstallStatusReconcileCacheRuntime(
  ttlMs = DEFAULT_RECONCILE_CACHE_TTL_MS
): MetricsInstallStatusReconcileCacheRuntime {
  let cached: ReconcileCacheEntry | null = null
  let generation = 0
  const inFlight = new Map<string, Promise<FontMetricsResult>>()

  async function reconcileWithFallback(args: {
    primary: FontMetricsResult
    source: string
    appendLog: (message: string) => void
    loadFallback: () => Promise<FontMetricsResult | null>
  }): Promise<FontMetricsResult> {
    const missing = numericMetric(args.primary.installStatusMissingCount)
    if (missing <= 0) return args.primary
    const total = numericMetric(args.primary.total)
    const smallMissingLimit = Math.min(MAX_BLOCKING_RECONCILE_MISSING, Math.max(1, Math.ceil(total * 0.01)))
    if (missing <= smallMissingLimit) {
      return finalizeSmallMissingInstallStatusSnapshot(
        args.primary,
        args.source,
        missing,
        smallMissingLimit,
        args.appendLog,
      )
    }

    const key = metricsReconcileCacheKey(args.primary, args.source)
    const now = Date.now()
    if (cached && cached.key === key && cached.expiresAt > now) {
      args.appendLog(
        `metrics install status reconcile cache hit: source=${args.source}, missing=${missing}, ttlMs=${cached.expiresAt - now}`
      )
      return { ...cached.result }
    }

    const existing = inFlight.get(key)
    if (existing) {
      args.appendLog(`metrics install status reconcile joined in-flight: source=${args.source}, missing=${missing}`)
      return existing
    }

    const taskGeneration = generation
    let task: Promise<FontMetricsResult>
    task = (async () => {
      const fallback = await args.loadFallback()
      if (!fallback) return args.primary
      const reconciled = reconcileMergedMetricsInstallStatusSnapshot(
        args.primary,
        fallback,
        args.source,
        args.appendLog,
      )
      if (
        taskGeneration === generation &&
        reconciled !== args.primary &&
        numericMetric(reconciled.installStatusMissingCount) === 0
      ) {
        cached = { key, result: { ...reconciled }, expiresAt: Date.now() + ttlMs }
      }
      return reconciled
    })().finally(() => {
      if (inFlight.get(key) === task) inFlight.delete(key)
    })

    inFlight.set(key, task)
    return task
  }

  function clear(): void {
    generation += 1
    cached = null
    inFlight.clear()
  }

  return { reconcileWithFallback, clear }
}

export function shouldReconcileInstallStatusSnapshot(
  primary: FontMetricsResult,
  fallback: FontMetricsResult
): boolean {
  const primaryTotal = numericMetric(primary.total)
  const fallbackTotal = numericMetric(fallback.total)
  const primaryMissing = numericMetric(primary.installStatusMissingCount)
  const fallbackMissing = numericMetric(fallback.installStatusMissingCount)
  if (primaryTotal <= 0 || fallbackTotal <= 0) return false
  if (primaryMissing <= 0 || fallbackMissing > 0 || fallback.installStatusReady === false) return false
  if (fallbackTotal > primaryTotal) return false

  const drift = primaryTotal - fallbackTotal
  const allowedDrift = Math.max(MAX_SMALL_SNAPSHOT_DRIFT, Math.ceil(primaryTotal * 0.01))
  return drift <= allowedDrift
}

export function reconcileMergedMetricsInstallStatusSnapshot(
  primary: FontMetricsResult,
  fallback: FontMetricsResult,
  source: string,
  appendLog: (message: string) => void
): FontMetricsResult {
  if (!shouldReconcileInstallStatusSnapshot(primary, fallback)) return primary

  const total = numericMetric(primary.total)
  const installedCount = numericMetric(fallback.installedCount)
  const notInstalledCount = Math.max(0, total - installedCount)
  const primaryMissing = numericMetric(primary.installStatusMissingCount)
  const fallbackTotal = numericMetric(fallback.total)

  appendLog(
    `metrics install status reconciled: source=${source}, mergedTotal=${total}, rootCacheTotal=${fallbackTotal}, mergedMissing=${primaryMissing}, rootCacheMissing=0, installed=${installedCount}, notInstalled=${notInstalledCount}`
  )

  return {
    ...primary,
    installedCount,
    notInstalledCount,
    installStatusKnownCount: total,
    installStatusMissingCount: 0,
    installStatusReady: true
  }
}
