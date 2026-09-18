import type { FontItem } from '@shared/types'
import { missingFontCommandTargetsMessage, resolveFontCommandTargets } from './fontCommandTargetsRuntime'
import type { FontDialogRuntimeOptions } from './fontDialogRuntime'
import { ensureLibraryTagNamesContainFontTags,markFontTagsOptimistic,applyFontTagEdit } from './fontTagStateAuthorityRuntime'
import {
  addTagNameToLibrary,
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


export function createFontDialogTagActions(
  options: FontDialogRuntimeOptions,
  refreshTagViewsNow: () => void,
): FontDialogTagActionsRuntime {
  const setStatus = options.setStatus

  function editTag(nameInput: string, scope: 'local' | 'shared', add: boolean): void {
    const tag = nameInput.trim()
    if (!tag) { setStatus('请输入标签名称。'); return }
    let library = options.library
    options.commitLibraryUpdate(prev => { library = prev; return prev })
    const ids = options.selectedFontIds?.length ? options.selectedFontIds : options.selectedFont ? [options.selectedFont.id] : []
    const resolved = resolveFontCommandTargets(ids, library, [...(options.getVisibleFonts?.() || []), ...(options.selectedFont ? [options.selectedFont] : [])])
    if (resolved.missingIds.length) { setStatus(missingFontCommandTargetsMessage(resolved.missingIds)); return }
    if (!resolved.fonts.length) { setStatus('请先选择字体。'); return }
    const changed: FontItem[] = []
    for (const font of resolved.fonts) {
      const tags = scope === 'local' ? font.localTagNames || [] : font.tagNames || []
      if (tags.includes(tag) === add) continue
      const next = markFontTagsOptimistic(font, scope, add ? tagNameListWithValue(tags, tag) : removedTagNameList(tags, tag))
      changed.push(next)
    }
    if (changed.length) {
      options.setLibrary(prev => {
        const fonts = { ...prev.fonts }
        for (const font of changed) fonts[font.id] = applyFontTagEdit(fonts[font.id] || font, font, scope)
        return ensureLibraryTagNamesContainFontTags({ ...prev, fonts })
      })
      for (const font of changed) {
        if (scope === 'local') options.queueLocalTagsWrite(font, font.localTagNames || [])
        else options.queueSharedTagsWrite({ ...font, __sharedTagWriteMode: add ? 'add' : 'remove', __sharedTagWriteTag: tag } as FontItem, font.tagNames || [])
      }
      refreshTagViewsNow()
    }
    if (add) { if (scope === 'local') options.setAssignTagName(''); else options.setAssignSharedTagName('') }
    setStatus(`${scope === 'local' ? '本地标签' : '共享标签'}“${tag}”：已提交${add ? '添加' : '移除'} ${changed.length} 个，跳过未变化 ${resolved.fonts.length - changed.length} 个。保存结果由写入队列反馈。`)
  }


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

    addTagToSelectedByName(nameInput: string): void { editTag(nameInput, 'local', true) },
    addSharedTagToSelectedByName(nameInput: string): void { editTag(nameInput, 'shared', true) },
    removeTagFromSelected(tag: string): void { editTag(tag, 'local', false) },
    removeSharedTagFromSelected(tag: string): void { editTag(tag, 'shared', false) },
  }
}
