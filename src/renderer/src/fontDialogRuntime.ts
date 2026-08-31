import type { FontItem,LibraryState } from '@shared/types'
import type { Dispatch,SetStateAction } from 'react'
import type { ContextMenuState,EditableMenuTarget,MenuTarget,SidebarPage } from './appRuntime'
import {
replaceFolderPathInLibrary,
replacePathPrefixValue
} from './appRuntime'
import { createFontDialogContextActions } from './fontDialogContextActionsRuntime'
import { createFontDialogTagActions } from './fontDialogTagActionsRuntime'
import {
deleteTagFromLibrary,
removedTagNameList,
renameTagInLibrary,
renamedTagNameList
} from './fontTagMutationRuntime'
import { markFontTagsOptimistic } from './fontTagStateAuthorityRuntime'
import { physicalMutationIndexRefreshSuffix,refreshIndexesAfterPhysicalMutation } from './runtime/library/fontPhysicalMutationIndexRuntime'

export type FontDialogRuntimeOptions = {
  contextMenu: ContextMenuState
  renameTarget: EditableMenuTarget | null
  renameValue: string
  deleteTarget: EditableMenuTarget | null
  selectedFont: FontItem | undefined
  library: LibraryState
  selectedTagName: string
  selectedSharedTagName: string
  hfm: typeof window.hfm
  watchedFolders: string[]
  fontsForTag: (tagName: string, scope?: 'local' | 'shared') => FontItem[]
  queueLocalTagsWrite: (font: FontItem, localTagNames: string[]) => void
  queueSharedTagsWrite: (font: FontItem, tagNames: string[]) => void
  removeFolderTarget: (target: Extract<MenuTarget, { kind: 'folder' }>) => Promise<void>
  refreshFolderTarget: (target: Extract<MenuTarget, { kind: 'folder' }>) => Promise<void>
  activateFontsBatch: (fonts: FontItem[], label: string) => Promise<void>
  deactivateFontsBatch: (fonts: FontItem[], label: string) => Promise<void>
  updateFont: (fontId: string, updater: (font: FontItem) => FontItem) => void
  setLibrary: Dispatch<SetStateAction<LibraryState>>
  commitLibraryUpdate: (update: SetStateAction<LibraryState>) => LibraryState
  saveLibraryImmediately: (library: LibraryState) => Promise<boolean>
  setRenameTarget: Dispatch<SetStateAction<EditableMenuTarget | null>>
  setRenameValue: Dispatch<SetStateAction<string>>
  setDeleteTarget: Dispatch<SetStateAction<EditableMenuTarget | null>>
  setContextMenu: Dispatch<SetStateAction<ContextMenuState>>
  setFolderChildTarget: Dispatch<SetStateAction<Extract<MenuTarget, { kind: 'folder' }> | null>>
  setNewFolderName: Dispatch<SetStateAction<string>>
  setExpandedFolderIds: Dispatch<SetStateAction<Record<string, true>>>
  setSelectedFolderId: Dispatch<SetStateAction<string>>
  setSelectedTagName: Dispatch<SetStateAction<string>>
  setSelectedSharedTagName: Dispatch<SetStateAction<string>>
  setNewTagName: Dispatch<SetStateAction<string>>
  setNewSharedTagName: Dispatch<SetStateAction<string>>
  setAssignTagName: Dispatch<SetStateAction<string>>
  setAssignSharedTagName: Dispatch<SetStateAction<string>>
  setSidebarPage: Dispatch<SetStateAction<SidebarPage>>
  setStatus: Dispatch<SetStateAction<string>>
  refreshDatabaseDerivedState: () => void
  flushFontWriteQueue?: (reason?: string) => Promise<boolean>
}


