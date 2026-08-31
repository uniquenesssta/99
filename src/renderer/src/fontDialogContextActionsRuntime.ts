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
      const fonts = options.fontsForTag(action.name, action.scope)
      options.setContextMenu(null)
      void options.activateFontsBatch(fonts, action.label)
    },

    runContextBatchDeactivate(): void {
      const action = tagBatchActionFromContextMenu(options.contextMenu)
      if (!action) return
      const fonts = options.fontsForTag(action.name, action.scope)
      options.setContextMenu(null)
      void options.deactivateFontsBatch(fonts, action.label)
    },
  }
}
