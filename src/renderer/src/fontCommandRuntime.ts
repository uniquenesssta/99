import type { FontItem, LibraryState } from '@shared/types'
import { missingFontCommandTargetsMessage, resolveFontCommandTargets } from './fontCommandTargetsRuntime'
import { activationEntryTrace, traceActivationEntry } from './fontActivationTrace'
import { reportFontOperation } from './fontOperationTrace'

export const FONT_COMMANDS = [
  { action: 'install', label: '安装' }, { action: 'remove', label: '卸载字体' },
  { action: 'activate', label: '激活' }, { action: 'deactivate', label: '取消激活' },
  { action: 'deleteFile', label: '删除字体文件' },
  { action: 'protect', label: '加入保护' }, { action: 'unprotect', label: '取消保护' },
  { action: 'favorite', label: '收藏' }, { action: 'unfavorite', label: '取消收藏' },
  { action: 'localTags', label: '设置本地标签' }, { action: 'sharedTags', label: '设置共享标签' }
] as const
export type FontCommand = typeof FONT_COMMANDS[number]['action']
export type RunFontCommand = (action: FontCommand, ids?: string[], available?: FontItem[], entry?: 'selection-toolbar' | 'font-context' | 'detail', outcome?: string) => Promise<void>
export type FontCommandOptions = {
  library: LibraryState
  getCurrentLibrary?: () => LibraryState
  selectedFontIds: string[]
  getVisibleFonts?: () => FontItem[]
  setStatus: (value: string) => void
  installFontsBatch: (fonts: FontItem[], label: string) => Promise<void>
  uninstallFontsBatch: (fonts: FontItem[], label: string) => Promise<void>
  activateFontsBatch: (fonts: FontItem[], label: string) => Promise<void>
  deactivateFontsBatch: (fonts: FontItem[], label: string) => Promise<void>
  deleteFontsBatch: (fonts: FontItem[], label: string) => Promise<void>
  toggleFontDeleteProtection: (ids: string[], protect?: boolean, available?: FontItem[]) => Promise<void>
  setFontsFavorite: (fonts: FontItem[], favorite: boolean) => Promise<void>
  editFontTags: (fonts: FontItem[], scope: 'local' | 'shared') => void
}

export function createFontCommandRuntime(options: FontCommandOptions): RunFontCommand {
  return async (action, ids = options.selectedFontIds, available = [], entry = 'selection-toolbar', outcome) => {
    const resolved = resolveFontCommandTargets(ids, options.getCurrentLibrary?.() || options.library, [...(options.getVisibleFonts?.() || []), ...available])
    const fonts = resolved.fonts
    if (action === 'activate') traceActivationEntry(fonts, entry === 'detail' ? 'selection-toolbar' : entry, resolved.selectedIds.length, outcome || entry)
    if (resolved.missingIds.length) {
      if (action === 'activate') reportFontOperation({ trace: activationEntryTrace(fonts), stage: 'preflight', outcome: 'missing-records' })
      options.setStatus(missingFontCommandTargetsMessage(resolved.missingIds))
      return
    }
    if (!fonts.length) { options.setStatus('请先选择字体，本次操作未执行。'); return }
    const label = `已选择 ${fonts.length} 个字体`
    try {
      if (action === 'install') await options.installFontsBatch(fonts, label)
      if (action === 'remove') await options.uninstallFontsBatch(fonts, label)
      if (action === 'activate') await options.activateFontsBatch(fonts, label)
      if (action === 'deactivate') await options.deactivateFontsBatch(fonts, label)
      if (action === 'deleteFile') await options.deleteFontsBatch(fonts, label)
      if (action === 'protect' || action === 'unprotect') await options.toggleFontDeleteProtection(resolved.selectedIds, action === 'protect', fonts)
      if (action === 'favorite' || action === 'unfavorite') await options.setFontsFavorite(fonts, action === 'favorite')
      if (action === 'localTags' || action === 'sharedTags') options.editFontTags(fonts, action === 'localTags' ? 'local' : 'shared')
    } catch (error) {
      options.setStatus(`操作未完成：${error instanceof Error ? error.message : String(error)}`)
    }
  }
}
