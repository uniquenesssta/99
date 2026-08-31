import type { FontScanCacheEntry } from '../rootIndexRuntime'

export function normalizeScanContentHash(value: unknown): string | undefined {
  const text = String(value || '').trim()
  return text ? text : undefined
}

export function cacheEntryContentHashMatches(entry: FontScanCacheEntry | undefined, nextContentHash: string | undefined): boolean {
  if (!entry || !nextContentHash) return true
  if (!entry.contentHash) return true
  return entry.contentHash === nextContentHash
}

export function withScanContentHash<T extends FontScanCacheEntry>(entry: T, contentHash: string | undefined): T {
  if (!contentHash) return entry
  return { ...entry, contentHash }
}
