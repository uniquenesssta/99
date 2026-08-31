import type { FontItem,FontQueryPageResult,FontQueryResult,LibraryState } from '@shared/types'
import type { Dispatch,MutableRefObject,SetStateAction } from 'react'
import type { FontMetrics } from '../../appRuntime'
import { LAZY_INSTALL_DETECT_DELAY_MS,normalizeFontMetricsResult } from '../../appRuntime'
import { applyInstallCompareEntriesToLibrary } from '../../fontInstallStateRuntime'

export type RefreshInstallStatusOptions = {
  prefix?: string
  silentStart?: boolean
  force?: boolean
}

export type FontInstallStatusRuntimeOptions = {
  hfm: typeof window.hfm
  library: LibraryState
  lazyInstallQueue: MutableRefObject<FontItem[]>
  queuedLazyInstallIds: MutableRefObject<Set<string>>
  seenLazyInstallIds: MutableRefObject<Set<string>>
  knownInstallStatusIds: MutableRefObject<Set<string>>
  activeLazyInstallDetect: MutableRefObject<boolean>
  lazyInstallDetectTimerRef: MutableRefObject<number | null>
  lazyInstallDetectRunId: MutableRefObject<number>
  setLibrary: Dispatch<SetStateAction<LibraryState>>
  setStatus: Dispatch<SetStateAction<string>>
  setDatabasePageResult: Dispatch<SetStateAction<FontQueryPageResult | null>>
  setDatabaseQueryResult: Dispatch<SetStateAction<FontQueryResult | null>>
  setDatabaseRefreshToken: Dispatch<SetStateAction<number>>
  setDatabaseFontMetrics: Dispatch<SetStateAction<FontMetrics | null>>
}

