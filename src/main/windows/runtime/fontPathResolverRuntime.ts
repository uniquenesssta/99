import fs,{ promises as fsp } from 'node:fs'
import { basename,extname,join,parse,resolve } from 'node:path'
import { TextDecoder } from 'node:util'

interface FontPathResolveEntry {
  name: string
  path: string
  key: string
  stemKey: string
  mojibakeKey: string
  mojibakeStemKey: string
}

export interface FontPathResolverRuntimeOptions {
  fontExtensions: Set<string>
  appendStartupLog: (message: string) => void
  windowsFontsDir: () => string
  currentUserFontsDir: () => string
}

const gbkDecoder = new TextDecoder('gbk')

function mojibakeCompareKey(value: string): string {
  return String(value || '')
    .replace(/[\uFFFD\u20AC]/g, '')
    .replace(/\s+/g, '')
    .toLowerCase()
}

function utf8NameAsGbkMojibake(value: string): string {
  try {
    return gbkDecoder.decode(Buffer.from(value, 'utf8'))
  } catch {
    return ''
  }
}

function looksLikeMojibakeFontName(value: string): boolean {
  return /[鍗氭泤杞粏绮€]/.test(value) || value.includes('\u20AC') || value.includes('\uFFFD')
}

export function createFontPathResolverRuntime(options: FontPathResolverRuntimeOptions) {
  const { fontExtensions, appendStartupLog, windowsFontsDir, currentUserFontsDir } = options
  let fontPathResolveCache: { at: number; entries: FontPathResolveEntry[] } | null = null
  const missingFontPathResolveCache = new Map<string, number>()

  function rememberMissingFontPath(value: string): void {
    if (!value) return
    missingFontPathResolveCache.set(value.toLowerCase(), Date.now())
  }

  function recentlyMissingFontPath(value: string): boolean {
    if (!value) return false
    const key = value.toLowerCase()
    const at = missingFontPathResolveCache.get(key)
    if (!at) return false
    if (Date.now() - at > 60_000) {
      missingFontPathResolveCache.delete(key)
      return false
    }
    return true
  }

  async function getFontPathResolveEntries(): Promise<FontPathResolveEntry[]> {
    const now = Date.now()
    if (fontPathResolveCache && now - fontPathResolveCache.at < 60_000) {
      return fontPathResolveCache.entries
    }

    const folders = [windowsFontsDir()]
    try {
      folders.push(currentUserFontsDir())
    } catch {
      // ignore
    }

    const entries: FontPathResolveEntry[] = []

    for (const folder of Array.from(new Set(folders))) {
      try {
        if (!fs.existsSync(folder)) continue
        const items = await fsp.readdir(folder, { withFileTypes: true })
        for (const item of items) {
          if (!item.isFile()) continue
          if (!fontExtensions.has(extname(item.name).toLowerCase())) continue

          const fullPath = join(folder, item.name)
          const mojibakeName = utf8NameAsGbkMojibake(item.name)
          const mojibakeStem = utf8NameAsGbkMojibake(parse(item.name).name)

          entries.push({
            name: item.name,
            path: fullPath,
            key: mojibakeCompareKey(item.name),
            stemKey: mojibakeCompareKey(parse(item.name).name),
            mojibakeKey: mojibakeCompareKey(mojibakeName),
            mojibakeStemKey: mojibakeCompareKey(mojibakeStem)
          })
        }
      } catch (error) {
        appendStartupLog(`font path resolve scan failed: ${folder} ${error instanceof Error ? error.message : String(error)}`)
      }
    }

    fontPathResolveCache = { at: now, entries }
    return entries
  }

  function possibleAbsolutePath(rawValue: string): string | undefined {
    if (!rawValue) return undefined

    const value = rawValue.replace(/^"|"$/g, '')
    if (/^[a-zA-Z]:\\/.test(value) || value.startsWith('\\\\')) return value

    if (value.includes('\\')) {
      const maybeWindows = join(process.env.WINDIR || 'C:\\Windows', value)
      return resolve(maybeWindows)
    }

    return join(windowsFontsDir(), value)
  }

  async function resolveExistingFontFilePath(rawPath?: string, resolveOptions: { logMissing?: boolean; logResolved?: boolean } = {}): Promise<string | undefined> {
    if (!rawPath) return undefined

    const candidate = possibleAbsolutePath(rawPath) || rawPath

    if (recentlyMissingFontPath(candidate) || recentlyMissingFontPath(rawPath)) {
      return undefined
    }

    try {
      await fsp.access(candidate)
      return candidate
    } catch {
      // continue
    }

    const baseName = basename(candidate)
    const stem = parse(baseName).name
    const targetKey = mojibakeCompareKey(baseName)
    const targetStemKey = mojibakeCompareKey(stem)

    const entries = await getFontPathResolveEntries()

    const exact = entries.find((entry) => entry.key === targetKey || entry.stemKey === targetStemKey)
    if (exact) {
      if (resolveOptions.logResolved) appendStartupLog(`font path resolved by exact filename: ${rawPath} -> ${exact.path}`)
      return exact.path
    }

    const mojibake = entries.find((entry) => entry.mojibakeKey === targetKey || entry.mojibakeStemKey === targetStemKey)
    if (mojibake) {
      if (resolveOptions.logResolved) appendStartupLog(`font path resolved by mojibake filename: ${rawPath} -> ${mojibake.path}`)
      return mojibake.path
    }

    if (looksLikeMojibakeFontName(baseName) && targetStemKey.length >= 4) {
      const fuzzy = entries.find((entry) => {
        if (entry.mojibakeStemKey.length < 4) return false
        return entry.mojibakeStemKey.includes(targetStemKey) || targetStemKey.includes(entry.mojibakeStemKey)
      })

      if (fuzzy) {
        if (resolveOptions.logResolved) appendStartupLog(`font path resolved by fuzzy mojibake filename: ${rawPath} -> ${fuzzy.path}`)
        return fuzzy.path
      }
    }

    rememberMissingFontPath(candidate)
    rememberMissingFontPath(rawPath)
    if (resolveOptions.logMissing) appendStartupLog(`font path still missing after resolve: ${rawPath}`)
    return undefined
  }

  return { resolveExistingFontFilePath }
}
