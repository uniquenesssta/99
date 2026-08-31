import { promises as fsp } from 'node:fs'
import { join } from 'node:path'

export type PreviewLocalCacheEvictionRuntimeOptions = {
  appendStartupLog: (message: string) => void
  localPreviewImageDir: () => string
  openPreviewDb: () => Promise<any>
  normalizePathForCacheCompare: (value: string) => string
}

const DEFAULT_LOCAL_CACHE_MAX_GB = 2
const DEFAULT_LOCAL_CACHE_MAX_FILES = 80000
const DEFAULT_EVICT_IDLE_DELAY_MS = 30000
const DEFAULT_EVICT_MIN_INTERVAL_MS = 5 * 60 * 1000
const DEFAULT_EVICT_BATCH_LIMIT = 5000
const DEFAULT_STATS_LOG_INTERVAL_MS = 10000

function parseEnvInt(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const parsed = Number(raw)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.min(max, Math.floor(parsed)))
}

function parseEnvNumber(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const parsed = Number(raw)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.min(max, parsed))
}

function envEnabled(name: string, fallback: boolean): boolean {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  return raw !== '0' && raw.toLowerCase() !== 'false' && raw.toLowerCase() !== 'off'
}

function evictionEnabled(): boolean {
  return envEnabled('HFM_PREVIEW_LOCAL_CACHE_EVICT', true)
}

function localCacheMaxBytes(): number {
  return Math.floor(parseEnvNumber('HFM_PREVIEW_LOCAL_CACHE_MAX_GB', DEFAULT_LOCAL_CACHE_MAX_GB, 0.1, 1024) * 1024 * 1024 * 1024)
}

function localCacheMaxFiles(): number {
  return parseEnvInt('HFM_PREVIEW_LOCAL_CACHE_MAX_FILES', DEFAULT_LOCAL_CACHE_MAX_FILES, 1000, 5000000)
}

function evictIdleDelayMs(): number {
  return parseEnvInt('HFM_PREVIEW_LOCAL_CACHE_EVICT_IDLE_MS', DEFAULT_EVICT_IDLE_DELAY_MS, 1000, 10 * 60 * 1000)
}

function evictMinIntervalMs(): number {
  return parseEnvInt('HFM_PREVIEW_LOCAL_CACHE_EVICT_MIN_INTERVAL_MS', DEFAULT_EVICT_MIN_INTERVAL_MS, 10000, 24 * 60 * 60 * 1000)
}

function evictBatchLimit(): number {
  return parseEnvInt('HFM_PREVIEW_LOCAL_CACHE_EVICT_BATCH_LIMIT', DEFAULT_EVICT_BATCH_LIMIT, 100, 100000)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

type LocalPreviewFile = {
  path: string
  size: number
  mtimeMs: number
}

async function collectPreviewPngFiles(rootDir: string, batchLimit: number): Promise<LocalPreviewFile[]> {
  const result: LocalPreviewFile[] = []
  const stack = [rootDir]

  while (stack.length && result.length <= batchLimit * 4) {
    const dir = stack.pop()
    if (!dir) continue
    let entries: Array<{ name: string; isDirectory: () => boolean; isFile: () => boolean }> = []
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true }) as any
    } catch {
      continue
    }

    for (const entry of entries) {
      const filePath = join(dir, entry.name)
      if (entry.isDirectory()) {
        stack.push(filePath)
        continue
      }
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.png')) continue
      try {
        const stat = await fsp.stat(filePath)
        result.push({ path: filePath, size: stat.size, mtimeMs: stat.mtimeMs })
      } catch {
        // ignore transient local file changes
      }
    }
  }

  return result
}

