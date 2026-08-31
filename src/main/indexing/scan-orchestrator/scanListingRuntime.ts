import { promises as fsp } from 'node:fs'
import { resolve } from 'node:path'
import type { ScanResult } from '../../../shared/types'
import type { CachedFontStatLike } from '../../fonts/fontRuntime'
import type { RustFontFamilyHint, RustFontNameHint, RustFontScriptHint, RustFontStyleHint } from '../fontScanWorkers'
import { normalizePathForCacheCompare } from '../../path/cachePath'
import { findBestWatchedRootForFile } from '../../path/fontPathPolicy'
import { isOperationCancelledError, throwIfAborted } from '../../performance/ioQueue'
import type { RootScanCacheContext } from '../../watcher/watchedFolderIndexRuntime'
import type { RootDirectoryCacheRuntime } from './rootDirectoryCacheRuntime'
import type { ScanOrchestratorDeps } from './scanOrchestratorTypes'
import { delayToEventLoop } from './scanOrchestratorUtils'

export interface ScanStatJob {
  file: string
  rootPath: string
  stat: CachedFontStatLike | null
  error: string
  signatureValid?: boolean
  formatHint?: string
  quickHash?: string
  contentHash?: string
  hashKind?: string
  nameHint?: RustFontNameHint
  scriptHint?: RustFontScriptHint
  styleHint?: RustFontStyleHint
  familyHint?: RustFontFamilyHint
}

export function normalizeScanFolders(folders: string[]): string[] {
  return Array.from(new Set((folders || []).filter(Boolean).map((folder) => resolve(folder))))
}

export function dedupeScanStatJobs(items: ScanStatJob[]): ScanStatJob[] {
  const seenFiles = new Set<string>()
  return items.filter((item) => {
    const key = normalizePathForCacheCompare(item.file)
    if (seenFiles.has(key)) return false
    seenFiles.add(key)
    return true
  })
}

export async function ensureRootContextsForScan(args: {
  deps: ScanOrchestratorDeps
  folders: string[]
  signal?: AbortSignal
  errors: ScanResult['errors']
  ensureRootContext: (folder: string) => Promise<RootScanCacheContext>
}): Promise<void> {
  const { deps, folders, signal, errors, ensureRootContext } = args
  for (const folder of folders) {
    try {
      throwIfAborted(signal)
      const stat = await deps.withGlobalIo('scan:stat-root', () => fsp.stat(folder), {
        priority: 'normal',
        signal,
        storagePath: folder,
      })
      if (!stat.isDirectory()) continue
      await ensureRootContext(folder)
    } catch (error) {
      if (isOperationCancelledError(error)) throw error
      errors.push({ path: folder, message: error instanceof Error ? error.message : String(error) })
    }
  }
}


function rustScanListingEnabled(): boolean {
  const mode = String(process.env.HFM_RUST_SCAN_LISTING || '1').trim().toLowerCase()
  return mode !== '0' && mode !== 'false' && mode !== 'off'
}

function earlyVisibleListingEnabled(): boolean {
  const mode = String(process.env.HFM_SCAN_EARLY_VISIBLE || '1').trim().toLowerCase()
  return mode !== '0' && mode !== 'false' && mode !== 'off'
}

function rootForListedDirectory(folders: string[], dirPath: string): string | null {
  return findBestWatchedRootForFile(dirPath, folders)
}

