import { realpathSync,statSync } from 'node:fs'
import { resolve } from 'node:path'
import { normalizePathForCacheCompare } from './cachePath'
import { canonicalizeWatchedFolderPathText, normalizeNativePathText } from './pathCanonicalizer'

export type WatchedFolderCanonicalLogger = (message: string) => void

type FailedCanonicalPathEntry = { expiresAt: number; message: string }

const FAILED_CANONICAL_PATH_TTL_MS = 30000
const failedCanonicalPathCache = new Map<string, FailedCanonicalPathEntry>()

function shouldSkipSyncUncCanonicalProbe(folderPath: string): boolean {
  if (process.env.HFM_CANONICAL_SYNC_UNC_PROBE === '1') return false
  return /^\\\\[^\\]/.test(normalizeNativeSeparators(folderPath))
}

function normalizeNativeSeparators(folderPath: string): string {
  return normalizeNativePathText(folderPath)
}

export function canonicalWatchedFolderPath(rawFolder: string, appendLog?: WatchedFolderCanonicalLogger): string {
  const resolved = canonicalizeWatchedFolderPathText(resolve(String(rawFolder || '').trim()), appendLog)
  const cacheKey = normalizePathForCacheCompare(normalizeNativeSeparators(resolved))
  const cachedFailure = failedCanonicalPathCache.get(cacheKey)
  if (cachedFailure && cachedFailure.expiresAt > Date.now()) return resolved

  if (shouldSkipSyncUncCanonicalProbe(resolved)) {
    failedCanonicalPathCache.set(cacheKey, { expiresAt: Date.now() + FAILED_CANONICAL_PATH_TTL_MS, message: 'sync UNC canonical probe skipped' })
    appendLog?.(`watched folder canonical path fallback: ${resolved}, sync UNC canonical probe skipped; suppressed for ${FAILED_CANONICAL_PATH_TTL_MS}ms`)
    return resolved
  }

  try {
    const stat = statSync(resolved)
    if (!stat.isDirectory()) return resolved
    return canonicalizeWatchedFolderPathText(realpathSync.native(resolved), appendLog)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    failedCanonicalPathCache.set(cacheKey, { expiresAt: Date.now() + FAILED_CANONICAL_PATH_TTL_MS, message })
    appendLog?.(`watched folder canonical path fallback: ${resolved}, ${message}; suppressed for ${FAILED_CANONICAL_PATH_TTL_MS}ms`)
    return resolved
  }
}

export function watchedFolderCompareKey(folderPath: string): string {
  return normalizePathForCacheCompare(canonicalizeWatchedFolderPathText(normalizeNativeSeparators(resolve(folderPath))))
}

export function watchedFolderInsideRoot(folderPath: string, rootPath: string): boolean {
  const folderKey = watchedFolderCompareKey(folderPath)
  const rootKey = watchedFolderCompareKey(rootPath)
  return folderKey === rootKey || folderKey.startsWith(`${rootKey}\\`)
}

export function dedupeWatchedFolderRoots(folders: string[], appendLog?: WatchedFolderCanonicalLogger): string[] {
  const result: string[] = []

  for (const folder of folders || []) {
    if (!folder) continue
    const folderKey = watchedFolderCompareKey(folder)
    let coveredByExistingRoot = false

    for (const existing of result) {
      if (watchedFolderInsideRoot(folder, existing)) {
        coveredByExistingRoot = true
        if (watchedFolderCompareKey(existing) !== folderKey) {
          appendLog?.(`watched folder skipped because parent root already exists: child=${folder}, parent=${existing}`)
        }
        break
      }
    }

    if (coveredByExistingRoot) continue

    for (let index = result.length - 1; index >= 0; index -= 1) {
      const existing = result[index]
      if (!watchedFolderInsideRoot(existing, folder)) continue
      appendLog?.(`watched folder child root removed because new parent covers it: child=${existing}, parent=${folder}`)
      result.splice(index, 1)
    }

    result.push(folder)
  }

  return result
}
