import fs,{ promises as fsp } from 'node:fs'
import { extname,join } from 'node:path'
import type { SystemInstalledFont } from '../../../shared/types'
import { readFontRegistryItemsWithRegExe } from '../fontRegistryCommandRuntime'
import type { InstallStatusRefreshRuntimeDeps } from './installStatusRefreshTypes'

export function createInstalledFontsLightweightReader(deps: InstallStatusRefreshRuntimeDeps) {
  async function readSystemInstalledFontsLightweight(): Promise<SystemInstalledFont[]> {
    if (process.platform !== 'win32') return []

    const startedAt = Date.now()
    if (deps.runRustSystemInstalledFonts) {
      try {
        const rustResult = await deps.runRustSystemInstalledFonts({
          windowsFontsDir: deps.windowsFontsDir(),
          currentUserFontsDir: deps.currentUserFontsDir(),
          extensions: Array.from(deps.fontExtensions),
          includeNameCandidates: false
        })
        if (rustResult?.items) {
          deps.appendStartupLog(
            `system installed fonts lightweight read by rust: total=${rustResult.items.length}, durationMs=${Date.now() - startedAt}`
          )
          return rustResult.items
        }
      } catch (error) {
        deps.appendStartupLog(
          `system installed fonts lightweight rust read failed: ${error instanceof Error ? error.message : String(error)}`
        )
      }
    }

    const registryItems: SystemInstalledFont[] = []
    const folderItems: SystemInstalledFont[] = []

    try {
      registryItems.push(...await readFontRegistryItemsWithRegExe({
        execFileAsync: deps.execFileAsync,
        windowsFontsDir: deps.windowsFontsDir,
        timeoutMs: 2500,
        maxBuffer: 1024 * 1024 * 4,
        appendStartupLog: deps.appendStartupLog,
        reason: 'system installed fonts lightweight'
      }))
    } catch (error) {
      deps.appendStartupLog(
        `system installed fonts lightweight registry read failed: ${error instanceof Error ? error.message : String(error)}`
      )
    }

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
        await deps.delayToEventLoop()
      }
    } catch (error) {
      deps.appendStartupLog(
        `system installed fonts lightweight folder read failed: ${error instanceof Error ? error.message : String(error)}`
      )
    }

    const merged = new Map<string, SystemInstalledFont>()
    for (const item of [...registryItems, ...folderItems]) {
      const key = `${item.source}|${item.registryName}|${item.value}`.toLowerCase()
      merged.set(key, item)
    }
    const items = [...merged.values()]
    deps.appendStartupLog(
      `system installed fonts lightweight read finished: total=${items.length}, registry=${registryItems.length}, folder=${folderItems.length}, durationMs=${Date.now() - startedAt}`
    )
    return items
  }

  return { readSystemInstalledFontsLightweight }
}
