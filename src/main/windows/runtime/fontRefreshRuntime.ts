import { promises as fsp } from 'node:fs'
import { join } from 'node:path'
import type { FontRefreshMode,FontRefreshRuntimeStats,PendingFontRefreshRequest } from './fontRuntimeTypes'

export interface FontRefreshRuntimeOptions {
  appName: string
  appendStartupLog: (message: string) => void
  currentUserFontsDir: () => string
  broadcastFontChange: (options?: { reason?: string; blocking?: boolean }) => Promise<void>
  fontRefreshRuntimeStats: FontRefreshRuntimeStats
}

const FONT_REFRESH_RECENT_WINDOW_MS = 650

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function fontRefreshModeRank(mode: FontRefreshMode): number {
  if (mode === 'strong') return 3
  if (mode === 'standard') return 2
  return 1
}

function strongerFontRefreshMode(a: FontRefreshMode, b: FontRefreshMode): FontRefreshMode {
  return fontRefreshModeRank(a) >= fontRefreshModeRank(b) ? a : b
}

function mergeFontRefreshReason(current: string, next: string): string {
  if (!current) return next
  if (current.includes(next)) return current
  return `${current}+${next}`.slice(0, 180)
}

export function createFontRefreshRuntime(options: FontRefreshRuntimeOptions) {
  const { appName, appendStartupLog, currentUserFontsDir, broadcastFontChange, fontRefreshRuntimeStats } = options
  let fontRefreshQueueTimer: ReturnType<typeof setTimeout> | null = null
  let fontRefreshInFlight: Promise<void> | null = null
  let pendingFontRefreshRequest: PendingFontRefreshRequest | null = null

  function logFontRefreshTimerError(reason: string, error: unknown): void {
    fontRefreshRuntimeStats.failed += 1
    fontRefreshRuntimeStats.inFlight = false
    fontRefreshRuntimeStats.pending = !!pendingFontRefreshRequest
    appendStartupLog(`font refresh timer failed: ${reason}, ${error instanceof Error ? error.stack || error.message : String(error)}`)
  }

  function runFontRefreshQueueSafely(reason: string): void {
    try {
      void runFontRefreshQueue().catch((error) => {
        logFontRefreshTimerError(reason, error)
      })
    } catch (error) {
      logFontRefreshTimerError(reason, error)
    }
  }

  async function triggerFontDirectoryChange(): Promise<void> {
    if (process.platform !== 'win32') return

    const dirs = [currentUserFontsDir()]
    const windowsFonts = process.env.SystemRoot ? join(process.env.SystemRoot, 'Fonts') : 'C:\\Windows\\Fonts'

    // 只触发当前用户字体目录，不写 C:\Windows\Fonts，避免权限和资源管理器风险。
    for (const dir of dirs) {
      try {
        await fsp.mkdir(dir, { recursive: true })
        const marker = join(dir, `${appName}_REFRESH_${process.pid}_${Date.now().toString(36)}.tmp`)
        await fsp.writeFile(marker, `refresh ${new Date().toISOString()}`, 'utf-8')
        await fsp.unlink(marker)
        appendStartupLog(`font directory change triggered: ${dir}`)
      } catch (error) {
        appendStartupLog(`font directory change trigger failed: ${dir} ${error instanceof Error ? error.message : String(error)}`)
      }
    }

    // 只读取一次系统字体目录；不写入系统字体目录。
    try {
      await fsp.readdir(windowsFonts)
    } catch {
      // ignore
    }
  }

  function requestFontRefresh(reason: string, mode: FontRefreshMode = 'standard', refreshOptions: { delayMs?: number; force?: boolean } = {}): void {
    if (process.platform !== 'win32') return

    fontRefreshRuntimeStats.requested += 1
    if (pendingFontRefreshRequest) {
      fontRefreshRuntimeStats.coalesced += 1
      pendingFontRefreshRequest = {
        reason: mergeFontRefreshReason(pendingFontRefreshRequest.reason, reason),
        mode: strongerFontRefreshMode(pendingFontRefreshRequest.mode, mode),
        requestedAt: pendingFontRefreshRequest.requestedAt,
        force: pendingFontRefreshRequest.force || !!refreshOptions.force
      }
    } else {
      pendingFontRefreshRequest = {
        reason,
        mode,
        requestedAt: Date.now(),
        force: !!refreshOptions.force
      }
    }
    fontRefreshRuntimeStats.pending = true

    if (fontRefreshQueueTimer) clearTimeout(fontRefreshQueueTimer)
    fontRefreshQueueTimer = setTimeout(() => {
      fontRefreshQueueTimer = null
      runFontRefreshQueueSafely(reason)
    }, Math.max(0, refreshOptions.delayMs ?? 80))
    if (typeof fontRefreshQueueTimer.unref === 'function') fontRefreshQueueTimer.unref()
  }

  async function runFontRefreshQueue(): Promise<void> {
    if (fontRefreshInFlight) return fontRefreshInFlight

    fontRefreshInFlight = (async () => {
      while (pendingFontRefreshRequest) {
        const request = pendingFontRefreshRequest
        pendingFontRefreshRequest = null
        fontRefreshRuntimeStats.pending = false
        fontRefreshRuntimeStats.inFlight = true
        await performFontRefreshRequest(request)
        fontRefreshRuntimeStats.inFlight = false
      }
    })().finally(() => {
      fontRefreshInFlight = null
      fontRefreshRuntimeStats.inFlight = false
      if (pendingFontRefreshRequest) runFontRefreshQueueSafely('followup')
    })

    return fontRefreshInFlight
  }

  async function performFontRefreshRequest(request: PendingFontRefreshRequest): Promise<void> {
    const startedAt = Date.now()
    const recentGap = Date.now() - fontRefreshRuntimeStats.lastBroadcastAt

    if (!request.force && request.mode !== 'strong' && recentGap >= 0 && recentGap < FONT_REFRESH_RECENT_WINDOW_MS) {
      fontRefreshRuntimeStats.skippedRecent += 1
      appendStartupLog(`font refresh skipped recent broadcast: ${request.reason}, mode=${request.mode}, gap=${recentGap}ms`)
      return
    }

    try {
      appendStartupLog(`font refresh started: ${request.reason}, mode=${request.mode}`)
      if (request.mode === 'light') {
        await broadcastFontChange({ reason: request.reason, blocking: false })
      } else if (request.mode === 'standard') {
        await triggerFontDirectoryChange()
        await broadcastFontChange({ reason: request.reason, blocking: false })
      } else {
        await triggerFontDirectoryChange()
        await broadcastFontChange({ reason: request.reason, blocking: true })
        await sleep(220)
        await broadcastFontChange({ reason: `${request.reason}-tail`, blocking: false })
      }

      fontRefreshRuntimeStats.completed += 1
      fontRefreshRuntimeStats.lastReason = request.reason
      fontRefreshRuntimeStats.lastMode = request.mode
      fontRefreshRuntimeStats.lastElapsedMs = Date.now() - startedAt
      appendStartupLog(`font refresh finished: ${request.reason}, mode=${request.mode}, ${fontRefreshRuntimeStats.lastElapsedMs}ms`)
    } catch (error) {
      fontRefreshRuntimeStats.failed += 1
      appendStartupLog(`font refresh failed: ${request.reason}, mode=${request.mode}, ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  function scheduleDelayedFontRefresh(reason: string, delayMs = 800): void {
    requestFontRefresh(reason, 'light', { delayMs })
  }

  function scheduleBackgroundFontRefreshTail(reason: string, delayMs = 120): void {
    requestFontRefresh(reason, 'standard', { delayMs })
  }

  async function interactiveFontRefresh(reason: string): Promise<void> {
    const startedAt = Date.now()
    requestFontRefresh(reason, 'standard', { delayMs: 80 })
    appendStartupLog(`interactive font refresh queued: ${reason}, ${Date.now() - startedAt}ms`)
  }

  async function advancedFontRefresh(reason: string): Promise<void> {
    const startedAt = Date.now()
    appendStartupLog(`advanced font refresh started: ${reason}`)
    await performFontRefreshRequest({ reason, mode: 'strong', requestedAt: Date.now(), force: true })
    appendStartupLog(`advanced font refresh returned: ${reason}, ${Date.now() - startedAt}ms`)
  }

  return {
    requestFontRefresh,
    scheduleDelayedFontRefresh,
    scheduleBackgroundFontRefreshTail,
    interactiveFontRefresh,
    advancedFontRefresh
  }
}
