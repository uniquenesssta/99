import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { FontRefreshRuntimeStats,FontResourceBatchResult,NativeFontHelperPayload } from './fontRuntimeTypes'

const execFileAsync = promisify(execFile)
const HKCU_FONT_REGISTRY_KEY = 'HKCU\\Software\\Microsoft\\Windows NT\\CurrentVersion\\Fonts'

export interface FontResourceSessionRuntimeOptions {
  appendStartupLog: (message: string) => void
  fontRefreshRuntimeStats: FontRefreshRuntimeStats
  runNativeFontHelper: (args: string[], options?: { timeout?: number; reason?: string; maxBuffer?: number }) => Promise<NativeFontHelperPayload | null>
  nativeFontHelperBatchResult: (payload: NativeFontHelperPayload | null) => FontResourceBatchResult | null
  runRustFontResourceAdd?: (paths: string[], options?: { notify?: boolean; reason?: string; strong?: boolean }) => Promise<FontResourceBatchResult | null>
  runRustFontResourceRemove?: (paths: string[], options?: { notify?: boolean; reason?: string; strong?: boolean }) => Promise<FontResourceBatchResult | null>
  runRustFontRegistryApply?: (records: Array<{ name: string; path: string }>) => Promise<{ ok: boolean; count: number; failed: number } | null>
  runRustFontRegistryDelete?: (names: string[]) => Promise<{ ok: boolean; count: number; failed: number } | null>
}

function failedFontResourceBatch(paths: string[], message: string): FontResourceBatchResult {
  const result: FontResourceBatchResult = {}
  for (const path of paths) result[path] = { ok: false, count: 0, message }
  return result
}

function requireSuccessfulFontResourceEntry(
  result: FontResourceBatchResult,
  filePath: string,
  source: 'rust' | 'native',
  operation: 'add' | 'remove'
) {
  const entry = result[filePath]
  if (!entry) {
    throw new Error(`${source} font resource ${operation} returned no result for ${filePath}`)
  }
  if (!entry.ok) {
    throw new Error(entry.message || `${source} font resource ${operation} failed for ${filePath}`)
  }
  return entry
}

async function runRegExe(args: string[], timeout: number): Promise<void> {
  await execFileAsync('reg', args, {
    windowsHide: true,
    timeout,
    maxBuffer: 1024 * 1024
  })
}

async function writeFontRegistryValuesHKCUWithRegExe(records: Array<{ name: string; path: string }>): Promise<void> {
  for (const record of records) {
    await runRegExe([
      'add',
      HKCU_FONT_REGISTRY_KEY,
      '/v',
      record.name,
      '/t',
      'REG_SZ',
      '/d',
      record.path,
      '/f'
    ], 3500)
  }
}

async function deleteFontRegistryValuesHKCUWithRegExe(names: string[]): Promise<void> {
  for (const name of names) {
    try {
      await runRegExe(['delete', HKCU_FONT_REGISTRY_KEY, '/v', name, '/f'], 3000)
    } catch {
      // Value may already be missing.
    }
  }
}

