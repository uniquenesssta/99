import fs,{ promises as fsp } from 'node:fs';
import { basename,extname,join,parse } from 'node:path';
import type { FontItem,ScanResult,SystemInstalledFont } from '../../shared/types';
import { readFontRegistryItemsWithRegExe } from './fontRegistryCommandRuntime';

type ExecFileAsync = (file: string, args?: readonly string[], options?: Record<string, unknown>) => Promise<{ stdout: string; stderr: string }>

type FontMetadata = {
  family?: string
  fullName?: string
  postscriptName?: string
  style?: string
}

export type SystemInstalledFontsRuntime = ReturnType<typeof createSystemInstalledFontsRuntime>

export function createSystemInstalledFontsRuntime(deps: {
  execFileAsync: ExecFileAsync
  fontExtensions: Set<string>
  installedFontsTtlMs: number
  systemFontResolveBatchSize: number
  windowsFontsDir: () => string
  currentUserFontsDir: () => string
  resolveExistingFontFilePath: (rawPath?: string, options?: { logMissing?: boolean; logResolved?: boolean }) => Promise<string | undefined>
  hasValidFontSignature: (filePath: string) => Promise<boolean>
  fontItemFromPath: (filePath: string) => Promise<FontItem>
  readFontMetadata: (filePath: string) => FontMetadata
  runRustSystemInstalledFonts?: (input: { windowsFontsDir: string; currentUserFontsDir: string; extensions: string[]; includeNameCandidates?: boolean }) => Promise<{ items: SystemInstalledFont[] } | null>
  sha1: (value: string) => string
  normalizeCompareText: (value: string) => string
  isUsableInstalledNameCandidate: (value: string) => boolean
  withGlobalIo: <T>(label: string, fn: () => Promise<T>, options?: { priority?: 'foreground' | 'background'; storagePath?: string }) => Promise<T>
  delayToEventLoop: () => Promise<void>
  appendStartupLog: (message: string) => void
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
}) {
  let installedFontsMemoryCache: { at: number; items: SystemInstalledFont[] } | null = null
  let installedFontsReadInFlight: Promise<SystemInstalledFont[]> | null = null
  const platform = deps.platform || process.platform
  const env = deps.env || process.env

  function clearInstalledFontsMemoryCache(): void {
    installedFontsMemoryCache = null
  }

  function installedFontNameCandidatesFromMetadata(filePath: string): string[] {
    try {
      const meta = deps.readFontMetadata(filePath)
      return Array.from(new Set([
        meta.family,
        meta.fullName,
        meta.postscriptName,
        meta.style,
        parse(filePath).name,
        basename(filePath)
      ].map((value) => deps.normalizeCompareText(String(value || ''))).filter(deps.isUsableInstalledNameCandidate)))
    } catch {
      return []
    }
  }

  async function enrichInstalledFontRecordsWithMetadata(items: SystemInstalledFont[]): Promise<SystemInstalledFont[]> {
    const cache = new Map<string, string[]>()
    const result: SystemInstalledFont[] = []

    for (let index = 0; index < items.length; index += 1) {
      const item = items[index]
      const recordPath = item.path || item.value
      const normalizedPath = recordPath ? recordPath.toLowerCase().replace(/\\+/g, '/') : ''
      let nameCandidates: string[] = []
      if (normalizedPath && item.path && deps.fontExtensions.has(extname(item.path).toLowerCase()) && fs.existsSync(item.path)) {
        if (!cache.has(normalizedPath)) {
          let candidates: string[] = []
          try {
            candidates = installedFontNameCandidatesFromMetadata(item.path)
          } catch {
            candidates = []
          }
          cache.set(normalizedPath, candidates)
        }
        nameCandidates = cache.get(normalizedPath) || []
      }
      result.push(nameCandidates.length ? { ...item, nameCandidates } : item)
      if (index > 0 && index % 12 === 0) await deps.delayToEventLoop()
    }

    return result
  }

  async function getSystemInstalledFonts(): Promise<SystemInstalledFont[]> {
    if (platform !== 'win32') return []

    if (deps.runRustSystemInstalledFonts) {
      try {
        const rustResult = await deps.runRustSystemInstalledFonts({
          windowsFontsDir: deps.windowsFontsDir(),
          currentUserFontsDir: deps.currentUserFontsDir(),
          extensions: Array.from(deps.fontExtensions),
          includeNameCandidates: true
        })
        if (rustResult?.items?.length) {
          deps.appendStartupLog(`getSystemInstalledFonts used rust fast path: total=${rustResult.items.length}`)
          return rustResult.items
        }
      } catch (error) {
        deps.appendStartupLog(`getSystemInstalledFonts rust fast path failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }

    let registryItems: SystemInstalledFont[] = []

    try {
      registryItems = await readFontRegistryItemsWithRegExe({
        execFileAsync: deps.execFileAsync,
        windowsFontsDir: deps.windowsFontsDir,
        env,
        timeoutMs: 3500,
        maxBuffer: 1024 * 1024 * 8,
        appendStartupLog: deps.appendStartupLog,
        reason: 'getSystemInstalledFonts'
      })

      const resolvedRegistryItems: Array<SystemInstalledFont | null> = []
      let missingRegistryPaths = 0
      for (let index = 0; index < registryItems.length; index += deps.systemFontResolveBatchSize) {
        const batch = registryItems.slice(index, index + deps.systemFontResolveBatchSize)
        const resolvedBatch = await Promise.all(batch.map(async (item): Promise<SystemInstalledFont | null> => {
          const resolvedPath = await deps.resolveExistingFontFilePath(item.path || item.value)
          if (!resolvedPath) {
            missingRegistryPaths += 1
            return null
          }
          return {
            ...item,
            path: resolvedPath,
            fileName: basename(resolvedPath)
          }
        }))
        resolvedRegistryItems.push(...resolvedBatch)
        if (index > 0 && index % 12 === 0) await deps.delayToEventLoop()
      }
      registryItems = resolvedRegistryItems.filter((item): item is SystemInstalledFont => !!item)
      if (missingRegistryPaths > 0) {
        deps.appendStartupLog(`getSystemInstalledFonts skipped missing registry font paths: ${missingRegistryPaths}`)
      }
    } catch (error) {
      deps.appendStartupLog(`getSystemInstalledFonts registry failed: ${error instanceof Error ? error.message : String(error)}`)
    }

    const folderItems: SystemInstalledFont[] = []
    try {
      const folders: Array<{ dir: string; source: SystemInstalledFont['source'] }> = [
        { dir: deps.windowsFontsDir(), source: 'WindowsFontsFolder' },
        { dir: deps.currentUserFontsDir(), source: 'HKCU' }
      ]
      for (const folderInfo of folders) {
        if (!fs.existsSync(folderInfo.dir)) continue
        const entries = await fsp.readdir(folderInfo.dir, { withFileTypes: true })
        for (const entry of entries) {
          if (!entry.isFile()) continue
          if (!deps.fontExtensions.has(extname(entry.name).toLowerCase())) continue
          const full = join(folderInfo.dir, entry.name)
          folderItems.push({
            source: folderInfo.source,
            registryName: entry.name,
            value: full,
            path: full,
            fileName: entry.name
          })
        }
      }
    } catch (error) {
      deps.appendStartupLog(`getSystemInstalledFonts folder failed: ${error instanceof Error ? error.message : String(error)}`)
    }

    const merged = new Map<string, SystemInstalledFont>()
    for (const item of [...registryItems, ...folderItems]) {
      const key = `${item.source}|${item.registryName}|${item.value}`.toLowerCase()
      merged.set(key, item)
    }

    return enrichInstalledFontRecordsWithMetadata([...merged.values()])
  }

  async function getSystemInstalledFontsCached(force = false): Promise<SystemInstalledFont[]> {
    const now = Date.now()
    if (!force && installedFontsMemoryCache && now - installedFontsMemoryCache.at < deps.installedFontsTtlMs) {
      return installedFontsMemoryCache.items
    }

    if (installedFontsReadInFlight) {
      deps.appendStartupLog(`getSystemInstalledFontsCached joined in-flight read: force=${force}`)
      return installedFontsReadInFlight
    }

    installedFontsReadInFlight = deps.withGlobalIo('system:installed-fonts', () => getSystemInstalledFonts(), { priority: force ? 'foreground' : 'background' })
      .then((items) => {
        installedFontsMemoryCache = { at: Date.now(), items }
        return items
      })
      .finally(() => {
        installedFontsReadInFlight = null
      })

    return installedFontsReadInFlight
  }

  async function fontItemFromInstalledRecord(record: SystemInstalledFont): Promise<FontItem | null> {
    if (!record.path) return null

    const resolvedPath = await deps.resolveExistingFontFilePath(record.path)
    if (!resolvedPath) return null
    if (!deps.fontExtensions.has(extname(resolvedPath).toLowerCase())) return null

    const resolvedRecord: SystemInstalledFont = {
      ...record,
      path: resolvedPath,
      fileName: basename(resolvedPath)
    }

    try {
      await fsp.access(resolvedPath)
      if (!(await deps.hasValidFontSignature(resolvedPath))) return null

      const item = await deps.fontItemFromPath(resolvedPath)
      return {
        ...item,
        id: deps.sha1(`system-installed|${resolvedPath.toLowerCase()}|${record.registryName.toLowerCase()}`),
        favorite: false,
        collectionIds: [],
        tagNames: [],
        systemInstalled: true,
        systemInstallMatches: [resolvedRecord],
        active: false,
        systemImported: true
      }
    } catch {
      return null
    }
  }

  async function scanSystemInstalledFonts(): Promise<ScanResult> {
    const startedAt = Date.now()
    const errors: ScanResult['errors'] = []
    const fonts: FontItem[] = []
    const installed = await getSystemInstalledFontsCached(true)
    const seen = new Set<string>()

    let parsed = 0
    let skippedBad = 0

    for (const record of installed) {
      const key = (record.path || record.value || record.registryName).toLowerCase()
      if (!key || seen.has(key)) continue
      seen.add(key)

      try {
        const item = await fontItemFromInstalledRecord(record)
        if (!item) {
          skippedBad += 1
          continue
        }

        fonts.push(item)
        parsed += 1
      } catch (error) {
        errors.push({
          path: record.path || record.value || record.registryName,
          message: error instanceof Error ? error.message : String(error)
        })
      }
    }

    return {
      folders: [],
      fonts,
      errors,
      stats: {
        totalFiles: installed.length,
        parsed,
        fromCache: 0,
        skippedBad,
        errors: errors.length,
        durationMs: Date.now() - startedAt
      }
    }
  }

  return {
    clearInstalledFontsMemoryCache,
    getSystemInstalledFonts,
    getSystemInstalledFontsCached,
    fontItemFromInstalledRecord,
    scanSystemInstalledFonts
  }
}
