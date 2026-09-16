import { createFontContextActionRuntime } from '../../fontContextActionRuntime'
import type { FontContextActionRuntimeOptions } from '../../fontContextActionRuntime'
import { createFontDialogRuntime } from '../../fontDialogRuntime'
import type { FontDialogRuntimeOptions } from '../../fontDialogRuntime'

type SharedDialogFields = 'library' | 'contextMenu' | 'setContextMenu' | 'activateFontsBatch' | 'deactivateFontsBatch'

export function createAppMenuDialogRuntime(context: FontContextActionRuntimeOptions) {
  const actions = createFontContextActionRuntime(context)
  function createDialogs(options: Omit<FontDialogRuntimeOptions, SharedDialogFields>, newTagName: string, newSharedTagName: string) {
    const dialog = createFontDialogRuntime({
      ...options,
      library: context.library,
      contextMenu: context.contextMenu,
      setContextMenu: context.setContextMenu,
      activateFontsBatch: context.activateFontsBatch,
      deactivateFontsBatch: context.deactivateFontsBatch
    })
    return {
      ...dialog,
      createTagOnlyFromInput: () => dialog.createTagOnlyFromInput(newTagName),
      createSharedTagOnlyFromInput: () => dialog.createSharedTagOnlyFromInput(newSharedTagName)
    }
  }
  return { ...actions, createDialogs }
}