export function createFontResourceSessionRuntime(options: FontResourceSessionRuntimeOptions) {
  const { appendStartupLog, fontRefreshRuntimeStats, runNativeFontHelper, nativeFontHelperBatchResult } = options

  async function addFontResourceSessionBatch(filePaths: string[], batchOptions: { notify?: boolean; reason?: string } = {}): Promise<FontResourceBatchResult> {
    const uniquePaths = Array.from(new Set(filePaths.filter(Boolean)))
    if (!uniquePaths.length) return {}

    const rustResult = await options.runRustFontResourceAdd?.(uniquePaths, batchOptions)
    if (rustResult) {
      if (batchOptions.notify && Object.values(rustResult).some((entry) => entry.ok)) {
        fontRefreshRuntimeStats.lastBroadcastAt = Date.now()
        appendStartupLog(`rust font resource batch notify sent: ${batchOptions.reason || 'addFontResourceSessionBatch'}, count=${uniquePaths.length}`)
      }
      return rustResult
    }

    const nativePayload = await runNativeFontHelper(
      ['add', ...(batchOptions.notify ? ['--notify'] : []), ...uniquePaths],
      { reason: batchOptions.reason || 'addFontResourceSessionBatch', timeout: Math.max(5000, 800 + uniquePaths.length * 120) }
    )
    const nativeResult = nativeFontHelperBatchResult(nativePayload)
    if (nativeResult) {
      if (batchOptions.notify && Object.values(nativeResult).some((entry) => entry.ok)) {
        fontRefreshRuntimeStats.lastBroadcastAt = Date.now()
        appendStartupLog(`native font resource batch notify sent: ${batchOptions.reason || 'addFontResourceSessionBatch'}, count=${uniquePaths.length}`)
      }
      return nativeResult
    }

    const message = 'native font helper unavailable; AddFontResourceEx has no safe cmd.exe fallback'
    appendStartupLog(`native font helper unavailable for addFontResourceSessionBatch; skipped PowerShell fallback, count=${uniquePaths.length}`)
    return failedFontResourceBatch(uniquePaths, message)
  }

  async function removeFontResourceSessionBatch(filePaths: string[], batchOptions: { notify?: boolean; reason?: string } = {}): Promise<FontResourceBatchResult> {
    const uniquePaths = Array.from(new Set(filePaths.filter(Boolean)))
    if (!uniquePaths.length) return {}

    const rustResult = await options.runRustFontResourceRemove?.(uniquePaths, batchOptions)
    if (rustResult) {
      if (batchOptions.notify && Object.values(rustResult).some((entry) => entry.ok)) {
        fontRefreshRuntimeStats.lastBroadcastAt = Date.now()
        appendStartupLog(`rust font resource batch notify sent: ${batchOptions.reason || 'removeFontResourceSessionBatch'}, count=${uniquePaths.length}`)
      }
      return rustResult
    }

    const nativePayload = await runNativeFontHelper(
      ['remove', ...(batchOptions.notify ? ['--notify'] : []), ...uniquePaths],
      { reason: batchOptions.reason || 'removeFontResourceSessionBatch', timeout: Math.max(5000, 800 + uniquePaths.length * 120) }
    )
    const nativeResult = nativeFontHelperBatchResult(nativePayload)
    if (nativeResult) {
      if (batchOptions.notify && Object.values(nativeResult).some((entry) => entry.ok)) {
        fontRefreshRuntimeStats.lastBroadcastAt = Date.now()
        appendStartupLog(`native font resource batch notify sent: ${batchOptions.reason || 'removeFontResourceSessionBatch'}, count=${uniquePaths.length}`)
      }
      return nativeResult
    }

    const message = 'native font helper unavailable; RemoveFontResourceEx has no safe cmd.exe fallback'
    appendStartupLog(`native font helper unavailable for removeFontResourceSessionBatch; skipped PowerShell fallback, count=${uniquePaths.length}`)
    return failedFontResourceBatch(uniquePaths, message)
  }

  async function writeFontRegistryValuesHKCUBatch(records: Array<{ name: string; path: string }>): Promise<void> {
    const clean = records.filter((record) => record.name && record.path)
    if (!clean.length) return

    const rustResult = await options.runRustFontRegistryApply?.(clean)
    if (rustResult?.ok && Number(rustResult.failed || 0) === 0) {
      appendStartupLog(`rust font registry write ok: count=${rustResult.count}`)
      return
    }

    const nativeArgs = ['reg-add', ...clean.flatMap((record) => [record.name, record.path])]
    const nativePayload = await runNativeFontHelper(nativeArgs, {
      reason: 'writeFontRegistryValuesHKCUBatch',
      timeout: Math.max(5000, 800 + clean.length * 80)
    })
    if (nativePayload?.ok && Number(nativePayload.failed || 0) === 0) return

    appendStartupLog(`native font helper unavailable for registry write; using reg.exe fallback, count=${clean.length}`)
    await writeFontRegistryValuesHKCUWithRegExe(clean)
  }

  async function deleteFontRegistryValuesHKCUBatch(names: string[]): Promise<void> {
    const clean = Array.from(new Set(names.filter(Boolean)))
    if (!clean.length) return

    const rustResult = await options.runRustFontRegistryDelete?.(clean)
    if (rustResult?.ok) {
      appendStartupLog(`rust font registry delete ok: count=${rustResult.count}`)
      return
    }

    const nativePayload = await runNativeFontHelper(['reg-delete', ...clean], {
      reason: 'deleteFontRegistryValuesHKCUBatch',
      timeout: Math.max(5000, 800 + clean.length * 60)
    })
    if (nativePayload?.ok) return

    appendStartupLog(`native font helper unavailable for registry delete; using reg.exe fallback, count=${clean.length}`)
    await deleteFontRegistryValuesHKCUWithRegExe(clean)
  }

  async function addFontResourceSession(filePath: string, sessionOptions: { notify?: boolean; reason?: string } = {}): Promise<number> {
    const rustResult = await options.runRustFontResourceAdd?.([filePath], sessionOptions)
    if (rustResult != null) {
      const rustEntry = requireSuccessfulFontResourceEntry(rustResult, filePath, 'rust', 'add')
      if (sessionOptions.notify) {
        fontRefreshRuntimeStats.lastBroadcastAt = Date.now()
        appendStartupLog(`rust font resource notify sent: ${sessionOptions.reason || 'addFontResourceSession'}, path=${filePath}`)
      }
      return rustEntry.count > 0 ? rustEntry.count : 1
    }

    const nativePayload = await runNativeFontHelper(
      ['add', ...(sessionOptions.notify ? ['--notify'] : []), filePath],
      { reason: sessionOptions.reason || 'addFontResourceSession', timeout: 5000 }
    )
    const nativeResult = nativeFontHelperBatchResult(nativePayload)
    if (nativeResult != null) {
      const nativeEntry = requireSuccessfulFontResourceEntry(nativeResult, filePath, 'native', 'add')
      if (sessionOptions.notify) {
        fontRefreshRuntimeStats.lastBroadcastAt = Date.now()
        appendStartupLog(`native font resource notify sent: ${sessionOptions.reason || 'addFontResourceSession'}, path=${filePath}`)
      }
      return nativeEntry.count > 0 ? nativeEntry.count : 1
    }
    if (nativePayload != null) {
      throw new Error(nativePayload.message || `native font resource add returned no result for ${filePath}`)
    }

    const message = 'native font helper unavailable; AddFontResourceEx has no safe cmd.exe fallback'
    appendStartupLog(`native font helper unavailable for addFontResourceSession; skipped PowerShell fallback, path=${filePath}`)
    throw new Error(message)
  }

  async function removeFontResourceSession(filePath: string, sessionOptions: { notify?: boolean; reason?: string } = {}): Promise<void> {
    const rustResult = await options.runRustFontResourceRemove?.([filePath], sessionOptions)
    if (rustResult != null) {
      const rustEntry = requireSuccessfulFontResourceEntry(rustResult, filePath, 'rust', 'remove')
      if (sessionOptions.notify) {
        fontRefreshRuntimeStats.lastBroadcastAt = Date.now()
        appendStartupLog(`rust font resource notify sent: ${sessionOptions.reason || 'removeFontResourceSession'}, path=${filePath}`)
      }
      appendStartupLog(`rust RemoveFontResourceEx removed=${rustEntry.count || 0} path=${filePath}`)
      return
    }

    const nativePayload = await runNativeFontHelper(
      ['remove', ...(sessionOptions.notify ? ['--notify'] : []), filePath],
      { reason: sessionOptions.reason || 'removeFontResourceSession', timeout: 5000 }
    )
    const nativeResult = nativeFontHelperBatchResult(nativePayload)
    if (nativeResult != null) {
      const nativeEntry = requireSuccessfulFontResourceEntry(nativeResult, filePath, 'native', 'remove')
      if (sessionOptions.notify) {
        fontRefreshRuntimeStats.lastBroadcastAt = Date.now()
        appendStartupLog(`native font resource notify sent: ${sessionOptions.reason || 'removeFontResourceSession'}, path=${filePath}`)
      }
      appendStartupLog(`native RemoveFontResourceEx removed=${nativeEntry.count || 0} path=${filePath}`)
      return
    }
    if (nativePayload != null) {
      throw new Error(nativePayload.message || `native font resource remove returned no result for ${filePath}`)
    }

    const message = 'native font helper unavailable; RemoveFontResourceEx has no safe cmd.exe fallback'
    appendStartupLog(`native font helper unavailable for removeFontResourceSession; skipped PowerShell fallback, path=${filePath}`)
    throw new Error(message)
  }

  async function deleteRegistryValueHKCU(name: string): Promise<void> {
    try {
      await deleteFontRegistryValuesHKCUBatch([name])
    } catch {
      // 注册表项可能已不存在，视为可继续清理。
    }
  }

  return {
    addFontResourceSessionBatch,
    removeFontResourceSessionBatch,
    writeFontRegistryValuesHKCUBatch,
    deleteFontRegistryValuesHKCUBatch,
    addFontResourceSession,
    removeFontResourceSession,
    deleteRegistryValueHKCU
  }
}
