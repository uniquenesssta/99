import type { FontItem } from '@shared/types'
import { fontDisplayName,isCleanWindowsDefaultFont,isInstalled } from '../../../appRuntime'
import { batchActivationCandidates } from '../../../fontSelectionRuntime'
import type { FontSystemActionRuntimeOptions,FontSystemStateRuntime } from './fontSystemActionTypes'

export function createFontActivationActionRuntime(
  options: FontSystemActionRuntimeOptions,
  stateRuntime: Pick<FontSystemStateRuntime, 'adjustDatabaseActiveCount' | 'setFontActiveRuntime' | 'setFontsActiveRuntimeBulk'>
): {
  activateFontByCard: (font: FontItem) => Promise<void>
  activateFontsBatch: (fonts: FontItem[], label: string) => Promise<void>
  deactivateFontByCard: (font: FontItem) => Promise<void>
  deactivateFontsBatch: (fonts: FontItem[], label: string) => Promise<void>
} {
  async function activateFontByCard(font: FontItem): Promise<void> {
    if (options.activeOperationFontIds.current.has(font.id)) {
      options.setStatus(`正在处理：${fontDisplayName(font)}……`)
      return
    }

    const previous = options.library.fonts[font.id] || font
    const optimisticAt = new Date().toISOString()
    const changed = !previous.active && !isInstalled(previous)

    options.activeOperationFontIds.current.add(font.id)
    if (changed) {
      stateRuntime.setFontActiveRuntime(font.id, true, { activeSince: optimisticAt })
      stateRuntime.adjustDatabaseActiveCount(1)
    }
    options.setStatus(changed ? `已在界面标记为激活：${fontDisplayName(font)}，正在通知 Windows……` : `正在刷新激活状态：${fontDisplayName(font)}……`)

    try {
      const result = await options.hfm.activateFont(font)
      if (result.temporaryActivated) {
        stateRuntime.setFontActiveRuntime(font.id, true, {
          activeSince: previous.activeSince || optimisticAt,
          managedInstallPath: result.managedInstallPath,
          managedRegistryName: result.managedRegistryName
        })
      } else if (changed) {
        stateRuntime.setFontActiveRuntime(font.id, false)
        stateRuntime.adjustDatabaseActiveCount(-1)
      }
      options.setStatus(result.message)
    } catch (error) {
      if (changed) {
        stateRuntime.setFontActiveRuntime(font.id, false)
        stateRuntime.adjustDatabaseActiveCount(-1)
      }
      options.setStatus(`激活失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      options.activeOperationFontIds.current.delete(font.id)
    }
  }

  async function activateFontsBatch(fonts: FontItem[], label: string): Promise<void> {
    if (!fonts.length) {
      options.setStatus(`${label} 中没有字体。`)
      return
    }

    const unique = Array.from(new Map(fonts.map((font) => [font.id, options.library.fonts[font.id] || font])).values())
    const targets = batchActivationCandidates(unique).filter((font) => !options.activeOperationFontIds.current.has(font.id))
    const skippedInstalled = unique.filter((font) => isInstalled(font) && !isCleanWindowsDefaultFont(font)).length
    const skippedSystem = unique.filter(isCleanWindowsDefaultFont).length
    const skippedActive = unique.filter((font) => font.active).length
    const skippedBusy = unique.filter((font) => options.activeOperationFontIds.current.has(font.id)).length

    if (!targets.length) {
      options.setStatus(`${label} 没有需要临时激活的字体。已安装 ${skippedInstalled} 个，受保护 ${skippedSystem} 个，已激活 ${skippedActive} 个，处理中 ${skippedBusy} 个。`)
      return
    }

    let activated = 0
    let failed = 0
    let skippedInstalledFresh = 0

    if (typeof options.hfm.activateFonts === 'function') {
      const optimisticAt = new Date().toISOString()
      const optimisticUpdates: Record<string, { active: boolean; patch?: Partial<FontItem> }> = {}
      for (const font of targets) {
        options.activeOperationFontIds.current.add(font.id)
        optimisticUpdates[font.id] = { active: true, patch: { activeSince: optimisticAt } }
      }
      stateRuntime.setFontsActiveRuntimeBulk(optimisticUpdates)
      stateRuntime.adjustDatabaseActiveCount(targets.length)
      options.setStatus(`正在批量激活 ${label}：已合并为 1 次主进程任务和 1 次 Windows 字体刷新……`)

      try {
        const result = await options.hfm.activateFonts(targets)
        const finalUpdates: Record<string, { active: boolean; patch?: Partial<FontItem> }> = {}
        let rollback = 0
        for (const font of targets) {
          const itemResult = result.results[font.id]
          if (itemResult?.ok && itemResult.temporaryActivated) {
            finalUpdates[font.id] = {
              active: true,
              patch: {
                activeSince: optimisticAt,
                managedInstallPath: itemResult.managedInstallPath,
                managedRegistryName: itemResult.managedRegistryName
              }
            }
          } else {
            finalUpdates[font.id] = { active: false }
            rollback += 1
          }
        }
        stateRuntime.setFontsActiveRuntimeBulk(finalUpdates)
        if (rollback) stateRuntime.adjustDatabaseActiveCount(-rollback)
        options.setStatus(`${result.message} 跳过受保护 ${skippedSystem} 个，跳过已激活 ${skippedActive} 个，处理中 ${skippedBusy} 个。`)
      } catch (error) {
        const rollbackUpdates = Object.fromEntries(targets.map((font) => [font.id, { active: false }])) as Record<string, { active: boolean; patch?: Partial<FontItem> }>
        stateRuntime.setFontsActiveRuntimeBulk(rollbackUpdates)
        stateRuntime.adjustDatabaseActiveCount(-targets.length)
        options.setStatus(`批量激活失败：${error instanceof Error ? error.message : String(error)}`)
      } finally {
        for (const font of targets) options.activeOperationFontIds.current.delete(font.id)
      }
      return
    }

    options.setStatus(`已开始批量激活 ${label}：界面会先标记，Windows 后台逐个确认。`)

    for (const font of targets) {
      const optimisticAt = new Date().toISOString()
      options.activeOperationFontIds.current.add(font.id)
      stateRuntime.setFontActiveRuntime(font.id, true, { activeSince: optimisticAt })
      stateRuntime.adjustDatabaseActiveCount(1)
      options.setStatus(`正在批量激活 ${label}：${activated + failed + skippedInstalledFresh + 1} / ${targets.length} · ${fontDisplayName(font)}`)

      try {
        const result = await options.hfm.activateFont(font)
        if (result.temporaryActivated) {
          activated += 1
          stateRuntime.setFontActiveRuntime(font.id, true, {
            activeSince: optimisticAt,
            managedInstallPath: result.managedInstallPath,
            managedRegistryName: result.managedRegistryName
          })
        } else {
          skippedInstalledFresh += 1
          stateRuntime.setFontActiveRuntime(font.id, false)
          stateRuntime.adjustDatabaseActiveCount(-1)
        }
      } catch {
        failed += 1
        stateRuntime.setFontActiveRuntime(font.id, false)
        stateRuntime.adjustDatabaseActiveCount(-1)
      } finally {
        options.activeOperationFontIds.current.delete(font.id)
      }
    }

    options.setStatus(`批量激活完成：${label} 已激活 ${activated} 个，失败 ${failed} 个，跳过已安装 ${skippedInstalled + skippedInstalledFresh} 个，跳过受保护 ${skippedSystem} 个，跳过已激活 ${skippedActive} 个，处理中 ${skippedBusy} 个。`)
  }

  async function deactivateFontByCard(font: FontItem): Promise<void> {
    if (options.activeOperationFontIds.current.has(font.id)) {
      options.setStatus(`正在处理：${fontDisplayName(font)}……`)
      return
    }

    const previous = options.library.fonts[font.id] || font
    const changed = !!previous.active

    options.activeOperationFontIds.current.add(font.id)
    if (changed) {
      stateRuntime.setFontActiveRuntime(font.id, false)
      stateRuntime.adjustDatabaseActiveCount(-1)
    }
    options.setStatus(changed ? `已在界面取消激活：${fontDisplayName(font)}，正在清理 Windows 临时记录……` : `正在检查临时激活记录：${fontDisplayName(font)}……`)

    try {
      const result = await options.hfm.deactivateFont(font)
      stateRuntime.setFontActiveRuntime(font.id, false)
      options.setStatus(result.message)
    } catch (error) {
      if (changed) {
        stateRuntime.setFontActiveRuntime(font.id, true, {
          activeSince: previous.activeSince,
          managedInstallPath: previous.managedInstallPath,
          managedRegistryName: previous.managedRegistryName
        })
        stateRuntime.adjustDatabaseActiveCount(1)
      }
      options.setStatus(`取消激活失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      options.activeOperationFontIds.current.delete(font.id)
    }
  }

  async function deactivateFontsBatch(fonts: FontItem[], label: string): Promise<void> {
    const unique = Array.from(new Map(fonts.map((font) => [font.id, options.library.fonts[font.id] || font])).values())
    const targets = unique.filter((font) => font.active && !options.activeOperationFontIds.current.has(font.id))
    const skippedInactive = unique.filter((font) => !font.active).length
    const skippedBusy = unique.filter((font) => options.activeOperationFontIds.current.has(font.id)).length

    if (!targets.length) {
      options.setStatus(`${label} 没有需要取消激活的字体。未激活 ${skippedInactive} 个，处理中 ${skippedBusy} 个。`)
      return
    }

    if (typeof options.hfm.deactivateFonts === 'function') {
      const previousById = Object.fromEntries(targets.map((font) => [font.id, font])) as Record<string, FontItem>
      const optimisticUpdates = Object.fromEntries(targets.map((font) => [font.id, { active: false }])) as Record<string, { active: boolean; patch?: Partial<FontItem> }>
      for (const font of targets) options.activeOperationFontIds.current.add(font.id)
      stateRuntime.setFontsActiveRuntimeBulk(optimisticUpdates)
      stateRuntime.adjustDatabaseActiveCount(-targets.length)
      options.setStatus(`正在批量取消激活 ${label}：已合并为 1 次主进程清理任务……`)

      try {
        const result = await options.hfm.deactivateFonts(targets)
        const restoreUpdates: Record<string, { active: boolean; patch?: Partial<FontItem> }> = {}
        let restoreCount = 0
        for (const font of targets) {
          const itemResult = result.results[font.id]
          if (itemResult && itemResult.ok === false) {
            const previous = previousById[font.id]
            restoreUpdates[font.id] = {
              active: true,
              patch: {
                activeSince: previous.activeSince,
                managedInstallPath: previous.managedInstallPath,
                managedRegistryName: previous.managedRegistryName
              }
            }
            restoreCount += 1
          }
        }
        stateRuntime.setFontsActiveRuntimeBulk(restoreUpdates)
        if (restoreCount) stateRuntime.adjustDatabaseActiveCount(restoreCount)
        options.setStatus(`${result.message} 未激活 ${skippedInactive} 个，处理中 ${skippedBusy} 个。`)
      } catch (error) {
        const rollbackUpdates: Record<string, { active: boolean; patch?: Partial<FontItem> }> = {}
        for (const font of targets) {
          rollbackUpdates[font.id] = {
            active: true,
            patch: {
              activeSince: previousById[font.id]?.activeSince,
              managedInstallPath: previousById[font.id]?.managedInstallPath,
              managedRegistryName: previousById[font.id]?.managedRegistryName
            }
          }
        }
        stateRuntime.setFontsActiveRuntimeBulk(rollbackUpdates)
        stateRuntime.adjustDatabaseActiveCount(targets.length)
        options.setStatus(`批量取消激活失败：${error instanceof Error ? error.message : String(error)}`)
      } finally {
        for (const font of targets) options.activeOperationFontIds.current.delete(font.id)
      }
      return
    }

    let done = 0
    for (const font of targets) {
      options.setStatus(`正在批量取消激活 ${label}：${done + 1} / ${targets.length} · ${fontDisplayName(font)}`)
      await deactivateFontByCard(font)
      done += 1
    }
    options.setStatus(`批量取消激活完成：${label} 已处理 ${done} 个，未激活 ${skippedInactive} 个，处理中 ${skippedBusy} 个。`)
  }

  return {
    activateFontByCard,
    activateFontsBatch,
    deactivateFontByCard,
    deactivateFontsBatch
  }
}
