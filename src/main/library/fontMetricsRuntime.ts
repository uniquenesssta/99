import type { FontItem,FontMetricsResult,InstallCompareResult,LibraryShell } from '../../shared/types'
import { normalizePathForCacheCompare } from '../path/cachePath'
import type { FontSearchCategory } from './fontSearchRuntime'
import { normalizeFontFormat } from './fontSqliteMapper'

export type FontMetricsRuntimeOptions = {
  appWatchedFolders: () => Promise<string[]>
  loadSharedFontsForFolders: (folders: string[]) => Promise<FontItem[]>
  hydrateInstallStatusForFonts: (items: FontItem[]) => Promise<FontItem[]>
  getInstallStatusIndexSnapshot?: (items: FontItem[]) => Promise<{ results: Record<string, InstallCompareResult>; missingIds: string[] }>
  localTagsByFontIds: (fontIds: string[]) => Promise<Record<string, string[]>>
  openLibraryDb: () => Promise<any>
  loadLibraryShellFromSqlite: (db: any) => LibraryShell
  saveMetricsSnapshot: (name: string, value: unknown) => Promise<void>
  inferFontSearchCategory: (font: FontItem) => FontSearchCategory
  sharedFontMatchesPathPrefixes: (font: FontItem, folders: string[]) => boolean
}

export function defaultFontMetricsResult(): FontMetricsResult {
  return {
    total: 0,
    favoriteCount: 0,
    installedCount: 0,
    notInstalledCount: 0,
    installStatusKnownCount: 0,
    installStatusMissingCount: 0,
    installStatusReady: true,
    activeCount: 0,
    systemDefaultCount: 0,
    formatCounts: { ttf: 0, otf: 0, ttc: 0, otc: 0, unknown: 0 },
    categoryCounts: { all: 0, serif: 0, slabSerif: 0, sansSerif: 0, script: 0, monospace: 0, handwriting: 0, hei: 0, art: 0 },
    scriptCounts: {},
    collectionCounts: {},
    tagCounts: {},
    localTagCounts: {},
    sharedTagCounts: {},
    folderCounts: {},
    elapsedMs: 0
  }
}

export function fontDirectoryKeyForMetrics(filePath: string): string {
  const clean = normalizePathForCacheCompare(filePath || '')
  const index = clean.lastIndexOf('\\')
  return index > -1 ? clean.slice(0, index) : clean
}

export function fontFolderAncestorKeysForMetrics(filePath: string): string[] {
  const keys: string[] = []
  let current = fontDirectoryKeyForMetrics(filePath)

  while (current) {
    keys.push(current)
    const index = current.lastIndexOf('\\')
    if (index <= 2) break
    current = current.slice(0, index)
  }

  return keys
}

