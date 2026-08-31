import type { FontItem } from '@shared/types'
import { fontDisplayName } from './appRuntime'
import type { FontDialogRuntimeOptions } from './fontDialogRuntime'
import { ensureLibraryTagNamesContainFontTags,markFontTagsOptimistic } from './fontTagStateAuthorityRuntime'
import {
  addTagNameToLibrary,
  addTagToFontInLibrary,
  removedTagNameList,
  tagNameListWithValue,
} from './fontTagMutationRuntime'

export type FontDialogTagActionsRuntime = {
  createTagOnlyFromInput: (newTagName: string) => void
  createSharedTagOnlyFromInput: (newSharedTagName: string) => void
  addTagToSelectedByName: (nameInput: string) => void
  addSharedTagToSelectedByName: (nameInput: string) => void
  removeTagFromSelected: (tag: string) => void
  removeSharedTagFromSelected: (tag: string) => void
}


function latestSelectedFont(options: FontDialogRuntimeOptions): FontItem | undefined {
  const selectedFont = options.selectedFont
  if (!selectedFont?.id) return selectedFont
  return options.library.fonts?.[selectedFont.id] || selectedFont
}

function setFontInLibrary(options: FontDialogRuntimeOptions, selectedFont: FontItem, nextFont: FontItem): void {
  options.setLibrary((prev) => ensureLibraryTagNamesContainFontTags({
    ...prev,
    fonts: {
      ...prev.fonts,
      [selectedFont.id]: nextFont,
    },
  }))
}

export function createFontDialogTagActions(
  options: FontDialogRuntimeOptions,
  refreshTagViewsNow: () => void,
): FontDialogTagActionsRuntime {
  const setStatus = options.setStatus

  return {
    createTagOnlyFromInput(newTagName: string): void {
      const tag = newTagName.trim()
      if (!tag) {
        setStatus('标签名称不能为空。')
        return
      }

      options.setLibrary((prev) => addTagNameToLibrary(prev, 'local', tag))
      options.setNewTagName('')
      options.setSelectedTagName(tag)
      options.setSidebarPage('tags')
      setStatus(`已新建本地标签：${tag}`)
    },

    createSharedTagOnlyFromInput(newSharedTagName: string): void {
      const tag = newSharedTagName.trim()
      if (!tag) {
        setStatus('共享标签名称不能为空。')
        return
      }

      options.setLibrary((prev) => addTagNameToLibrary(prev, 'shared', tag))
      options.setNewSharedTagName('')
      options.setSelectedSharedTagName(tag)
      options.setSidebarPage('sharedTags')
      setStatus(`已新建共享标签：${tag}`)
    },

    addTagToSelectedByName(nameInput: string): void {
      const selectedFont = latestSelectedFont(options)
      if (!selectedFont) return
      const tag = nameInput.trim()
      if (!tag) {
        setStatus('请输入标签名称。')
        return
      }

      const nextTags = tagNameListWithValue(selectedFont.localTagNames, tag)
      const nextFont = markFontTagsOptimistic(selectedFont, 'local', nextTags)
      options.setLibrary((prev) => addTagToFontInLibrary(prev, selectedFont, 'local', tag).library)
      options.setAssignTagName('')
      setStatus(`已为 ${fontDisplayName(selectedFont)} 添加标签：${tag}`)
      options.queueLocalTagsWrite(nextFont, nextTags)
      refreshTagViewsNow()
    },

    addSharedTagToSelectedByName(nameInput: string): void {
      const selectedFont = latestSelectedFont(options)
      if (!selectedFont) return
      const tag = nameInput.trim()
      if (!tag) {
        setStatus('请输入共享标签名称。')
        return
      }

      const nextTags = tagNameListWithValue(selectedFont.tagNames, tag)
      const nextFont = markFontTagsOptimistic(selectedFont, 'shared', nextTags)
      options.setLibrary((prev) => addTagToFontInLibrary(prev, selectedFont, 'shared', tag).library)
      options.setAssignSharedTagName('')
      setStatus(`已为 ${fontDisplayName(selectedFont)} 添加共享标签：${tag}`)
      options.queueSharedTagsWrite({ ...nextFont, __sharedTagWriteMode: 'add', __sharedTagWriteTag: tag } as FontItem, nextTags)
      refreshTagViewsNow()
    },

    removeTagFromSelected(tag: string): void {
      const selectedFont = latestSelectedFont(options)
      if (!selectedFont) return
      const nextTags = removedTagNameList(selectedFont.localTagNames, tag)
      const nextFont = markFontTagsOptimistic(selectedFont, 'local', nextTags)
      setFontInLibrary(options, selectedFont, nextFont)
      setStatus(`已从 ${fontDisplayName(selectedFont)} 移除标签：${tag}`)
      options.queueLocalTagsWrite(nextFont, nextTags)
      refreshTagViewsNow()
    },

    removeSharedTagFromSelected(tag: string): void {
      const selectedFont = latestSelectedFont(options)
      if (!selectedFont) return
      const nextTags = removedTagNameList(selectedFont.tagNames, tag)
      const nextFont = markFontTagsOptimistic(selectedFont, 'shared', nextTags)
      setFontInLibrary(options, selectedFont, nextFont)
      setStatus(`已从 ${fontDisplayName(selectedFont)} 移除共享标签：${tag}`)
      options.queueSharedTagsWrite({ ...nextFont, __sharedTagWriteMode: 'remove', __sharedTagWriteTag: tag } as FontItem, nextTags)
      refreshTagViewsNow()
    },
  }
}
