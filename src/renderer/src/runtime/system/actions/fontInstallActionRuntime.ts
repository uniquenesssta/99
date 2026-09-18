import type { FontItem } from '@shared/types'
import { fontDisplayName,isInstalled,libraryWithMergedFonts } from '../../../appRuntime'
import { uniqueFontsById } from '../../../fontFolderMutationRuntime'
import { applyInstallCompareToFont } from '../../../fontInstallStateRuntime'
import { isFontDeleteProtected } from '../../../fontSelectionRuntime'
import type { FontSystemActionRuntimeOptions,FontSystemStateRuntime } from './fontSystemActionTypes'

export function createFontInstallActionRuntime(
  options: FontSystemActionRuntimeOptions,
  stateRuntime: Pick<FontSystemStateRuntime, 'updateFont'>,
  _activationRuntime: { deactivateFontByCard: (font: FontItem) => Promise<void> }
): {
  installFontByCard: (font: FontItem) => Promise<void>
  installFontsBatch: (fonts: FontItem[], label: string) => Promise<void>
  removeFontByCard: (font: FontItem) => Promise<void>
  uninstallFontsBatch: (fonts: FontItem[], label: string) => Promise<void>
} {
  async function runInstallCommand(fonts: FontItem[], label: string, uninstall: boolean): Promise<void> {
    options.setContextMenu(null)
    const current = options.getCurrentLibrary?.() || options.library
    const unique = uniqueFontsById(fonts).map(font => ({ ...(current.fonts[font.id] || font) }))
    const verb = uninstall ? '卸载字体' : '安装'
    let skippedProtected = 0, skippedState = 0, skippedBusy = 0
    const targets = unique.filter(font => {
      if (options.activeOperationFontIds.current.has(font.id)) { skippedBusy++; return false }
      if (uninstall && isFontDeleteProtected(font)) { skippedProtected++; return false }
      if (isInstalled(font) !== uninstall) { skippedState++; return false }
      return true
    })
    const skipped = `跳过保护 ${skippedProtected} 个，${uninstall ? '未安装' : '已安装'} ${skippedState} 个，处理中 ${skippedBusy} 个`
    if (!targets.length) { options.setStatus(`没有可${verb}的字体：成功 0 个，失败 0 个；${skipped}。`); return }
    if (uninstall && !window.confirm(`将卸载“${label}”中的 ${targets.length} 个已安装字体（所选 ${unique.length} 个）。${skipped}。不会删除源字体文件或取消临时激活；Windows 系统目录受权限限制。确定继续？`)) {
      options.setStatus(`已取消卸载，未执行 ${targets.length} 个；${skipped}。`)
      return
    }
    for (const font of targets) options.activeOperationFontIds.current.add(font.id)
    let succeeded = 0, failed = 0
    try {
      options.setLibrary(prev => libraryWithMergedFonts(prev, targets.filter(font => !prev.fonts[font.id]), targets.map(font => font.id)))
      for (const font of targets) {
        options.setStatus(`正在${verb}：${succeeded + failed + 1} / ${targets.length} · ${fontDisplayName(font)}`)
        try {
          const result = uninstall ? await options.hfm.uninstallSystem(font) : await options.hfm.installSystem(font)
          if (!result.ok) { failed++; continue }
          if (uninstall) stateRuntime.updateFont(font.id, current => ({ ...current, systemInstalled: false, systemInstallMatches: [] }))
          else {
            const compare = await options.hfm.compareFontInstalled(font)
            stateRuntime.updateFont(font.id, current => applyInstallCompareToFont(current, compare))
            if (!compare.installed) { failed++; continue }
          }
          succeeded++
        } catch { failed++ }
      }
    } finally {
      for (const font of targets) options.activeOperationFontIds.current.delete(font.id)
      options.refreshDatabaseDerivedState()
    }
    options.setStatus(`${verb}完成：成功 ${succeeded} 个，失败或未确认 ${failed} 个；${skipped}。`)
  }
  async function installFontsBatch(fonts: FontItem[], label: string): Promise<void> { await runInstallCommand(fonts, label, false) }
  async function uninstallFontsBatch(fonts: FontItem[], label: string): Promise<void> { await runInstallCommand(fonts, label, true) }
  async function installFontByCard(font: FontItem): Promise<void> { await installFontsBatch([font], fontDisplayName(font)) }
  async function removeFontByCard(font: FontItem): Promise<void> { await uninstallFontsBatch([font], fontDisplayName(font)) }
  return { installFontByCard, installFontsBatch, removeFontByCard, uninstallFontsBatch }
}
