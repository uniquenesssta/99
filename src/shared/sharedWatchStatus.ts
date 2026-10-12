export type SharedWatchPhase = 'idle' | 'checking' | 'applying' | 'offline' | 'error' | 'stopped'

export interface SharedWatchRootStatus {
  rootPath: string
  phase: SharedWatchPhase
  /** Last complete reconciliation ACK, including index/projection application. */
  lastCheckedAt: number | null
  /** Validated discovered work still owned by this pass; null means not yet known. */
  pendingCount: number | null
}

export interface SharedWatchStatus {
  roots: SharedWatchRootStatus[]
}

export function isSharedWatchStatus(value: unknown): value is SharedWatchStatus {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const roots = (value as Partial<SharedWatchStatus>).roots
  return Array.isArray(roots) && roots.every(root =>
    root && typeof root.rootPath === 'string' && root.rootPath.length > 0 &&
    ['idle', 'checking', 'applying', 'offline', 'error', 'stopped'].includes(root.phase) &&
    (root.lastCheckedAt === null || (Number.isSafeInteger(root.lastCheckedAt) && root.lastCheckedAt >= 0 && root.lastCheckedAt <= 8640000000000000)) &&
    (root.pendingCount === null || (Number.isSafeInteger(root.pendingCount) && root.pendingCount >= 0)))
}
