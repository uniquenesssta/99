import type { FontItem,LibraryState,MoveFontFileResult,PhysicalFolderTreeResult } from '@shared/types'
import type React from 'react'
import type { Dispatch,MutableRefObject,SetStateAction } from 'react'
import type { FontMetrics,MenuTarget,PreviewQueueEntry } from './appRuntime'
import {
applyFolderTreeToLibrary,
folderPhysicalPath,
fontDisplayName
} from './appRuntime'
import { toggleExpandedFolderId } from './fontFilterStateRuntime'
import { physicalMutationIndexRefreshSuffix,refreshIndexesAfterPhysicalMutation } from './runtime/library/fontPhysicalMutationIndexRuntime'
import {
applyMovedFontToLibrary,
applyMovedFontsToLibrary,
createRemoveFolderTargetPlan,
fontIdsFromDragDataTransfer,
removeFolderTargetFromLibrary
} from './fontFolderMutationRuntime'

export type FontFolderTreeRuntimeOptions = {
  selectedFolderId: string
  selectedFontId: string
  draggingFontId: string
  autoRefreshTimerRef: MutableRefObject<number | null>
  previewQueue: MutableRefObject<PreviewQueueEntry[]>
  autoPreviewCacheQueue: MutableRefObject<FontItem[]>
  lazyInstallQueue: MutableRefObject<FontItem[]>
  queuedPreviewFontIds: MutableRefObject<Set<string>>
  queuedAutoPreviewCacheIds: MutableRefObject<Set<string>>
  queuedLazyInstallIds: MutableRefObject<Set<string>>
  seenLazyInstallIds: MutableRefObject<Set<string>>
  loadingFonts: MutableRefObject<Set<string>>
  clearTimeout: typeof window.clearTimeout
  hfm: typeof window.hfm
  readPhysicalFolderTree: (folders: string[]) => Promise<PhysicalFolderTreeResult>
  getCurrentLibrary: () => LibraryState
  commitLibraryUpdate: (update: SetStateAction<LibraryState>) => LibraryState
  saveLibraryImmediately: (library: LibraryState) => Promise<boolean>
  setExpandedFolderIds: Dispatch<SetStateAction<Record<string, true>>>
  setSelectedFolderId: Dispatch<SetStateAction<string>>
  setDraggingFontId: Dispatch<SetStateAction<string>>
  setSelectedFontId: Dispatch<SetStateAction<string>>
  setSelectedFontIds: Dispatch<SetStateAction<string[]>>
  setDetailVisible: Dispatch<SetStateAction<boolean>>
  setNativeDetailImage: Dispatch<SetStateAction<string>>
  setNativePreviewImages: Dispatch<SetStateAction<Record<string, string>>>
  setFailedPreviewFontIds: Dispatch<SetStateAction<Record<string, true>>>
  setDatabasePageResult: Dispatch<SetStateAction<any>>
  setDatabaseQueryResult: Dispatch<SetStateAction<any>>
  setDatabaseFontMetrics: Dispatch<SetStateAction<FontMetrics | null>>
  setDatabaseRefreshToken: Dispatch<SetStateAction<number>>
  setStatus: Dispatch<SetStateAction<string>>
}

