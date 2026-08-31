import type { FontMetricsResult } from '../../shared/types'
import { normalizePathForCacheCompare } from '../path/cachePath'

function numericCount(value: unknown): number {
  const numberValue = Number(value || 0)
  return Number.isFinite(numberValue) ? Math.max(0, numberValue) : 0
}

function folderCountByNormalizedKey(metrics: FontMetricsResult): Map<string, number> {
  const counts = new Map<string, number>()
  for (const [key, value] of Object.entries(metrics.folderCounts || {})) {
    const normalized = normalizePathForCacheCompare(key)
    if (!normalized) continue
    counts.set(normalized, Math.max(counts.get(normalized) || 0, numericCount(value)))
  }
  return counts
}

function normalizedWatchedRoots(roots: string[]): string[] {
  return Array.from(new Set((roots || []).map(normalizePathForCacheCompare).filter(Boolean)))
}

export function watchedRootFolderCountTotal(metrics: FontMetricsResult, roots: string[]): number {
  const counts = folderCountByNormalizedKey(metrics)
  return normalizedWatchedRoots(roots).reduce((total, root) => total + numericCount(counts.get(root)), 0)
}

export function shouldReconcileFolderCounts(metrics: FontMetricsResult, roots: string[]): boolean {
  const total = numericCount(metrics.total)
  if (total <= 0 || !roots.length) return false
  const normalizedRoots = normalizedWatchedRoots(roots)
  const counts = folderCountByNormalizedKey(metrics)
  if (normalizedRoots.some((root) => !counts.has(root))) return true

  const rootTotal = normalizedRoots.reduce((sum, root) => sum + numericCount(counts.get(root)), 0)
  if (rootTotal <= 0) return true

  // A single watched root must account for the full merged-index population.
  // With overlapping watched roots, summing root counts can legitimately exceed
  // total because the same font belongs to both a parent and child root.
  return normalizedRoots.length === 1 && rootTotal !== total
}

export async function reconcileMetricsFolderCounts(args: {
  primary: FontMetricsResult
  roots: string[]
  source: string
  appendLog: (message: string) => void
  loadFallback: () => Promise<FontMetricsResult | null>
}): Promise<FontMetricsResult> {
  if (!shouldReconcileFolderCounts(args.primary, args.roots)) return args.primary

  const primaryRootTotal = watchedRootFolderCountTotal(args.primary, args.roots)
  const fallback = await args.loadFallback()
  if (!fallback || shouldReconcileFolderCounts(fallback, args.roots)) {
    args.appendLog(
      `metrics folder count reconcile unavailable: source=${args.source}, total=${numericCount(args.primary.total)}, rootTotal=${primaryRootTotal}, roots=${args.roots.length}`
    )
    return args.primary
  }

  const fallbackRootTotal = watchedRootFolderCountTotal(fallback, args.roots)
  args.appendLog(
    `metrics folder counts reconciled: source=${args.source}, total=${numericCount(args.primary.total)}, primaryRootTotal=${primaryRootTotal}, fallbackRootTotal=${fallbackRootTotal}, keys=${Object.keys(fallback.folderCounts || {}).length}`
  )
  return {
    ...args.primary,
    folderCounts: { ...(fallback.folderCounts || {}) },
  }
}
