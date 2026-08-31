export type CachedPreviewMissCache = {
  hasFreshMiss: (key: string) => boolean
  rememberMiss: (key: string) => void
  rememberMisses: (keys: string[]) => void
  forget: (key: string) => void
}

const DEFAULT_TTL_MS = 4_000
const DEFAULT_LIMIT = 2_000

export function createCachedPreviewMissCacheRuntime(
  ttlMs = DEFAULT_TTL_MS,
  limit = DEFAULT_LIMIT,
): CachedPreviewMissCache {
  const misses = new Map<string, number>()

  function prune(now = Date.now()): void {
    for (const [key, expiresAt] of misses) {
      if (expiresAt <= now || misses.size <= limit) {
        if (expiresAt <= now) misses.delete(key)
        continue
      }
      misses.delete(key)
    }
    while (misses.size > limit) {
      const oldest = misses.keys().next().value
      if (!oldest) break
      misses.delete(oldest)
    }
  }

  function hasFreshMiss(key: string): boolean {
    if (!key) return false
    const expiresAt = misses.get(key) || 0
    const now = Date.now()
    if (expiresAt <= now) {
      misses.delete(key)
      return false
    }
    return true
  }

  function rememberMiss(key: string): void {
    if (!key) return
    misses.set(key, Date.now() + ttlMs)
    prune()
  }

  function rememberMisses(keys: string[]): void {
    const now = Date.now()
    for (const key of keys) {
      if (!key) continue
      misses.set(key, now + ttlMs)
    }
    prune(now)
  }

  function forget(key: string): void {
    if (!key) return
    misses.delete(key)
  }

  return { hasFreshMiss, rememberMiss, rememberMisses, forget }
}
