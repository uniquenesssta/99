import { readTagCommandTargets } from './fontCommandTargetsRuntime'
import { traceActivationEntry } from './fontActivationTrace'
import {
  editableTargetFromContextMenu,
  folderTargetFromContextMenu,
  tagBatchActionFromContextMenu,
} from './fontContextMenuRuntime'
import type { FontDialogRuntimeOptions } from './fontDialogRuntime'

// Dialog factories are recreated on render; the API object owns the in-flight operation.
const activeRecoveries = new WeakSet<object>()

export type FontDialogContextActionsRuntime = {
  runContextRename: () => void
  runContextDelete: () => void
  runContextAddSubfolder: () => void
  runContextRefreshFolder: () => void
  runContextReindexTag: () => void
  runContextRelinkFont: () => void
  runContextBatchActivate: () => void
  runContextBatchDeactivate: () => void
}

export function createFontDialogContextActions(options: FontDialogRuntimeOptions): FontDialogContextActionsRuntime {
  function recover(input: import('@shared/tagFontRecovery').TagFontRecoveryRequest): void {
    options.setContextMenu(null)
    if (activeRecoveries.has(options.hfm)) {
      options.setStatus('正在恢复字体关联，请完成文件选择或等待本次恢复结束。')
      return
    }
    activeRecoveries.add(options.hfm)
    options.setStatus(input.mode === 'reindex' ? '正在按缺失字体所属目录重新索引……' : '请选择此字体的新文件，同目录内能匹配的缺失字体会自动链接。')
    void (async () => {
      try {
        if (options.flushFontWriteQueue && !await options.flushFontWriteQueue('tag-recovery')) throw new Error('标签修改尚未保存，请稍后重试。')
        const result = await options.hfm.recoverTagFiles(input)
        options.setStatus(result.message)
        if (!result.busy && !result.canceled) options.refreshDatabaseDerivedState()
      } catch (error) {
        options.setStatus(`恢复未完成：${error instanceof Error ? error.message : String(error)}`)
        options.refreshDatabaseDerivedState()
      } finally { activeRecoveries.delete(options.hfm) }
    })()
  }
  return {
    runContextReindexTag(): void {
      const action = tagBatchActionFromContextMenu(options.contextMenu)
      if (action) recover({ mode: 'reindex', tagName: action.name, scope: action.scope })
    },
    runContextRelinkFont(): void {
      const menu = options.contextMenu
      if (menu?.kind !== 'font' || menu.font.fileAvailability !== 'missing') return
      // The clicked card is the anchor, even when other cards are selected.
      const scope = options.sidebarPage === 'sharedTags' ? 'shared'
        : menu.font.localTagNames?.length ? 'local' : menu.font.tagNames?.length ? 'shared' : 'local'
      recover({ mode: 'relink', fontPath: menu.font.path, scope })
    },
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
