import { traceDirectFontOperation } from './fontOperationTrace'
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
renameTagInLibrary
} from './fontTagMutationRuntime'
import { isSameFontTagIntent, cancelFontTagWrite, isFontTagStateDirty } from './fontTagStateAuthorityRuntime'
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

  // Each operation captures the same per-field token committed to the UI.
  function queueTagRetry(font: FontItem, scope: 'local' | 'shared'): void {
    let current: FontItem | undefined
    options.commitLibraryUpdate(prev => { current = prev.fonts[font.id]; return prev })
    if (!isSameFontTagIntent(current, font, scope)) { cancelFontTagWrite(font, scope); return }
    if (scope === 'shared') options.queueSharedTagsWrite(font, font.tagNames || [])
    else options.queueLocalTagsWrite(font, font.localTagNames || [])
  }
  function seedAffectedFonts(library: LibraryState, affected: FontItem[]): LibraryState {
    const fonts = { ...library.fonts }
    for (const font of affected) if (!fonts[font.id]) fonts[font.id] = font
    return { ...library, fonts }
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
        if (shared && typeof options.hfm.renameSharedTag === 'function') {
          closeRenameDialog()
          setStatus(`正在重命名共享标签“${renameTarget.name}”…`)
          try {
            const saved = await options.flushFontWriteQueue?.('shared-tag-rename-before') !== false
            if (!saved) throw new Error('仍有共享标签写入未保存，请重试。')
            const result = await traceDirectFontOperation('sharedTags', trace => options.hfm.renameSharedTag(renameTarget.name, clean, options.watchedFolders, trace))
            if (result.ok && options.selectedSharedTagName === renameTarget.name) options.setSelectedSharedTagName(clean)
            setStatus(result.message || (result.ok ? '共享标签重命名成功。' : '共享标签重命名未全部成功，请重试。'))
          } catch (error) {
            setStatus(`重命名共享标签失败，请重试：${error instanceof Error ? error.message : String(error)}`)
          }
          options.refreshDatabaseDerivedState()
        } else {
          let before = options.library
          const edited = options.commitLibraryUpdate(prev => {
            before = seedAffectedFonts(prev, affectedFonts)
            return renameTagInLibrary(before, renameTarget.scope, renameTarget.name, clean)
          })
          const writes = Object.values(edited.fonts).filter(font => isFontTagStateDirty(font, renameTarget.scope) && !isSameFontTagIntent(before.fonts[font.id], font, renameTarget.scope))
          closeRenameDialog()
          if (shared && options.selectedSharedTagName === renameTarget.name) options.setSelectedSharedTagName(clean)
          if (!shared && options.selectedTagName === renameTarget.name) options.setSelectedTagName(clean)
          for (const font of writes) queueTagRetry(shared
            ? { ...font, __sharedTagWriteMode: 'rename', __sharedTagWriteFrom: renameTarget.name, __sharedTagWriteTo: clean } as FontItem
            : font, renameTarget.scope)
          setStatus(`已提交${shared ? '共享标签' : '标签'}重命名：${clean}`)
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
        const direct = shared ? typeof options.hfm.deleteSharedTag === 'function' : typeof options.hfm.deleteLocalTag === 'function'
        setStatus(`正在删除${shared ? '共享标签' : '标签'}“${deleteTarget.name}”…`)
        if (direct) {
          // Catalog operations have no per-font queue representation. Keep the
          // current view until the authority commits; never create orphan intents
          // or retry a catalog delete as an unbind (which retains empty tags).
          try {
            const flushed = await options.flushFontWriteQueue?.(`${shared ? 'shared' : 'local'}-tag-delete`)
            if (flushed === false) throw new Error('仍有标签写入未保存，请重试。')
            const result = shared
              ? await traceDirectFontOperation('sharedTags', trace => options.hfm.deleteSharedTag(deleteTarget.name, options.watchedFolders, trace))
              : await traceDirectFontOperation('localTags', trace => options.hfm.deleteLocalTag(deleteTarget.name, trace))
            if (result.ok) {
              if (shared && options.selectedSharedTagName === deleteTarget.name) options.setSelectedSharedTagName('')
              if (!shared && options.selectedTagName === deleteTarget.name) options.setSelectedTagName('')
            }
            setStatus(result.message || (result.ok ? '标签删除成功。' : '标签删除未全部成功，请重试。'))
          } catch (error) {
            setStatus(`删除标签失败，请重试：${error instanceof Error ? error.message : String(error)}`)
          }
        } else {
          let before = options.library
          const edited = options.commitLibraryUpdate(prev => {
            before = seedAffectedFonts(prev, affectedFonts)
            return deleteTagFromLibrary(before, deleteTarget.scope, deleteTarget.name)
          })
          const writes = Object.values(edited.fonts).filter(font => isFontTagStateDirty(font, deleteTarget.scope) && !isSameFontTagIntent(before.fonts[font.id], font, deleteTarget.scope))
          for (const font of writes) queueTagRetry(shared
            ? { ...font, __sharedTagWriteMode: 'remove', __sharedTagWriteTag: deleteTarget.name } as FontItem : font, deleteTarget.scope)
          if (shared && options.selectedSharedTagName === deleteTarget.name) options.setSelectedSharedTagName('')
          if (!shared && options.selectedTagName === deleteTarget.name) options.setSelectedTagName('')
          setStatus(`已提交标签删除：${deleteTarget.name}`)
        }
        options.refreshDatabaseDerivedState()
      }
    },

    ...tagActions,
  }
}
