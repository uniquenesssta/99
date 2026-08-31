import { basename,join,resolve } from 'node:path'
import type { SystemInstalledFont } from '../../shared/types'

export type FontRegistryExecFileAsync = (
  file: string,
  args: string[],
  options?: Record<string, unknown>
) => Promise<{ stdout: string; stderr?: string }>

const FONT_REGISTRY_ROOTS: Array<{ root: string; source: SystemInstalledFont['source'] }> = [
  {
    root: 'HKCU\\Software\\Microsoft\\Windows NT\\CurrentVersion\\Fonts',
    source: 'HKCU'
  },
  {
    root: 'HKLM\\Software\\Microsoft\\Windows NT\\CurrentVersion\\Fonts',
    source: 'HKLM'
  }
]

export function possibleInstalledFontPathFromRegistryValue(
  rawValue: string,
  options: { windowsFontsDir: () => string; env?: NodeJS.ProcessEnv }
): string | undefined {
  if (!rawValue) return undefined

  const env = options.env || process.env
  const value = rawValue.replace(/^"|"$/g, '')
  if (/^[a-zA-Z]:\\/.test(value) || value.startsWith('\\\\')) return value

  if (value.includes('\\')) {
    const maybeWindows = join(env.WINDIR || 'C:\\Windows', value)
    return resolve(maybeWindows)
  }

  return join(options.windowsFontsDir(), value)
}

export function parseFontRegistryQueryOutput(
  stdout: string,
  source: SystemInstalledFont['source'],
  options: { windowsFontsDir: () => string; env?: NodeJS.ProcessEnv }
): SystemInstalledFont[] {
  const items: SystemInstalledFont[] = []
  for (const line of String(stdout || '').split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || /^HKEY_/i.test(trimmed)) continue

    const match = trimmed.match(/^(.*?)\s{2,}REG_\w+\s{2,}(.*)$/)
    if (!match) continue

    const registryName = String(match[1] || '').trim()
    const value = String(match[2] || '').trim()
    if (!registryName || !value) continue

    const path = possibleInstalledFontPathFromRegistryValue(value, options)
    items.push({
      source,
      registryName,
      value,
      path,
      fileName: path ? basename(path) : basename(value)
    })
  }
  return items
}

export async function readFontRegistryItemsWithRegExe(options: {
  execFileAsync: FontRegistryExecFileAsync
  windowsFontsDir: () => string
  env?: NodeJS.ProcessEnv
  timeoutMs?: number
  maxBuffer?: number
  appendStartupLog?: (message: string) => void
  reason?: string
}): Promise<SystemInstalledFont[]> {
  if (process.platform !== 'win32') return []

  const items: SystemInstalledFont[] = []
  for (const { root, source } of FONT_REGISTRY_ROOTS) {
    try {
      const { stdout } = await options.execFileAsync('reg', ['query', root], {
        windowsHide: true,
        timeout: options.timeoutMs || 3500,
        maxBuffer: options.maxBuffer || 1024 * 1024 * 4
      })
      items.push(...parseFontRegistryQueryOutput(stdout, source, options))
    } catch (error) {
      options.appendStartupLog?.(
        `${options.reason || 'font registry'} reg query skipped ${source}: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }
  return items
}