export function createFontMetricsRuntime(options: FontMetricsRuntimeOptions): {
  getFontMetricsFromLibrary: () => Promise<FontMetricsResult>
} {
  async function getFontMetricsFromLibrary(): Promise<FontMetricsResult> {
    const startedAt = Date.now()
    const metrics = defaultFontMetricsResult()
    const folders = await options.appWatchedFolders()
    const rawFonts = await options.loadSharedFontsForFolders(folders)
    let hydrated = rawFonts
    let installStatusKnownCount = 0
    let installStatusMissingCount = 0
    if (options.getInstallStatusIndexSnapshot) {
      try {
        const snapshot = await options.getInstallStatusIndexSnapshot(rawFonts)
        const missingIds = new Set(snapshot.missingIds || [])
        const results = snapshot.results || {}
        installStatusKnownCount = Object.keys(results).length
        installStatusMissingCount = missingIds.size
        hydrated = rawFonts.map((item) => {
          const result = results[item.id]
          if (!result) return { ...item, installStatusKnown: false }
          return {
            ...item,
            installStatusKnown: true,
            systemInstalled: result.installed && result.by !== 'managed',
            systemInstallMatches: result.matches || [],
            active: item.active || result.by === 'managed' || result.by === 'both'
          }
        })
      } catch {
        hydrated = await options.hydrateInstallStatusForFonts(rawFonts)
        installStatusKnownCount = hydrated.filter((font) => font.installStatusKnown).length
        installStatusMissingCount = Math.max(0, rawFonts.length - installStatusKnownCount)
      }
    } else {
      hydrated = await options.hydrateInstallStatusForFonts(rawFonts)
      installStatusKnownCount = hydrated.filter((font) => font.installStatusKnown).length
      installStatusMissingCount = Math.max(0, rawFonts.length - installStatusKnownCount)
    }
    const localTagsByFont = await options.localTagsByFontIds(hydrated.map((font) => font.id)).catch(() => ({} as Record<string, string[]>))
    const shell = options.loadLibraryShellFromSqlite(await options.openLibraryDb())

    metrics.total = hydrated.length
    metrics.categoryCounts.all = hydrated.length
    for (const collection of shell.collections || []) metrics.collectionCounts[collection.id] = 0
    for (const tag of shell.localTags || []) metrics.localTagCounts![tag] = 0
    for (const tag of shell.tags || []) metrics.sharedTagCounts![tag] = 0

    const folderIdByKey = new Map<string, string>()
    for (const folder of shell.folders || []) {
      metrics.folderCounts[folder] = 0
      folderIdByKey.set(normalizePathForCacheCompare(folder), folder)
    }
    for (const node of shell.folderNodes || []) {
      if (!node?.id) continue
      metrics.folderCounts[node.id] = 0
      folderIdByKey.set(normalizePathForCacheCompare(node.id), node.id)
    }

    let matchedInstalledCount = 0
    for (const font of hydrated) {
      const format = normalizeFontFormat(font.format)
      metrics.formatCounts[format] = (metrics.formatCounts[format] || 0) + 1
      const category = options.inferFontSearchCategory(font)
      metrics.categoryCounts[category] = (metrics.categoryCounts[category] || 0) + 1
      if (font.favorite) metrics.favoriteCount += 1
      if (font.active) metrics.activeCount += 1
      if (font.installStatusKnown && font.systemInstalled) matchedInstalledCount += 1
      if (font.installStatusKnown && !font.systemInstalled) metrics.notInstalledCount += 1

      for (const script of font.scripts || []) metrics.scriptCounts[script] = (metrics.scriptCounts[script] || 0) + 1
      for (const collectionId of font.collectionIds || []) metrics.collectionCounts[collectionId] = (metrics.collectionCounts[collectionId] || 0) + 1
      for (const tagName of localTagsByFont[font.id] || font.localTagNames || []) {
        metrics.localTagCounts![tagName] = (metrics.localTagCounts![tagName] || 0) + 1
      }
      for (const tagName of font.tagNames || []) {
        metrics.sharedTagCounts![tagName] = (metrics.sharedTagCounts![tagName] || 0) + 1
      }

      const countedFolders = new Set<string>()
      for (const key of fontFolderAncestorKeysForMetrics(font.path)) {
        const folderId = folderIdByKey.get(key)
        if (!folderId || countedFolders.has(folderId)) continue
        metrics.folderCounts[folderId] = (metrics.folderCounts[folderId] || 0) + 1
        countedFolders.add(folderId)
      }
      for (const folder of folders || []) {
        if (countedFolders.has(folder) || !options.sharedFontMatchesPathPrefixes(font, [folder])) continue
        metrics.folderCounts[folder] = (metrics.folderCounts[folder] || 0) + 1
        countedFolders.add(folder)
      }
    }

    metrics.tagCounts = {
      ...(metrics.sharedTagCounts || {}),
      ...(metrics.localTagCounts || {})
    }

    // 左侧“已安装/未安装”只统计已经完成安装状态快照的字体。
    // 未建立本机快照的字体属于未知状态，不能误算成“未安装”。
    // Windows 系统已安装总数只用于刷新完成提示/诊断，不参与库筛选计数。
    metrics.installStatusKnownCount = installStatusKnownCount
    metrics.installStatusMissingCount = installStatusMissingCount
    metrics.installStatusReady = installStatusMissingCount === 0
    metrics.installedCount = matchedInstalledCount
    metrics.notInstalledCount = Math.max(0, installStatusKnownCount - matchedInstalledCount)
    metrics.systemDefaultCount = 0
    metrics.elapsedMs = Date.now() - startedAt
    await options.saveMetricsSnapshot('font_metrics', metrics)
    return metrics
  }

  return { getFontMetricsFromLibrary }
}
