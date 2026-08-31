import type { FontItem } from '@shared/types'
import { fontDisplayName,isInstalled } from '../../../appRuntime'
import { uniqueFontsById } from '../../../fontFolderMutationRuntime'
import { applyInstallCompareToFont } from '../../../fontInstallStateRuntime'
import { isFontDeleteProtected } from '../../../fontSelectionRuntime'
import type { FontSystemActionRuntimeOptions,FontSystemStateRuntime } from './fontSystemActionTypes'

export function createFontInstallActionRuntime(
  options: FontSystemActionRuntimeOptions,
  stateRuntime: Pick<FontSystemStateRuntime, 'updateFont'>,
  activationRuntime: { deactivateFontByCard: (font: FontItem) => Promise<void> }
): {
  installFontByCard: (font: FontItem) => Promise<void>
  removeFontByCard: (font: FontItem) => Promise<void>
  uninstallFontsBatch: (fonts: FontItem[], label: string) => Promise<void>
} {
  async function installFontByCard(font: FontItem): Promise<void> {
    options.setStatus(`正在安装：${fontDisplayName(font)}……`)

    try {
      const result = await options.hfm.installSystem(font)
      const compare = await options.hfm.compareFontInstalled(font)
      stateRuntime.updateFont(font.id, (current) => applyInstallCompareToFont(current, compare))
      options.refreshDatabaseDerivedState()
      options.setStatus(result.message)
    } catch (error) {
      options.setStatus(`安装失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  async function removeFontByCard(font: FontItem): Promise<void> {
    if (font.active && !isInstalled(font)) {
      await activationRuntime.deactivateFontByCard(font)
      return
    }

    if (isFontDeleteProtected(font)) {
      options.setStatus(`已保护，不能删除或卸载：${fontDisplayName(font)}`)
      return
    }

    const ok = window.confirm('将移除这个已安装字体。受保护字体会被跳过；当前用户字体可直接移除。HKLM / C:\\Windows\\Fonts 中的字体受 Windows 权限限制，普通权限无法删除，软件只会内部提示，不会弹出 PowerShell。确定继续？')
    if (!ok) return

    options.setStatus(`正在移除：${fontDisplayName(font)}……`)

    try {
      const result = await options.hfm.uninstallSystem(font)
      if (result.ok) {
        stateRuntime.updateFont(font.id, (current) => ({
          ...current,
          systemInstalled: false,
          systemInstallMatches: []
        }))
        options.refreshDatabaseDerivedState()
      }
      options.setStatus(result.message)
    } catch (error) {
      options.setStatus(`移除失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  async function uninstallFontsBatch(fonts: FontItem[], label: string): Promise<void> {
    options.setContextMenu(null)
    const unique = uniqueFontsById(fonts)
    if (!unique.length) return

    const ok = window.confirm(`将批量卸载“${label}”中的字体。受保护或未安装字体会自动跳过。确定继续？`)
    if (!ok) return

    const targets = unique.filter((font) => isInstalled(font) && !isFontDeleteProtected(font))
    const skippedProtected = unique.filter(isFontDeleteProtected).length
    const skippedNotInstalled = unique.length - targets.length - skippedProtected

    if (!targets.length) {
      options.setStatus(`没有可卸载字体。跳过保护 ${skippedProtected} 个，跳过未安装 ${Math.max(0, skippedNotInstalled)} 个。`)
      return
    }

    let removed = 0
    let failed = 0
    for (const font of targets) {
      options.setStatus(`正在批量卸载：${removed + failed + 1} / ${targets.length} · ${fontDisplayName(font)}`)
      try {
        const result = await options.hfm.uninstallSystem(font)
        if (result.ok) {
          removed += 1
          stateRuntime.updateFont(font.id, (current) => ({
            ...current,
            systemInstalled: false,
            systemInstallMatches: []
          }))
        } else {
          failed += 1
        }
      } catch {
        failed += 1
      }
    }

    if (removed) options.refreshDatabaseDerivedState()
    options.setStatus(`批量卸载完成：卸载 ${removed} 个，失败 ${failed} 个，跳过保护 ${skippedProtected} 个，跳过未安装 ${Math.max(0, skippedNotInstalled)} 个。`)
  }

  return {
    installFontByCard,
    removeFontByCard,
    uninstallFontsBatch
  }
}
