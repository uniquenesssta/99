import { resolve } from 'node:path'
import { setImmediate as yieldImmediate } from 'node:timers/promises'
import { mergedIndexLocalFavoriteExpr, rootIndexRuntimeFontIdExpr, sqliteLiteral } from '../indexing/root-query/rootIndexQuerySharedSql'
import type { FontItem,FontMetricsResult,InstallCompareResult,LibraryShell } from '../../shared/types'
import { normalizePathForCacheCompare } from '../path/cachePath'
import type { FontSearchCategory } from './fontSearchRuntime'
import { normalizeFontFormat } from './fontSqliteMapper'
import { assertFontQueryActive, rethrowFontQuerySuperseded } from './fontQueryTaskRuntime'

const FONT_METRICS_CHUNK_SIZE = 128

async function yieldFontMetricsTurn(): Promise<void> {
  assertFontQueryActive()
  await yieldImmediate()
  assertFontQueryActive()
}

async function forEachFontMetricsChunk<T>(items: T[], visit: (item: T) => void): Promise<void> {
  assertFontQueryActive()
  for (let offset = 0; offset < items.length; offset += FONT_METRICS_CHUNK_SIZE) {
    const end = Math.min(offset + FONT_METRICS_CHUNK_SIZE, items.length)
    for (let index = offset; index < end; index += 1) visit(items[index])
    assertFontQueryActive()
    if (end < items.length) await yieldFontMetricsTurn()
  }
}

async function countKnownInstallStatus(fonts: FontItem[]): Promise<number> {
  let count = 0
  await forEachFontMetricsChunk(fonts, font => { if (font.installStatusKnown) count += 1 })
  return count
}

export type FontMetricsRuntimeOptions = {
  appWatchedFolders: () => Promise<string[]>
  loadSharedFontsForFolders: (folders: string[]) => Promise<FontItem[]>
  hydrateInstallStatusForFonts: (items: FontItem[]) => Promise<FontItem[]>
  getInstallStatusIndexSnapshot?: (items: FontItem[]) => Promise<{ results: Record<string, InstallCompareResult>; missingIds: string[] }>
  hydrateLocalTagsForFonts: (items: FontItem[]) => Promise<FontItem[]>
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
    assertFontQueryActive()
    const startedAt = Date.now()
    const metrics = defaultFontMetricsResult()
    const folders = await options.appWatchedFolders()
    assertFontQueryActive()
    const rawFonts = await options.loadSharedFontsForFolders(folders)
    await yieldFontMetricsTurn()
    let hydrated = rawFonts
    let installStatusKnownCount = 0
    let installStatusMissingCount = 0
    if (options.getInstallStatusIndexSnapshot) {
      try {
        const snapshot = await options.getInstallStatusIndexSnapshot(rawFonts)
        await yieldFontMetricsTurn()
        const missingIds = new Set(snapshot.missingIds || [])
        const results = snapshot.results || {}
        await forEachFontMetricsChunk(Object.values(results), result => { if (result.known !== false) installStatusKnownCount += 1 })
        installStatusMissingCount = missingIds.size
        hydrated = []
        await forEachFontMetricsChunk(rawFonts, (item) => {
          const result = results[item.id]
          hydrated.push(!result ? { ...item, active: false, installStatusKnown: false, systemInstalled: false, systemInstallMatches: [] } : {
            ...item,
            installStatusKnown: result.known !== false,
            systemInstalled: result.known !== false && result.installed && result.by !== 'managed',
            systemInstallMatches: result.known === false ? [] : result.matches || [],
            active: result.known !== false && (result.by === 'managed' || result.by === 'both')
          })
        })
      } catch (error) {
        rethrowFontQuerySuperseded(error)
        hydrated = await options.hydrateInstallStatusForFonts(rawFonts)
        await yieldFontMetricsTurn()
        installStatusKnownCount = await countKnownInstallStatus(hydrated)
        installStatusMissingCount = Math.max(0, rawFonts.length - installStatusKnownCount)
      }
    } else {
      hydrated = await options.hydrateInstallStatusForFonts(rawFonts)
      await yieldFontMetricsTurn()
      installStatusKnownCount = await countKnownInstallStatus(hydrated)
      installStatusMissingCount = Math.max(0, rawFonts.length - installStatusKnownCount)
    }
    await yieldFontMetricsTurn()
    hydrated = await options.hydrateLocalTagsForFonts(hydrated)
    await yieldFontMetricsTurn()
    const libraryDb = await options.openLibraryDb()
    assertFontQueryActive()
    const shell = options.loadLibraryShellFromSqlite(libraryDb)

    metrics.total = hydrated.length
    metrics.categoryCounts.all = hydrated.length
    await forEachFontMetricsChunk(shell.collections || [], collection => { metrics.collectionCounts[collection.id] = 0 })
    await forEachFontMetricsChunk(shell.localTags || [], tag => { metrics.localTagCounts![tag] = 0 })
    await forEachFontMetricsChunk(shell.tags || [], tag => { metrics.sharedTagCounts![tag] = 0 })

    const folderIdByKey = new Map<string, string>()
    await forEachFontMetricsChunk(shell.folders || [], folder => {
      metrics.folderCounts[folder] = 0
      folderIdByKey.set(normalizePathForCacheCompare(folder), folder)
    })
    await forEachFontMetricsChunk(shell.folderNodes || [], node => {
      if (!node?.id) return
      metrics.folderCounts[node.id] = 0
      folderIdByKey.set(normalizePathForCacheCompare(node.id), node.id)
    })

    let matchedInstalledCount = 0
    await forEachFontMetricsChunk(hydrated, font => {
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
      for (const tagName of font.localTagNames || []) {
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
    })

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
    assertFontQueryActive()
    await options.saveMetricsSnapshot('font_metrics', metrics)
    assertFontQueryActive()
    return metrics
  }

  return { getFontMetricsFromLibrary }
}