export function createFontFolderTreeRuntime(options: FontFolderTreeRuntimeOptions): {
  selectFolderFilter: (folderId: string) => void
  toggleFolderExpanded: (folderId: string) => void
  createSubfolder: (parent: Extract<MenuTarget, { kind: 'folder' }>, name: string) => Promise<void>
  assignFontToFolder: (fontId: string, folderId: string) => Promise<void>
  assignFontsToFolder: (fontIds: string[], folderId: string) => Promise<void>
  fontIdsFromDropEvent: (event: React.DragEvent) => string[]
  removeFolderTarget: (target: Extract<MenuTarget, { kind: 'folder' }>) => Promise<void>
} {
  const setStatus = options.setStatus

  async function assignFontToFolder(fontId: string, folderId: string): Promise<void> {
    const currentLibrary = options.getCurrentLibrary()
    const font = currentLibrary.fonts[fontId]
    if (!font) return

    const targetPhysicalPath = folderPhysicalPath(currentLibrary, folderId)
    if (!targetPhysicalPath) {
      setStatus('目标不是物理文件夹，无法物理移动字体。')
      return
    }

    try {
      const result = await options.hfm.moveFontFileToFolder(font, targetPhysicalPath)
      if (!result.ok) {
        setStatus(result.message)
        return
      }

      const nextLibrary = options.commitLibraryUpdate((prev) => applyMovedFontToLibrary(prev, fontId, result))
      const saved = await options.saveLibraryImmediately(nextLibrary)
      const refreshReport = await refreshIndexesAfterPhysicalMutation({
        hfm: options.hfm,
        watchedFolders: nextLibrary.folders || [],
        affectedPaths: [result.oldPath || font.path, result.newPath || font.path]
      })
      options.setSelectedFolderId(folderId)
      options.setDraggingFontId('')
      const baseMessage = result.message || `已物理移动“${fontDisplayName(font)}”。`
      const saveWarning = saved ? '' : ' 库状态保存失败，后台保存队列会继续重试。'
      setStatus(`${baseMessage}${saveWarning}${physicalMutationIndexRefreshSuffix(refreshReport)}`)
    } catch (error) {
      setStatus(`物理移动失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  return {
    selectFolderFilter(folderId: string): void {
      const currentLibrary = options.getCurrentLibrary()
      const validFolderIds = new Set([...(currentLibrary.folders || []), ...(currentLibrary.folderNodes || []).map((node) => node.id)])
      const nextFolderId = folderId && validFolderIds.has(folderId) ? folderId : ''
      options.setDatabasePageResult(null)
      options.setDatabaseQueryResult(null)
      options.setSelectedFolderId((current) => current === nextFolderId ? '' : nextFolderId)
    },

    toggleFolderExpanded(folderId: string): void {
      options.setExpandedFolderIds((prev) => toggleExpandedFolderId(prev, folderId))
    },

    async createSubfolder(parent: Extract<MenuTarget, { kind: 'folder' }>, name: string): Promise<void> {
      const clean = name.trim()
      if (!clean) {
        setStatus('子文件夹名称不能为空。')
        return
      }

      const currentLibrary = options.getCurrentLibrary()
      const parentPhysicalPath = folderPhysicalPath(currentLibrary, parent.id) || parent.rootPath
      if (!parentPhysicalPath) {
        setStatus('父级不是物理文件夹，无法创建物理子文件夹。')
        return
      }

      const duplicate = (currentLibrary.folderNodes || []).some((node) => node.parentId === parent.id && node.name === clean)
      if (duplicate) {
        setStatus(`子文件夹已存在：${clean}`)
        return
      }

      try {
        const createdPath = await options.hfm.createPhysicalFolder(parentPhysicalPath, clean)
        const tree = await options.readPhysicalFolderTree(options.getCurrentLibrary().folders)
        const nextLibrary = options.commitLibraryUpdate((prev) => applyFolderTreeToLibrary(prev, tree))
        if (!await options.saveLibraryImmediately(nextLibrary)) {
          setStatus('子文件夹已创建，但文件夹树保存失败；数据库视图会在保存恢复后刷新。')
          return
        }
        options.setDatabasePageResult(null)
        options.setDatabaseQueryResult(null)
        options.setDatabaseFontMetrics(null)
        options.setDatabaseRefreshToken((value) => value + 1)
        options.setExpandedFolderIds((prev) => ({ ...prev, [parent.id]: true }))
        options.setSelectedFolderId(createdPath)
        setStatus(`已创建物理子文件夹：${createdPath}`)
      } catch (error) {
        setStatus(`创建物理子文件夹失败：${error instanceof Error ? error.message : String(error)}`)
      }
    },

    assignFontToFolder,

    async assignFontsToFolder(fontIds: string[], folderId: string): Promise<void> {
      const currentLibrary = options.getCurrentLibrary()
      const uniqueIds = Array.from(new Set(fontIds)).filter((id) => !!currentLibrary.fonts[id])
      if (!uniqueIds.length) return

      if (uniqueIds.length === 1) {
        await assignFontToFolder(uniqueIds[0], folderId)
        return
      }

      const targetPhysicalPath = folderPhysicalPath(currentLibrary, folderId)
      if (!targetPhysicalPath) {
        setStatus('目标不是物理文件夹，无法物理移动字体。')
        return
      }

      const fontsToMove = uniqueIds.map((id) => currentLibrary.fonts[id]).filter((font): font is FontItem => !!font)
      setStatus(`正在批量移动：0 / ${fontsToMove.length}`)

      try {
        const result = await options.hfm.moveFontFilesToFolder(fontsToMove, targetPhysicalPath)
        const movedUpdates: Array<{ id: string; result: MoveFontFileResult }> = result.moved || []

        let saved = true
        let refreshReport = null
        if (movedUpdates.length) {
          const nextLibrary = options.commitLibraryUpdate((prev) => applyMovedFontsToLibrary(prev, movedUpdates))
          saved = await options.saveLibraryImmediately(nextLibrary)
          refreshReport = await refreshIndexesAfterPhysicalMutation({
            hfm: options.hfm,
            watchedFolders: nextLibrary.folders || [],
            affectedPaths: movedUpdates.flatMap((update) => [update.result.oldPath || '', update.result.newPath || ''])
          })
        }

        options.setSelectedFolderId(folderId)
        options.setDraggingFontId('')
        const baseMessage = result.message || `批量移动完成：成功 ${result.movedCount || 0} 个，失败 ${result.failed?.length || 0} 个。`
        const saveWarning = saved ? '' : ' 库状态保存失败，后台保存队列会继续重试。'
        const refreshSuffix = refreshReport ? physicalMutationIndexRefreshSuffix(refreshReport) : ''
        setStatus(`${baseMessage}${saveWarning}${refreshSuffix}`)
      } catch (error) {
        setStatus(`批量移动失败：${error instanceof Error ? error.message : String(error)}`)
      }
    },

    fontIdsFromDropEvent(event: React.DragEvent): string[] {
      return fontIdsFromDragDataTransfer(event.dataTransfer, options.draggingFontId)
    },

    async removeFolderTarget(target: Extract<MenuTarget, { kind: 'folder' }>): Promise<void> {
      const currentLibrary = options.getCurrentLibrary()
      const plan = createRemoveFolderTargetPlan(currentLibrary, target)
      const removedFontIds = plan.removedFontIds
      const childIds = plan.childIds

      const nextLibrary = options.commitLibraryUpdate((prev) => removeFolderTargetFromLibrary(prev, target, plan))
      const saved = await options.saveLibraryImmediately(nextLibrary)
      if (saved) {
        options.setDatabasePageResult(null)
        options.setDatabaseQueryResult(null)
        options.setDatabaseFontMetrics(null)
        options.setDatabaseRefreshToken((value) => value + 1)
      }

      if (options.autoRefreshTimerRef.current !== null) {
        options.clearTimeout(options.autoRefreshTimerRef.current)
        options.autoRefreshTimerRef.current = null
      }

      const removedIds = Array.from(removedFontIds)
      if (removedIds.length) {
        options.previewQueue.current = options.previewQueue.current.filter((entry) => !removedFontIds.has(entry.font.id))
        options.autoPreviewCacheQueue.current = options.autoPreviewCacheQueue.current.filter((font) => !removedFontIds.has(font.id))
        options.lazyInstallQueue.current = options.lazyInstallQueue.current.filter((font) => !removedFontIds.has(font.id))
        for (const id of removedIds) {
          options.queuedPreviewFontIds.current.delete(id)
          options.queuedAutoPreviewCacheIds.current.delete(id)
          options.queuedLazyInstallIds.current.delete(id)
          options.seenLazyInstallIds.current.delete(id)
          options.loadingFonts.current.delete(id)
        }
        options.setSelectedFontIds((prev) => prev.filter((id) => !removedFontIds.has(id)))
        options.setNativePreviewImages((prev) => Object.fromEntries(Object.entries(prev).filter(([id]) => !removedFontIds.has(id))))
        options.setFailedPreviewFontIds((prev) => Object.fromEntries(Object.entries(prev).filter(([id]) => !removedFontIds.has(id))))
      }

      if (removedFontIds.has(options.selectedFontId)) {
        options.setSelectedFontId('')
        options.setDetailVisible(false)
        options.setNativeDetailImage('')
      }
      if (childIds.has(options.selectedFolderId)) options.setSelectedFolderId('')
      const successText = target.virtual ? `已从列表移除物理子文件夹记录：${target.name}，同步移除 ${removedFontIds.size} 个字体记录。磁盘文件夹和共享索引没有被删除。` : `已移除监听文件夹：${target.name}，同步移除 ${removedFontIds.size} 个字体记录。磁盘文件夹和共享索引没有被删除。`
      setStatus(saved ? successText : `${successText} 但库状态保存失败，数据库视图暂未刷新。`)
    }
  }
}
