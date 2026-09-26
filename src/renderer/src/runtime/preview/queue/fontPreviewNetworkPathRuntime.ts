import type { FontItem } from '@shared/types'
import { pathRoots } from '@shared/sharedAvailability'
import { readPreviewAvailability } from '../previewAvailabilitySnapshotRuntime'

// Scheduling only. The main process remains the authorization and I/O owner.
export function isLikelyNetworkFontPath(filePath?: string): boolean {
  const snapshot = readPreviewAvailability()
  if (!snapshot || !filePath) return true
  const roots = pathRoots(snapshot, filePath)
  // Only an explicit local classification permits local concurrency. Missing,
  // stale/offline, mapped and UNC identities all keep the conservative limit.
  return !roots.length || roots.some(root => root.state !== 'online' || !root.resourceKeys || root.resourceKeys.length > 0)
}

export function hasNetworkFontPath(fonts: FontItem[]): boolean {
  return (fonts || []).some((font) => isLikelyNetworkFontPath(font?.path))
}

export function networkAwarePreviewLimit(fonts: FontItem[], defaultLimit: number, networkLimit = 1): number {
  if (!hasNetworkFontPath(fonts)) return defaultLimit
  return Math.max(1, Math.min(defaultLimit, networkLimit))
}