export function createFontInstallStatusRuntime(options: FontInstallStatusRuntimeOptions): {
  refreshInstallStatus: (baseLibrary?: LibraryState, refreshOptions?: RefreshInstallStatusOptions) => Promise<number>
  startBackgroundInstallStatusRefresh: (prefix?: string, refreshOptions?: { force?: boolean }) => Promise<void>
  stopLazyInstallStatusDetect: () => void
  enqueueLazyInstallStatus: (fonts: FontItem[], priority?: boolean) => void
  scheduleLazyInstallStatus: (baseLibrary?: LibraryState, prefix?: string) => void
  scheduleLazyInstallStatusDetect: (delay?: number) => void
  processLazyInstallStatusQueue: (runId: number) => Promise<void>
  requestLazyInstallStatus: (font: FontItem, priority?: boolean) => void
} {
  function clearDatabaseInstallSnapshots(): void {
    options.knownInstallStatusIds.current.clear()
    options.setDatabasePageResult(null)
    options.setDatabaseQueryResult(null)
    options.setDatabaseRefreshToken((value) => value + 1)
  }

  function stopLazyInstallStatusDetect(): void {
    options.lazyInstallDetectRunId.current += 1
    options.lazyInstallQueue.current = []
    options.queuedLazyInstallIds.current.clear()
    options.seenLazyInstallIds.current.clear()
    options.activeLazyInstallDetect.current = false
    if (options.lazyInstallDetectTimerRef.current !== null) {
      window.clearTimeout(options.lazyInstallDetectTimerRef.current)
      options.lazyInstallDetectTimerRef.current = null
    }
  }

  async function refreshInstallStatus(baseLibrary = options.library, refreshOptions: RefreshInstallStatusOptions = {}): Promise<number> {
    const fonts = Object.values(baseLibrary.fonts || {})

    if (!refreshOptions.silentStart) options.setStatus(refreshOptions.force ? '正在强制刷新已安装状态……' : '正在检测系统已安装字体……')
    try {
      if (refreshOptions.force && typeof options.hfm.refreshInstallStatusIndex === 'function') {
        stopLazyInstallStatusDetect()
        const summary = await options.hfm.refreshInstallStatusIndex({ force: true })
        clearDatabaseInstallSnapshots()
        if (typeof options.hfm.getFontMetrics === 'function') {
          try {
            const metrics = await options.hfm.getFontMetrics()
            options.setDatabaseFontMetrics(normalizeFontMetricsResult(metrics))
          } catch {
            options.setDatabaseFontMetrics(null)
          }
        }
        const installedTotalCount = summary.installedTotalCount ?? summary.installedCount
        const message = `安装状态强制刷新完成：系统已安装总数 ${installedTotalCount} 个；字体库内已安装 ${summary.installedCount} 个，字体库未安装 ${summary.notInstalledCount} 个，匹配记录已更新 ${summary.updatedCount} 个，用时 ${Math.round(summary.elapsedMs / 1000)} 秒。`
        options.setStatus(refreshOptions.prefix ? `${refreshOptions.prefix} ${message}` : message)
        return summary.installedCount
      }

      if (!fonts.length) return 0
      const result = await options.hfm.compareFontsInstalled(fonts, { force: !!refreshOptions.force })
      options.setLibrary((prev) => applyInstallCompareEntriesToLibrary(
        prev,
        Object.entries(result),
        (id) => options.knownInstallStatusIds.current.add(id)
      ))
      const count = Object.values(result).filter((item) => item.installed).length
      const message = `系统字体检测完成：${count} 个字体被识别为已安装。`
      options.setStatus(refreshOptions.prefix ? `${refreshOptions.prefix} ${message}` : message)
      return count
    } catch (error) {
      options.setStatus(`检测失败：${error instanceof Error ? error.message : String(error)}`)
      return 0
    }
  }

  async function startBackgroundInstallStatusRefresh(prefix?: string, refreshOptions: { force?: boolean } = {}): Promise<void> {
    stopLazyInstallStatusDetect()
    const baseMessage = prefix ? `${prefix} 已安装状态转入后台刷新，可继续操作。` : '已安装状态转入后台刷新，可继续操作。'
    options.setStatus(baseMessage)

    if (typeof options.hfm.startInstallStatusRefreshIndex === 'function') {
      try {
        const result = await options.hfm.startInstallStatusRefreshIndex({ force: refreshOptions.force === true })
        options.setStatus(prefix ? `${prefix} ${result.message}` : result.message)
        return
      } catch (error) {
        options.setStatus(`启动后台刷新已安装状态失败：${error instanceof Error ? error.message : String(error)}`)
        return
      }
    }

    void refreshInstallStatus(options.library, { prefix, silentStart: true, force: refreshOptions.force === true })
  }

  function enqueueLazyInstallStatus(_fonts: FontItem[], _priority = false): void {
    // v1.0.2：已移除懒检查。缺失的安装状态不再自动后台补检。
  }

  function scheduleLazyInstallStatus(baseLibrary = options.library, _prefix?: string): void {
    const fonts = Object.values(baseLibrary.fonts || {}).filter((font) => !font.systemImported)
    stopLazyInstallStatusDetect()
    if (!fonts.length || typeof options.hfm.getInstallStatusIndex !== 'function') return

    const runId = ++options.lazyInstallDetectRunId.current
    void options.hfm.getInstallStatusIndex(fonts)
      .then(({ results }) => {
        if (runId !== options.lazyInstallDetectRunId.current) return
        const resultEntries = Object.entries(results || {})
        if (!resultEntries.length) return
        options.setLibrary((prev) => applyInstallCompareEntriesToLibrary(
          prev,
          resultEntries,
          (id) => options.knownInstallStatusIds.current.add(id)
        ))
      })
      .catch(() => undefined)
  }

  function scheduleLazyInstallStatusDetect(_delay = LAZY_INSTALL_DETECT_DELAY_MS): void {
    // v1.0.2：已移除懒检查。
  }

  async function processLazyInstallStatusQueue(_runId: number): Promise<void> {
    // v1.0.2：已移除懒检查。
  }

  function requestLazyInstallStatus(_font: FontItem, _priority = false): void {
    // v1.0.2：字体可见时不再自动检查安装状态。
  }

  return {
    refreshInstallStatus,
    startBackgroundInstallStatusRefresh,
    stopLazyInstallStatusDetect,
    enqueueLazyInstallStatus,
    scheduleLazyInstallStatus,
    scheduleLazyInstallStatusDetect,
    processLazyInstallStatusQueue,
    requestLazyInstallStatus
  }
}