// The local snapshot keeps hot metrics reads off the NAS. The pending queue is
// applied before counting, just as it is for page hydration and active filters.
export async function readLocalUserMetricsFromMergedIndex(options: {
  roots: string[]
  expectedTotal: number
  openMergedIndexDb: () => Promise<any>
  openLibraryDb: () => Promise<any>
  librarySqlitePath: () => string
  closeSqliteDb: (db: any) => void
  applyPendingActivationState: (items: FontItem[]) => FontItem[]
}): Promise<Pick<FontMetricsResult, 'favoriteCount' | 'activeCount'> | null> {
  assertFontQueryActive()
  if (!options.roots.length) return { favoriteCount: 0, activeCount: 0 }
  // Let queued I/O callbacks settle before the synchronous local SQL stage.
  await yieldFontMetricsTurn()
  await options.openLibraryDb()
  await yieldFontMetricsTurn()
  const db = await options.openMergedIndexDb()
  let rows: Array<{ id: string; installed_by: string; favorite: number }>
  try {
    assertFontQueryActive()
    db.exec(`ATTACH DATABASE ${sqliteLiteral(options.librarySqlitePath())} AS local_db`)
    const roots = [...new Set(options.roots.map(root => resolve(root)))]
    rows = db.prepare(`SELECT ${rootIndexRuntimeFontIdExpr()} AS id,
      entries.installed_by, ${mergedIndexLocalFavoriteExpr()} AS favorite
      FROM entries WHERE COALESCE(entries.is_deleted, 0) = 0 AND entries.status = 'ok'
      AND entries.font_json IS NOT NULL AND json_valid(entries.font_json)
      AND entries.root_path IN (${roots.map(() => '?').join(',')})`).all(...roots) as Array<{ id: string; installed_by: string; favorite: number }>
  } finally { options.closeSqliteDb(db) }
  assertFontQueryActive()
  if (rows.length !== options.expectedTotal) return null
  // Rows are fully materialized and the handle is closed before any memory yield.
  await yieldFontMetricsTurn()
  const items: FontItem[] = []
  await forEachFontMetricsChunk(rows, row => {
    items.push({ id: row.id, favorite: !!row.favorite, active: row.installed_by === 'managed' || row.installed_by === 'both' } as FontItem)
  })
  assertFontQueryActive()
  // Apply the pending queue once so all rows observe the same overlay turn.
  const fonts = options.applyPendingActivationState(items)
  await yieldFontMetricsTurn()
  let favoriteCount = 0
  let activeCount = 0
  await forEachFontMetricsChunk(fonts, font => {
    if (font.favorite) favoriteCount += 1
    if (font.active) activeCount += 1
  })
  assertFontQueryActive()
  return { favoriteCount, activeCount }
}