export function createPreviewLocalCacheEvictionRuntime(options: PreviewLocalCacheEvictionRuntimeOptions) {
  let timer: ReturnType<typeof setTimeout> | null = null
  let active = false
  let lastRunAt = 0
  let lastStatsLogAt = 0
  const stats = {
    scheduled: 0,
    scanned: 0,
    removedFiles: 0,
    removedBytes: 0,
    dbRowsDeleted: 0,
    skipped: 0,
  }

  function logStats(force = false): void {
    const now = Date.now()
    if (!force && now - lastStatsLogAt < DEFAULT_STATS_LOG_INTERVAL_MS) return
    const total = stats.scheduled + stats.scanned + stats.removedFiles + stats.dbRowsDeleted + stats.skipped
    if (!total) return
    lastStatsLogAt = now
    options.appendStartupLog(`preview local cache eviction summary: scheduled=${stats.scheduled}, scanned=${stats.scanned}, removedFiles=${stats.removedFiles}, removedBytes=${stats.removedBytes}, dbRowsDeleted=${stats.dbRowsDeleted}, skipped=${stats.skipped}`)
    stats.scheduled = 0
    stats.scanned = 0
    stats.removedFiles = 0
    stats.removedBytes = 0
    stats.dbRowsDeleted = 0
    stats.skipped = 0
  }

  async function deletePreviewDbRowsForFiles(filePaths: string[]): Promise<void> {
    if (!filePaths.length) return
    const db = await options.openPreviewDb()
    const normalizedPaths = filePaths.map(options.normalizePathForCacheCompare)
    const chunkSize = 300
    for (let index = 0; index < normalizedPaths.length; index += chunkSize) {
      const chunk = normalizedPaths.slice(index, index + chunkSize)
      const placeholders = chunk.map(() => '?').join(',')
      if (!placeholders) continue
      const info = db.prepare(`DELETE FROM preview_cache WHERE output_path IN (${placeholders})`).run(...chunk)
      stats.dbRowsDeleted += Number(info?.changes || 0)
    }
  }

  async function runPreviewLocalCacheEviction(): Promise<void> {
    if (!evictionEnabled()) return
    if (active) return
    const now = Date.now()
    if (now - lastRunAt < evictMinIntervalMs()) {
      stats.skipped += 1
      logStats()
      return
    }

    active = true
    lastRunAt = now
    try {
      const files = await collectPreviewPngFiles(options.localPreviewImageDir(), evictBatchLimit())
      stats.scanned += files.length
      if (!files.length) return

      const maxBytes = localCacheMaxBytes()
      const maxFiles = localCacheMaxFiles()
      const totalBytes = files.reduce((sum, file) => sum + file.size, 0)
      if (totalBytes <= maxBytes && files.length <= maxFiles) return

      const targetBytes = Math.floor(maxBytes * 0.9)
      const targetFiles = Math.floor(maxFiles * 0.9)
      let currentBytes = totalBytes
      let currentFiles = files.length
      const deletedPaths: string[] = []

      files.sort((a, b) => a.mtimeMs - b.mtimeMs)
      for (const file of files) {
        if (currentBytes <= targetBytes && currentFiles <= targetFiles) break
        try {
          await fsp.rm(file.path, { force: true })
          currentBytes -= file.size
          currentFiles -= 1
          deletedPaths.push(file.path)
          stats.removedFiles += 1
          stats.removedBytes += file.size
        } catch {
          // ignore transient local delete failures; the next idle pass can retry
        }
      }

      await deletePreviewDbRowsForFiles(deletedPaths).catch((error) => {
        options.appendStartupLog(`preview local cache eviction db cleanup failed: ${errorMessage(error)}`)
      })
    } catch (error) {
      options.appendStartupLog(`preview local cache eviction failed: ${errorMessage(error)}`)
    } finally {
      active = false
      logStats(true)
    }
  }

  function schedulePreviewLocalCacheEviction(reason = 'preview-cache-write'): void {
    if (!evictionEnabled()) return
    stats.scheduled += 1
    if (timer) return
    timer = setTimeout(() => {
      timer = null
      void runPreviewLocalCacheEviction()
    }, evictIdleDelayMs())
  }

  return {
    schedulePreviewLocalCacheEviction,
    runPreviewLocalCacheEviction,
    logStats,
  }
}