async function tryListScanStatJobsWithRust(args: {
  deps: ScanOrchestratorDeps
  folders: string[]
  signal?: AbortSignal
  errors: ScanResult['errors']
  ensureRootContext: (folder: string) => Promise<RootScanCacheContext>
  reportProgress: (payload: any, immediate?: boolean) => void
  onListedBatch?: (items: ScanStatJob[]) => void
}): Promise<ScanStatJob[] | null> {
  const { deps, folders, signal, errors, ensureRootContext, reportProgress, onListedBatch } = args
  if (!rustScanListingEnabled() || !deps.runRustFontIndexListWorker) return null
  if (onListedBatch && earlyVisibleListingEnabled()) {
    deps.appendStartupLog('rust scan listing skipped: early visible directory stream enabled')
    return null
  }

  throwIfAborted(signal)
  const startedAt = Date.now()
  try {
    reportProgress({ stage: 'listing', message: 'Rust core 正在列出字体文件……' }, true)
    const listed = await deps.runRustFontIndexListWorker(
      folders,
      Array.from(deps.fontExtensions).map((value) => value.replace(/^\./, '')),
      (payload) => {
        reportProgress({
          stage: 'listing',
          message: `Rust core 正在列出字体：已发现 ${payload.files} 个，目录 ${payload.foldersScanned} 个。`,
          listedFiles: payload.files,
        })
      },
      signal,
    )
    if (!listed) return null
    if (listed.truncated) {
      deps.appendStartupLog('rust scan listing skipped: result truncated, fallback to directory cache listing')
      return null
    }

    for (const item of listed.directories || []) {
      const rootPath = rootForListedDirectory(folders, item.path)
      if (!rootPath) continue
      const context = await ensureRootContext(rootPath)
      context.directoryUpdates.push({
        relativePath: item.path === rootPath ? '' : directoryRelativePath(context, item.path),
        modifiedAt: Number(item.modifiedMs || 0),
        fileCount: Number(item.fileCount || 0),
        dirCount: Number(item.dirCount || 0),
      })
    }

    errors.push(...listed.errors)
    deps.appendStartupLog(`scan listing source=rust files=${listed.files.length}, valid=${listed.files.filter((item) => item.signatureValid !== false).length}, invalid=${listed.files.filter((item) => item.signatureValid === false).length}, quickHash=${listed.files.filter((item) => item.quickHash).length}, contentHash=${listed.files.filter((item) => item.contentHash).length}, fullHash=${listed.files.filter((item) => item.hashKind === 'full-fnv1a64').length}, nameHints=${listed.files.filter((item) => item.nameHint).length}, scriptHints=${listed.files.filter((item) => item.scriptHint).length}, styleHints=${listed.files.filter((item) => item.styleHint).length}, familyHints=${listed.files.filter((item) => item.familyHint).length}, folders=${listed.foldersScanned || 0}, errors=${listed.errors.length}, durationMs=${Date.now() - startedAt}`)
    return dedupeScanStatJobs(listed.files.map((item) => ({ ...item, error: '', signatureValid: item.signatureValid, formatHint: item.format, quickHash: item.quickHash, contentHash: item.contentHash, hashKind: item.hashKind, nameHint: item.nameHint, scriptHint: item.scriptHint, styleHint: item.styleHint, familyHint: item.familyHint })))
  } catch (error) {
    if (isOperationCancelledError(error)) throw error
    deps.appendStartupLog(`rust scan listing failed, fallback to directory cache listing: ${error instanceof Error ? error.message : String(error)}`)
    reportProgress({ stage: 'listing', message: 'Rust core 列出失败，已降级为目录缓存列出。' }, true)
    return null
  }
}

function directoryRelativePath(context: RootScanCacheContext, dirPath: string): string {
  return dirPath.length <= context.rootPath.length ? '' : dirPath.slice(context.rootPath.length).replace(/^[\\/]+/, '').replace(/\\/g, '/')
}

export async function listScanStatJobs(args: {
  deps: ScanOrchestratorDeps
  directoryCacheRuntime: RootDirectoryCacheRuntime
  folders: string[]
  signal?: AbortSignal
  errors: ScanResult['errors']
  ensureRootContext: (folder: string) => Promise<RootScanCacheContext>
  reportProgress: (payload: any, immediate?: boolean) => void
  onListedBatch?: (items: ScanStatJob[]) => void
}): Promise<ScanStatJob[]> {
  const { deps, directoryCacheRuntime, folders, signal, errors, ensureRootContext, reportProgress, onListedBatch } = args
  const rustListed = await tryListScanStatJobsWithRust({ deps, folders, signal, errors, ensureRootContext, reportProgress, onListedBatch })
  if (rustListed) return rustListed

  try {
    const allListed: ScanStatJob[] = []
    for (const folder of folders) {
      throwIfAborted(signal)
      const context = await ensureRootContext(folder)
      const listed = await directoryCacheRuntime.listFontFilesWithDirectoryCache(
        context,
        errors,
        (payload) => {
          reportProgress({
            stage: 'listing',
            message: `正在增量列出字体：已发现 ${payload.files} 个，目录 ${payload.foldersScanned} 个，跳过未变化目录 ${payload.skippedDirs} 个。`,
            listedFiles: payload.files,
          })
        },
        signal,
        undefined,
        onListedBatch,
      )
      allListed.push(...listed)
      await delayToEventLoop()
    }
    return dedupeScanStatJobs(allListed)
  } catch (error) {
    if (isOperationCancelledError(error)) throw error
    deps.appendStartupLog(`directory cache listing failed, fallback to worker walk: ${error instanceof Error ? error.message : String(error)}`)
    reportProgress({ stage: 'listing', message: '目录级缓存列出失败，已降级为后台 Worker 全量列出。' }, true)

    throwIfAborted(signal)
    const listed = await deps.runFontIndexListWorker(
      folders,
      (payload) => {
        if (Array.isArray(payload.batch) && payload.batch.length) {
          onListedBatch?.(payload.batch.map((item) => ({ ...item, error: '' })))
        }
        reportProgress({
          stage: 'listing',
          message: `后台索引 Worker 正在列出字体：已发现 ${payload.files} 个，目录 ${payload.foldersScanned} 个。`,
          listedFiles: payload.files,
        })
      },
      signal,
    )

    errors.push(...listed.errors)
    return dedupeScanStatJobs(listed.files.map((item) => ({ ...item, error: '', signatureValid: item.signatureValid, formatHint: item.format, quickHash: item.quickHash, contentHash: item.contentHash, hashKind: item.hashKind, nameHint: item.nameHint, scriptHint: item.scriptHint, styleHint: item.styleHint, familyHint: item.familyHint })))
  }
}