export function createFontDialogRuntime(options: FontDialogRuntimeOptions): {
  runContextRename: () => void
  runContextDelete: () => void
  runContextAddSubfolder: () => void
  runContextRefreshFolder: () => void
  runContextBatchActivate: () => void
  runContextBatchDeactivate: () => void
  confirmRename: () => Promise<void>
  confirmDelete: () => Promise<void>
  createTagOnlyFromInput: (newTagName: string) => void
  createSharedTagOnlyFromInput: (newSharedTagName: string) => void
  addTagToSelectedByName: (nameInput: string) => void
  addSharedTagToSelectedByName: (nameInput: string) => void
  removeTagFromSelected: (tag: string) => void
  removeSharedTagFromSelected: (tag: string) => void
} {
  const setStatus = options.setStatus

  function refreshTagViewsNow(): void {
    options.refreshDatabaseDerivedState()
    if (options.flushFontWriteQueue) {
      void options.flushFontWriteQueue('tag-edit').finally(() => {
        options.refreshDatabaseDerivedState()
      })
    }
  }

  const contextActions = createFontDialogContextActions(options)
  const tagActions = createFontDialogTagActions(options, refreshTagViewsNow)

  return {
    ...contextActions,

    async confirmRename(): Promise<void> {
      const renameTarget = options.renameTarget
      if (!renameTarget) return

      const clean = options.renameValue.trim()
      if (!clean) {
        setStatus('名称不能为空。')
        return
      }

      let renameDialogClosed = false
      const closeRenameDialog = (): void => {
        if (renameDialogClosed) return
        renameDialogClosed = true
        options.setRenameTarget(null)
        options.setRenameValue('')
      }

      if (renameTarget.kind === 'folder') {
        try {
          const result = await options.hfm.renamePhysicalFolder(renameTarget.id, clean)
          if (!result.ok || !result.newPath) {
            setStatus(result.message)
            return
          }

          const oldPath = result.oldPath || renameTarget.id
          const newPath = result.newPath
          if (oldPath === newPath) {
            setStatus(result.message)
            return
          }

          const nextLibrary = options.commitLibraryUpdate((prev) => replaceFolderPathInLibrary(prev, oldPath, newPath))
          options.setExpandedFolderIds((prev) => Object.fromEntries(
            Object.entries(prev).map(([id, value]) => [replacePathPrefixValue(id, oldPath, newPath), value])
          ) as Record<string, true>)
          options.setSelectedFolderId((current) => replacePathPrefixValue(current, oldPath, newPath))

          const saved = await options.saveLibraryImmediately(nextLibrary)
          const refreshReport = await refreshIndexesAfterPhysicalMutation({
            hfm: options.hfm,
            watchedFolders: nextLibrary.folders || [],
            affectedPaths: [oldPath, newPath]
          })
          const saveWarning = saved ? '' : ' 新文件夹路径保存失败，后台保存队列会继续重试。'
          setStatus(`${result.message}${saveWarning}${physicalMutationIndexRefreshSuffix(refreshReport)}`)
        } catch (error) {
          setStatus(`重命名文件夹失败：${error instanceof Error ? error.message : String(error)}`)
          return
        }
      } else {
        const shared = renameTarget.scope === 'shared'
        const affectedFonts = options.fontsForTag(renameTarget.name, renameTarget.scope)
        options.setLibrary((prev) => renameTagInLibrary(prev, renameTarget.scope, renameTarget.name, clean))
        closeRenameDialog()

        if (shared) {
          const previousSelectedSharedTagName = options.selectedSharedTagName
          if (previousSelectedSharedTagName === renameTarget.name) options.setSelectedSharedTagName(clean)
          if (typeof options.hfm.renameSharedTag === 'function') {
            setStatus(`正在重命名共享标签“${renameTarget.name}”…`)
            try {
              const flushBeforeRename = options.flushFontWriteQueue
                ? options.flushFontWriteQueue('shared-tag-rename-before')
                : Promise.resolve(true)
              void flushBeforeRename
                .then((saved) => {
                  if (!saved) throw new Error('仍有共享标签写入未保存，请检查 NAS 或数据库状态后重试。')
                  return options.hfm.renameSharedTag(renameTarget.name, clean, options.watchedFolders)
                })
                .then((result) => {
                  options.refreshDatabaseDerivedState()
                  setStatus(result.message || `已将共享标签“${renameTarget.name}”重命名为“${clean}”。`)
                })
                .catch((error) => {
                  options.setLibrary((prev) => renameTagInLibrary(prev, 'shared', clean, renameTarget.name))
                  if (previousSelectedSharedTagName === renameTarget.name) options.setSelectedSharedTagName(renameTarget.name)
                  setStatus(`重命名共享标签失败：${error instanceof Error ? error.message : String(error)}`)
                  options.refreshDatabaseDerivedState()
                })
            } catch (error) {
              options.setLibrary((prev) => renameTagInLibrary(prev, 'shared', clean, renameTarget.name))
              if (previousSelectedSharedTagName === renameTarget.name) options.setSelectedSharedTagName(renameTarget.name)
              setStatus(`重命名共享标签失败：${error instanceof Error ? error.message : String(error)}`)
              return
            }
          } else {
            for (const font of affectedFonts) {
              const nextTags = renamedTagNameList(font.tagNames, renameTarget.name, clean)
              options.queueSharedTagsWrite({
                ...markFontTagsOptimistic(font, 'shared', nextTags),
                __sharedTagWriteMode: 'rename',
                __sharedTagWriteFrom: renameTarget.name,
                __sharedTagWriteTo: clean,
              } as FontItem, nextTags)
            }
            setStatus(`已将共享标签“${renameTarget.name}”重命名为“${clean}”。`)
          }
        } else {
          if (options.selectedTagName === renameTarget.name) options.setSelectedTagName(clean)
          for (const font of affectedFonts) {
            const nextTags = renamedTagNameList(font.localTagNames, renameTarget.name, clean)
            options.queueLocalTagsWrite(markFontTagsOptimistic(font, 'local', nextTags), nextTags)
          }
          setStatus(`已将标签“${renameTarget.name}”重命名为“${clean}”。`)
        }
      }

      closeRenameDialog()
    },

    async confirmDelete(): Promise<void> {
      const deleteTarget = options.deleteTarget
      if (!deleteTarget) return

      options.setDeleteTarget(null)

      if (deleteTarget.kind === 'folder') {
        await options.removeFolderTarget(deleteTarget)
      } else {
        const shared = deleteTarget.scope === 'shared'
        const affectedFonts = options.fontsForTag(deleteTarget.name, deleteTarget.scope)
        options.setLibrary((prev) => deleteTagFromLibrary(prev, deleteTarget.scope, deleteTarget.name))
        setStatus(`正在删除${shared ? '共享标签' : '标签'}“${deleteTarget.name}”…`)

        try {
          const flushed = await options.flushFontWriteQueue?.(`${shared ? 'shared' : 'local'}-tag-delete`)
          if (flushed === false) {
            throw new Error('仍有标签写入未保存，请检查磁盘、数据库或 NAS 状态后重试。')
          }
          const result = shared && typeof options.hfm.deleteSharedTag === 'function'
            ? await options.hfm.deleteSharedTag(deleteTarget.name, options.watchedFolders)
            : !shared && typeof options.hfm.deleteLocalTag === 'function'
              ? await options.hfm.deleteLocalTag(deleteTarget.name)
              : null

          if (shared) {
            if (options.selectedSharedTagName === deleteTarget.name) options.setSelectedSharedTagName('')
            if (!result) {
              for (const font of affectedFonts) {
                const nextTags = removedTagNameList(font.tagNames, deleteTarget.name)
                options.queueSharedTagsWrite({
                  ...markFontTagsOptimistic(font, 'shared', nextTags),
                  __sharedTagWriteMode: 'remove',
                  __sharedTagWriteTag: deleteTarget.name,
                } as FontItem, nextTags)
              }
            }
          } else {
            if (options.selectedTagName === deleteTarget.name) options.setSelectedTagName('')
            if (!result) {
              for (const font of affectedFonts) {
                const nextTags = removedTagNameList(font.localTagNames, deleteTarget.name)
                options.queueLocalTagsWrite(markFontTagsOptimistic(font, 'local', nextTags), nextTags)
              }
            }
          }

          options.refreshDatabaseDerivedState()
          setStatus(result?.message || `已删除${shared ? '共享标签' : '标签'}：${deleteTarget.name}`)
        } catch (error) {
          setStatus(`删除${shared ? '共享标签' : '标签'}失败：${error instanceof Error ? error.message : String(error)}`)
        }
      }
    },

    ...tagActions,
  }
}
