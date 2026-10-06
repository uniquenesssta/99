import { confirmUserAction } from '../../../confirmationDialogRuntime'
import type { FontItem, InstallResult } from '@shared/types'
import { fontDisplayName,isInstalled,libraryWithMergedFonts } from '../../../appRuntime'
import { uniqueFontsById } from '../../../fontFolderMutationRuntime'
import { getUninstallIssue, setUninstallIssue } from '../../../fontUserIntentRuntime'
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
    if (!await options.flushProtectionWrites()) { options.setStatus('保护状态尚未保存，未执行。请等待保护写入成功后重试。'); return }
    const current = options.getCurrentLibrary?.() || options.library
    const unique = uniqueFontsById(fonts).map(font => ({ ...(current.fonts[font.id] || font) }))
    const verb = uninstall ? '卸载字体' : '安装'
    let skippedProtected = 0, skippedState = 0, skippedBusy = 0
    const targets = unique.filter(font => {
      if (options.activeOperationFontIds.current.has(font.id)) { skippedBusy++; return false }
      if (uninstall && isFontDeleteProtected(font)) { skippedProtected++; return false }
      if (uninstall ? !isInstalled(font) && !getUninstallIssue(font) : isInstalled(font) || !!getUninstallIssue(font)) { skippedState++; return false }
      return true
    })
    const skipped = `跳过保护 ${skippedProtected} 个，${uninstall ? '未安装' : '已安装或待完成卸载'} ${skippedState} 个，处理中 ${skippedBusy} 个`
    if (!targets.length) { options.setStatus(`没有可${verb}的字体：成功 0 个，失败 0 个；${skipped}。`); return }
    for (const font of targets) options.activeOperationFontIds.current.add(font.id)
    let succeeded = 0, failed = 0, cancelled = 0, firstFailure = '', dispatched = false
    try {
      if (uninstall && !await confirmUserAction(`将卸载“${label}”中的 ${targets.length} 个字体（所选 ${unique.length} 个，含待完成卸载）。${skipped}。会解除已核实的关联登记，并清理可确认的独立安装副本；所选源文件及其属性保留，不取消临时激活。需要时将弹出一次 Windows 授权确认。确定继续？`)) {
        options.setStatus(`已取消卸载，未执行 ${targets.length} 个；${skipped}。`)
        return
      }
      dispatched = true
      options.setLibrary(prev => libraryWithMergedFonts(prev, targets.filter(font => !prev.fonts[font.id]), targets.map(font => font.id)))
      const batch = uninstall ? await options.hfm.uninstallSystem(targets) : undefined
      for (const font of targets) {
        options.setStatus(`正在${verb}：${succeeded + failed + cancelled + 1} / ${targets.length} · ${fontDisplayName(font)}`)
        try {
          const result: InstallResult = uninstall ? batch?.results?.[font.id] || { ok: false, message: batch?.message || '未收到逐项卸载回执。' } : await options.hfm.installSystem(font)
          if (!result.ok) {
            if (result.uninstall?.cancelled) cancelled++; else failed++; firstFailure ||= result.message
            if (uninstall) stateRuntime.updateFont(font.id, current => setUninstallIssue({ ...(result.installCompare ? applyInstallCompareToFont(current, result.installCompare) : current), pendingUninstall: result.uninstall?.pending ? { message: result.message, cancelled: result.uninstall.cancelled } : undefined }, result.message || '卸载未完成，请重试。'))
            continue
          }
          if (uninstall) stateRuntime.updateFont(font.id, current => setUninstallIssue(result.installCompare ? applyInstallCompareToFont(current, result.installCompare) : { ...current, systemInstalled: false, systemInstallMatches: [] }))
          else {
            const compare = await options.hfm.compareFontInstalled(font)
            stateRuntime.updateFont(font.id, current => setUninstallIssue(applyInstallCompareToFont(current, compare)))
            if (!compare.installed) { failed++; continue }
          }
          succeeded++
        } catch (error) {
          failed++; const message = error instanceof Error ? error.message : String(error); firstFailure ||= message
          if (uninstall) stateRuntime.updateFont(font.id, current => setUninstallIssue(current, message))
        }
      }
    } finally {
      for (const font of targets) options.activeOperationFontIds.current.delete(font.id)
      if (dispatched) options.refreshDatabaseDerivedState()
    }
    options.setStatus(`${verb}完成：成功 ${succeeded} 个，失败或未确认 ${failed} 个${cancelled ? `，取消 ${cancelled} 个` : ''}；${skipped}。${firstFailure ? `原因：${firstFailure}` : ''}`)
  }
  async function installFontsBatch(fonts: FontItem[], label: string): Promise<void> { await runInstallCommand(fonts, label, false) }
  async function uninstallFontsBatch(fonts: FontItem[], label: string): Promise<void> { await runInstallCommand(fonts, label, true) }
  async function installFontByCard(font: FontItem): Promise<void> { await installFontsBatch([font], fontDisplayName(font)) }
  async function removeFontByCard(font: FontItem): Promise<void> { await uninstallFontsBatch([font], fontDisplayName(font)) }
  return { installFontByCard, installFontsBatch, removeFontByCard, uninstallFontsBatch }
}
