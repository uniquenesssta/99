import type { ScanResult,WatchedFolderRefreshResult } from '@shared/types'
import type { MenuTarget } from '../../../appRuntime'
import { applyFolderCacheToLibrary,buildFolderTreeFromCachedFonts,folderPhysicalPath } from '../../../appRuntime'
import { cacheLoadStatus,folderRefreshStatusText } from '../../../fontStatusRuntime'
import type { FontLibraryIndexActionRuntimeOptions,FontLibraryIndexSharedRuntime } from './fontLibraryIndexActionTypes'

export function createFontLibraryFolderCacheActionRuntime(
  options: FontLibraryIndexActionRuntimeOptions,
  sharedRuntime: Pick<FontLibraryIndexSharedRuntime, 'invalidateDatabasePages' | 'loadCacheStats' | 'readPhysicalFolderTree'>
): {
  loadSharedCacheForFolders: (folders: string[], keepScroll?: boolean) => Promise<ScanResult | null>
  addFolder: () => Promise<void>
  readSharedCache: () => Promise<void>
  refreshWatchedFolders: () => Promise<void>
  refreshFolderTarget: (target: Extract<MenuTarget, { kind: 'folder' }>) => Promise<void>
} {
  let addFolderTask: Promise<void> | null = null

  async function loadSharedCacheForFolders(folders: string[], keepScroll = true, hydratePhysicalTree = false): Promise<ScanResult | null> {
    if (!folders.length) {
      options.setStatus('请先添加字体文件夹')
      return null
    }

    const runId = options.nextIndexOperationRunId()
    options.setStatus('正在读取共享索引，不扫描字体文件……')
    const result = await options.hfm.loadFolderCache(folders)
    if (!options.isCurrentIndexOperation(runId)) return null
    const scrollSnapshot = keepScroll ? options.captureFontScrollSnapshot() : null
    const currentLibrary = options.getCurrentLibrary()
    let tree = buildFolderTreeFromCachedFonts(result.folders, result.fonts, currentLibrary.folderNodes || [])
    let physicalTreeWarning = ''
    if (hydratePhysicalTree || (result.missingCacheFolders?.length || 0) > 0) {
      try {
        const physicalTree = await sharedRuntime.readPhysicalFolderTree(result.folders.length ? result.folders : folders)
        if (!options.isCurrentIndexOperation(runId)) return null
        tree = physicalTree
      } catch (error) {
        physicalTreeWarning = ` 物理文件夹树读取失败：${error instanceof Error ? error.message : String(error)}`
      }
    }
    const nextLibrary = options.commitLibraryUpdate(applyFolderCacheToLibrary(currentLibrary, tree, result.fonts, result.cacheFolders || []))

    if (!await options.saveLibraryImmediately(nextLibrary)) {
      if (scrollSnapshot) options.restoreFontScrollSnapshot(scrollSnapshot)
      options.setStatus('共享索引已读取，但文件夹树保存失败；数据库统计暂不刷新，自动保存会继续重试。')
      return result
    }
    if (typeof options.hfm.checkSharedMetadataUpdates === 'function') {
      await options.hfm.checkSharedMetadataUpdates('load-folder-cache-database-sync')
    }

    sharedRuntime.invalidateDatabasePages()
    options.knownInstallStatusIds.current.clear()
    options.autoInstallStatusRefreshStartedRef.current = false
    if (scrollSnapshot) options.restoreFontScrollSnapshot(scrollSnapshot)

    if (options.selectedFolderId && !tree.folders.includes(options.selectedFolderId) && !tree.nodes.some((node) => node.id === options.selectedFolderId)) {
      options.setSelectedFolderId('')
    }

    await sharedRuntime.loadCacheStats()
    const statusText = `${cacheLoadStatus(result)}${physicalTreeWarning}`
    if (result.fonts.length && typeof options.hfm.startInstallStatusRefreshIndex === 'function') {
      options.autoInstallStatusRefreshStartedRef.current = true
      void options.startBackgroundInstallStatusRefresh(statusText)
    } else {
      options.setStatus(statusText)
    }
    return result
  }

  function addFolder(): Promise<void> {
    if (addFolderTask) return addFolderTask
    let task: Promise<void>
    task = (async () => {
      const folders = await options.hfm.selectFontFolders()
      if (!folders.length) return

      const mergedFolders = Array.from(new Set([...options.getCurrentLibrary().folders, ...folders]))
      await loadSharedCacheForFolders(mergedFolders, false, true)
    })().finally(() => {
      if (addFolderTask === task) addFolderTask = null
    })
    addFolderTask = task
    return task
  }

  async function readSharedCache(): Promise<void> {
    await loadSharedCacheForFolders(options.getCurrentLibrary().folders, true)
  }

  async function refreshWatchedFolders(): Promise<void> {
    const folders = options.getCurrentLibrary().folders
    if (!folders.length) return

    try {
      await loadSharedCacheForFolders(folders, true)
    } catch (error) {
      options.setStatus(`读取共享索引失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  async function refreshFolderTarget(target: Extract<MenuTarget, { kind: 'folder' }>): Promise<void> {
    if (typeof options.hfm.refreshWatchedFolder !== 'function') {
      options.setStatus('当前 preload 缺少单文件夹刷新接口。')
      return
    }

    const folderPath = folderPhysicalPath(options.getCurrentLibrary(), target.id) || target.id || target.rootPath
    const rootPath = target.rootPath || folderPath
    if (!folderPath) {
      options.setStatus('无法确定要刷新的物理文件夹。')
      return
    }

    try {
      options.setContextMenu(null)
      options.setStatus(`正在刷新“${target.name}”：检查索引/预览缓存，并检测新增字体……`)
      const result: WatchedFolderRefreshResult = await options.hfm.refreshWatchedFolder(folderPath, rootPath)
      if (result.mode === 'background') {
        options.setStatus(`刷新“${target.name}”已转入后台：${folderRefreshStatusText(result)}`)
        return
      }

      const folders = options.getCurrentLibrary().folders
      const tree = await sharedRuntime.readPhysicalFolderTree(folders)
      const cache = await options.hfm.loadFolderCache(folders)
      const currentLibrary = options.getCurrentLibrary()
      const nextLibrary = options.commitLibraryUpdate(applyFolderCacheToLibrary(currentLibrary, tree, cache.fonts, cache.cacheFolders || []))

      if (!await options.saveLibraryImmediately(nextLibrary)) {
        options.setStatus(`刷新“${target.name}”完成，但文件夹树保存失败；本次未刷新文件夹统计。`)
        return
      }
      if (typeof options.hfm.checkSharedMetadataUpdates === 'function') {
        await options.hfm.checkSharedMetadataUpdates('refresh-folder-target-database-sync')
      }

      options.setSelectedFolderId(target.id)
      sharedRuntime.invalidateDatabasePages()
      await sharedRuntime.loadCacheStats()
      options.setStatus(`刷新“${target.name}”完成：${folderRefreshStatusText(result)}`)
    } catch (error) {
      options.setStatus(`刷新文件夹失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  return {
    loadSharedCacheForFolders,
    addFolder,
    readSharedCache,
    refreshWatchedFolders,
    refreshFolderTarget
  }
}
