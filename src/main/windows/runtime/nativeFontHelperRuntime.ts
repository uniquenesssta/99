import { app } from 'electron'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import { dirname,join } from 'node:path'
import { promisify } from 'node:util'
import { parseSqliteJson } from '../../db/sqliteHelpers'
import type { NativeFontHelperPayload } from './fontRuntimeTypes'

const execFileAsync = promisify(execFile)

export function createNativeFontHelperRuntime(options: { appendStartupLog: (message: string) => void }) {
  const { appendStartupLog } = options
  let cachedNativeFontHelperPath: string | null | undefined
  let nativeFontHelperFailureCount = 0

  function nativeFontHelperCandidates(): string[] {
    const name = 'hfm-font-helper.exe'
    const candidates = [
      join(process.resourcesPath || '', 'native', name),
      join(process.cwd(), 'build', 'native', name),
      join(app.getAppPath?.() || '', 'build', 'native', name),
      join(dirname(process.execPath || ''), 'resources', 'native', name),
      join(dirname(process.execPath || ''), 'native', name)
    ]
    return Array.from(new Set(candidates.filter(Boolean)))
  }

  function nativeFontHelperPath(): string | null {
    if (process.platform !== 'win32') return null
    if (cachedNativeFontHelperPath !== undefined) return cachedNativeFontHelperPath

    cachedNativeFontHelperPath = null
    for (const candidate of nativeFontHelperCandidates()) {
      try {
        if (candidate && fs.existsSync(candidate)) {
          cachedNativeFontHelperPath = candidate
          appendStartupLog(`native font helper found: ${candidate}`)
          break
        }
      } catch {
        // ignore candidate errors
      }
    }
    if (!cachedNativeFontHelperPath) appendStartupLog('native font helper not found; PowerShell-free mode has no cmd-compatible Win32 font API fallback')
    return cachedNativeFontHelperPath
  }

  async function runNativeFontHelper(args: string[], runOptions: { timeout?: number; reason?: string; maxBuffer?: number } = {}): Promise<NativeFontHelperPayload | null> {
    const helper = nativeFontHelperPath()
    if (!helper) return null

    const startedAt = Date.now()
    try {
      const { stdout } = await execFileAsync(helper, args, {
        windowsHide: true,
        timeout: runOptions.timeout ?? 5000,
        maxBuffer: runOptions.maxBuffer ?? 4 * 1024 * 1024
      })
      const parsed = parseSqliteJson<NativeFontHelperPayload>(stdout.trim(), { ok: false, message: 'native helper returned invalid JSON' })
      appendStartupLog(`native font helper ok: ${runOptions.reason || args[0] || 'command'}, ${Date.now() - startedAt}ms`)
      nativeFontHelperFailureCount = 0
      return parsed
    } catch (error) {
      nativeFontHelperFailureCount += 1
      appendStartupLog(`native font helper failed: ${runOptions.reason || args[0] || 'command'} ${error instanceof Error ? error.message : String(error)}`)
      return null
    }
  }

  function nativeFontHelperBatchResult(payload: NativeFontHelperPayload | null): Record<string, { ok: boolean; count: number; message: string }> | null {
    if (!payload || !Array.isArray(payload.results)) return null
    const result: Record<string, { ok: boolean; count: number; message: string }> = {}
    for (const row of payload.results) {
      const path = String(row.path || row.Path || '')
      if (!path) continue
      result[path] = {
        ok: !!(row.ok ?? row.Ok),
        count: Number(row.count ?? row.Count ?? 0),
        message: String(row.message || row.Message || '')
      }
    }
    return result
  }

  return { runNativeFontHelper, nativeFontHelperBatchResult }
}
