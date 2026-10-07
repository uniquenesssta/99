import { readTagCommandTargets } from './fontCommandTargetsRuntime'
import { traceActivationEntry } from './fontActivationTrace'
import {
  editableTargetFromContextMenu,
  folderTargetFromContextMenu,
  tagBatchActionFromContextMenu,
} from './fontContextMenuRuntime'
import type { FontDialogRuntimeOptions } from './fontDialogRuntime'

export type FontDialogContextActionsRuntime = {
  runContextRename: () => void
  runContextDelete: () => void
  runContextAddSubfolder: () => void
  runContextRefreshFolder: () => void
  runContextBatchActivate: () => void
  runContextBatchDeactivate: () => void
}

export function createFontDialogContextActions(options: FontDialogRuntimeOptions): FontDialogContextActionsRuntime {
  return {
    runContextRename(): void {
      const target = editableTargetFromContextMenu(options.contextMenu)
      if (!target) return
      options.setRenameTarget(target)
      options.setRenameValue(target.name)
      options.setContextMenu(null)
    },

    runContextDelete(): void {
      const target = editableTargetFromContextMenu(options.contextMenu)
      if (!target) return
      options.setDeleteTarget(target)
      options.setContextMenu(null)
    },

    runContextAddSubfolder(): void {
      const target = folderTargetFromContextMenu(options.contextMenu)
      if (!target) return
      options.setFolderChildTarget(target)
      options.setNewFolderName('')
      options.setContextMenu(null)
    },

    runContextRefreshFolder(): void {
      const target = folderTargetFromContextMenu(options.contextMenu)
      if (!target) return
      options.setContextMenu(null)
      void options.refreshFolderTarget(target)
    },

    runContextBatchActivate(): void {
      const action = tagBatchActionFromContextMenu(options.contextMenu)
      if (!action) return
      options.setContextMenu(null)
      options.setStatus(`正在读取 ${action.label} 的完整字体范围……`)
      void (async () => {
        try {
          if (options.flushFontWriteQueue && !await options.flushFontWriteQueue('tag-activate')) throw new Error('标签修改尚未保存，请稍后重试。')
          const fonts = await readTagCommandTargets(options.hfm, options.library, action.name, action.scope)
          await options.activateFontsBatch(traceActivationEntry(fonts, 'tag-context', fonts.length, action.scope), action.label)
        } catch (error) {
          options.setStatus(`标签操作未完成：${error instanceof Error ? error.message : String(error)}`)
        }
      })()
    },

    runContextBatchDeactivate(): void {
      const action = tagBatchActionFromContextMenu(options.contextMenu)
      if (!action) return
      options.setContextMenu(null)
      options.setStatus(`正在读取 ${action.label} 的完整字体范围……`)
      void (async () => {
        try {
          if (options.flushFontWriteQueue && !await options.flushFontWriteQueue('tag-deactivate')) throw new Error('标签修改尚未保存，请稍后重试。')
          const fonts = await readTagCommandTargets(options.hfm, options.library, action.name, action.scope)
          await options.deactivateFontsBatch(fonts, action.label)
        } catch (error) {
          options.setStatus(`标签操作未完成：${error instanceof Error ? error.message : String(error)}`)
        }
      })()
    },
  }
}
