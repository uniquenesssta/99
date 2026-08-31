import type { FontRefreshRuntimeStats,NativeFontHelperPayload } from './fontRuntimeTypes'

export interface FontChangeBroadcastRuntimeOptions {
  appendStartupLog: (message: string) => void
  fontRefreshRuntimeStats: FontRefreshRuntimeStats
  runNativeFontHelper: (args: string[], options?: { timeout?: number; reason?: string; maxBuffer?: number }) => Promise<NativeFontHelperPayload | null>
  runRustFontChangeNotify?: (options?: { strong?: boolean; reason?: string }) => Promise<{ ok: boolean } | null>
}

export function createFontChangeBroadcastRuntime(options: FontChangeBroadcastRuntimeOptions) {
  const { appendStartupLog, fontRefreshRuntimeStats, runNativeFontHelper } = options

  async function broadcastFontChange(broadcastOptions: { reason?: string; blocking?: boolean } = {}): Promise<void> {
    if (process.platform !== 'win32') return

    const blocking = !!broadcastOptions.blocking
    const rustStartedAt = Date.now()
    const rustPayload = await options.runRustFontChangeNotify?.({ strong: blocking, reason: broadcastOptions.reason || (blocking ? 'broadcastFontChangeStrong' : 'broadcastFontChangeLight') })
    if (rustPayload?.ok) {
      fontRefreshRuntimeStats.lastBroadcastAt = Date.now()
      appendStartupLog(`rust WM_FONTCHANGE ${blocking ? 'strong' : 'light'} broadcast sent: ${broadcastOptions.reason || 'manual'}, ${Date.now() - rustStartedAt}ms`)
      return
    }

    const nativeStartedAt = Date.now()
    const nativePayload = await runNativeFontHelper(['notify', ...(blocking ? ['--strong'] : [])], {
      reason: broadcastOptions.reason || (blocking ? 'broadcastFontChangeStrong' : 'broadcastFontChangeLight'),
      timeout: blocking ? 1800 : 1000
    })
    if (nativePayload?.ok) {
      fontRefreshRuntimeStats.lastBroadcastAt = Date.now()
      appendStartupLog(`native WM_FONTCHANGE ${blocking ? 'strong' : 'light'} broadcast sent: ${broadcastOptions.reason || 'manual'}, ${Date.now() - nativeStartedAt}ms`)
      return
    }

    appendStartupLog(`native WM_FONTCHANGE ${blocking ? 'strong' : 'light'} broadcast unavailable; skipped PowerShell fallback: ${broadcastOptions.reason || 'manual'}`)
  }

  return { broadcastFontChange }
}
