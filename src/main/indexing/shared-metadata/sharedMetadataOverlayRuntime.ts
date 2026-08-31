import type { FontItem } from '../../../shared/types'
import type { RustSharedMetadataOverlayReadInput, RustSharedMetadataOverlayReadResult } from '../../rust-core/rustCoreWorkerRuntime'
import {
  logNodeStateFallbackDisabled,
  logNodeStateFallbackUsed,
  nodeStateFallbackCompatibilityAllowed,
} from '../../rust-core/nodeStateFallbackCompatibilityRuntime'
import type { FontScanCacheFile } from '../rootIndexRuntime'
import type { MergedIndexPageRow } from '../rootIndexQuerySql'
import { sharedMetadataDbPathForRoot } from './sharedMetadataPathsRuntime'
import { applyStateToFont, fontPathKey, stateFromRow, type SharedMetadataRow, type SharedMetadataState } from './sharedMetadataStateRuntime'

export interface SharedMetadataOverlayRuntimeDeps {
  exists: (filePath: string) => Promise<boolean>
  closeSqliteDb: (db: any) => void
  appendStartupLog: (message: string) => void
  cacheEntryRuntimePath: (rootPath: string, entryPath: string) => string
  openSharedMetadataDb: (rootPath: string, touch?: boolean) => Promise<any>
  migrateLegacyMetadataFromCacheInOpenDb: (db: any, rootPath: string, cache: FontScanCacheFile) => number
  ensureSharedTagOpsReplayedInOpenDb?: (db: any, rootPath: string, reason?: string) => unknown
  runRustSharedMetadataOverlayRead?: (input: RustSharedMetadataOverlayReadInput) => Promise<RustSharedMetadataOverlayReadResult | null>
}

type OverlayLogState = { at: number; suppressed: number }
type OverlayEntryRequest = { key: string; fontId: string; relativePath: string; pathKey: string }
type OverlayEntryState = SharedMetadataState & { matchedBy?: string }

const OVERLAY_LOG_INTERVAL_MS = 10_000
const RUST_OVERLAY_BATCH_LIMIT = 4000
const overlayLogState = new Map<string, OverlayLogState>()

function logOverlayApplied(deps: SharedMetadataOverlayRuntimeDeps, kind: string, rootPath: string, applied: number): void {
  const key = `${kind}::${rootPath}`
  const now = Date.now()
  const previous = overlayLogState.get(key)
  if (previous && now - previous.at < OVERLAY_LOG_INTERVAL_MS) {
    previous.suppressed += 1
    return
  }
  const suppressedText = previous?.suppressed ? `, suppressed=${previous.suppressed}` : ''
  overlayLogState.set(key, { at: now, suppressed: 0 })
  deps.appendStartupLog(`${kind}: root=${rootPath}, rows=${applied}${suppressedText}`)
}

function cleanTagNames(tagNames: unknown): string[] {
  if (!Array.isArray(tagNames)) return []
  return Array.from(new Set(tagNames.map((tag) => String(tag || '').trim()).filter(Boolean))).sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'))
}

function applyOverlayStateToFont(font: FontItem, state: OverlayEntryState | undefined): FontItem {
  if (!state) return font
  return applyStateToFont(font, {
    tagNames: cleanTagNames(state.tagNames),
    favorite: !!state.favorite,
    deleteProtected: !!state.deleteProtected,
  })
}

function overlayStateMapFromRust(result: RustSharedMetadataOverlayReadResult | null | undefined): Map<string, OverlayEntryState> {
  const map = new Map<string, OverlayEntryState>()
  if (!result?.matched?.length) return map
  for (const item of result.matched) {
    const key = String(item?.key || '')
    if (!key) continue
    map.set(key, {
      tagNames: cleanTagNames(item.tagNames),
      favorite: !!item.favorite,
      deleteProtected: !!item.deleteProtected,
      matchedBy: item.matchedBy,
    })
  }
  return map
}

async function readRustOverlayStateMap(
  deps: SharedMetadataOverlayRuntimeDeps,
  rootPath: string,
  dbPath: string,
  entries: OverlayEntryRequest[],
): Promise<Map<string, OverlayEntryState> | null> {
  if (!deps.runRustSharedMetadataOverlayRead || !entries.length) return null
  const combined = new Map<string, OverlayEntryState>()
  let usedRust = false
  for (let start = 0; start < entries.length; start += RUST_OVERLAY_BATCH_LIMIT) {
    const chunk = entries.slice(start, start + RUST_OVERLAY_BATCH_LIMIT)
    const result = await deps.runRustSharedMetadataOverlayRead({ rootPath, dbPath, entries: chunk }).catch((error) => {
      deps.appendStartupLog(`shared metadata rust overlay skipped: root=${rootPath}, ${error instanceof Error ? error.message : String(error)}`)
      return null
    })
    if (!result) return null
    usedRust = true
    for (const [key, state] of overlayStateMapFromRust(result)) combined.set(key, state)
  }
  return usedRust ? combined : null
}

export function createSharedMetadataOverlayRuntime(deps: SharedMetadataOverlayRuntimeDeps) {
  function metadataByKeys(db: any): {
    byFontId: Map<string, SharedMetadataState>
    byRelativePath: Map<string, SharedMetadataState>
    byPathKey: Map<string, SharedMetadataState>
  } {
    const byFontId = new Map<string, SharedMetadataState>()
    const byRelativePath = new Map<string, SharedMetadataState>()
    const byPathKey = new Map<string, SharedMetadataState>()
    const rows = db.prepare(`
      SELECT font_id, relative_path, path_key, tag_names_json, favorite, delete_protected
      FROM font_metadata
    `).all() as SharedMetadataRow[]

    for (const row of rows) {
      const state = stateFromRow(row)
      if (!state) continue
      if (row.font_id) byFontId.set(String(row.font_id), state)
      if (row.relative_path) byRelativePath.set(String(row.relative_path).replace(/\\/g, '/'), state)
      if (row.path_key) byPathKey.set(String(row.path_key), state)
    }

    return { byFontId, byRelativePath, byPathKey }
  }

  async function applySharedMetadataOverlayWithRust(rootPath: string, dbPath: string, cache: FontScanCacheFile): Promise<FontScanCacheFile | null> {
    const entries: OverlayEntryRequest[] = []
    for (const [relativePath, entry] of Object.entries(cache.entries || {})) {
      const font = entry.font
      if (!font) continue
      const runtimePath = deps.cacheEntryRuntimePath(rootPath, entry.path || relativePath)
      entries.push({
        key: relativePath,
        fontId: String(font.id || ''),
        relativePath: relativePath.replace(/\\/g, '/'),
        pathKey: fontPathKey(font, runtimePath),
      })
    }
    const stateByKey = await readRustOverlayStateMap(deps, rootPath, dbPath, entries)
    if (!stateByKey) return null
    let applied = 0
    for (const [relativePath, state] of stateByKey) {
      const entry = cache.entries?.[relativePath]
      if (!entry?.font) continue
      cache.entries[relativePath] = { ...entry, font: applyOverlayStateToFont(entry.font, state) }
      applied += 1
    }
    if (applied) logOverlayApplied(deps, 'shared metadata rust overlay applied', rootPath, applied)
    return cache
  }

  async function applySharedMetadataOverlay(rootPath: string, cache: FontScanCacheFile): Promise<FontScanCacheFile> {
    const dbPath = sharedMetadataDbPathForRoot(rootPath)
    if (!(await deps.exists(dbPath).catch(() => false))) return cache

    if (deps.runRustSharedMetadataOverlayRead) {
      const legacyDb = await deps.openSharedMetadataDb(rootPath, false)
      try {
        deps.migrateLegacyMetadataFromCacheInOpenDb(legacyDb, rootPath, cache)
        deps.ensureSharedTagOpsReplayedInOpenDb?.(legacyDb, rootPath, 'overlay-rust-preflight')
      } finally {
        deps.closeSqliteDb(legacyDb)
      }
      const rustApplied = await applySharedMetadataOverlayWithRust(rootPath, dbPath, cache)
      if (rustApplied) return rustApplied
    }
    if (!nodeStateFallbackCompatibilityAllowed()) {
      logNodeStateFallbackDisabled({
        appendStartupLog: deps.appendStartupLog,
        source: 'shared-metadata-overlay-read',
        reason: 'rust-overlay-returned-empty',
      })
      return cache
    }
    logNodeStateFallbackUsed({
      appendStartupLog: deps.appendStartupLog,
      source: 'shared-metadata-overlay-read',
      detail: `root=${rootPath}`,
    })

    const db = await deps.openSharedMetadataDb(rootPath, false)
    try {
      deps.migrateLegacyMetadataFromCacheInOpenDb(db, rootPath, cache)
      deps.ensureSharedTagOpsReplayedInOpenDb?.(db, rootPath, 'overlay-read')
      const metadata = metadataByKeys(db)
      let applied = 0
      for (const [relativePath, entry] of Object.entries(cache.entries || {})) {
        const font = entry.font
        if (!font) continue
        const state = metadata.byRelativePath.get(relativePath.replace(/\\/g, '/'))
          || metadata.byFontId.get(font.id || '')
          || metadata.byPathKey.get(fontPathKey(font, deps.cacheEntryRuntimePath(rootPath, entry.path || relativePath)))
        if (!state) continue
        cache.entries[relativePath] = { ...entry, font: applyStateToFont(font, state) }
        applied += 1
      }
      if (applied) logOverlayApplied(deps, 'shared metadata overlay applied', rootPath, applied)
      return cache
    } finally {
      deps.closeSqliteDb(db)
    }
  }

  function applyMetadataToRowsInOpenDb(db: any, rootPath: string, rows: MergedIndexPageRow[]): MergedIndexPageRow[] {
    if (!rows.length) return rows
    deps.ensureSharedTagOpsReplayedInOpenDb?.(db, rootPath, 'merged-row-overlay')
    const metadata = metadataByKeys(db)
    let applied = 0
    const nextRows = rows.map((row) => {
      if (!row.font_json) return row
      try {
        const font = JSON.parse(row.font_json) as FontItem
        const state = metadata.byRelativePath.get(String(row.relative_path || '').replace(/\\/g, '/'))
          || metadata.byFontId.get(font.id || '')
          || metadata.byPathKey.get(fontPathKey(font, deps.cacheEntryRuntimePath(rootPath, String(row.relative_path || ''))))
        if (!state) return row
        applied += 1
        return { ...row, font_json: JSON.stringify(applyStateToFont(font, state)) }
      } catch {
        return row
      }
    })
    if (applied) logOverlayApplied(deps, 'shared metadata row overlay applied', rootPath, applied)
    return nextRows
  }

  async function applySharedMetadataToMergedRowsWithRust(rootPath: string, dbPath: string, rows: MergedIndexPageRow[]): Promise<MergedIndexPageRow[] | null> {
    const entries: OverlayEntryRequest[] = []
    const fontsByKey = new Map<string, FontItem>()
    rows.forEach((row, index) => {
      if (!row.font_json) return
      try {
        const font = JSON.parse(row.font_json) as FontItem
        const relativePath = String(row.relative_path || '').replace(/\\/g, '/')
        const key = String(index)
        fontsByKey.set(key, font)
        entries.push({
          key,
          fontId: String(font.id || ''),
          relativePath,
          pathKey: fontPathKey(font, deps.cacheEntryRuntimePath(rootPath, relativePath)),
        })
      } catch {
        // keep invalid rows untouched
      }
    })
    const stateByKey = await readRustOverlayStateMap(deps, rootPath, dbPath, entries)
    if (!stateByKey) return null
    let applied = 0
    const nextRows = rows.map((row, index) => {
      const key = String(index)
      const state = stateByKey.get(key)
      const font = fontsByKey.get(key)
      if (!state || !font) return row
      applied += 1
      return { ...row, font_json: JSON.stringify(applyOverlayStateToFont(font, state)) }
    })
    if (applied) logOverlayApplied(deps, 'shared metadata rust row overlay applied', rootPath, applied)
    return nextRows
  }

  async function applySharedMetadataToMergedRows(rootPath: string, rows: MergedIndexPageRow[]): Promise<MergedIndexPageRow[]> {
    const dbPath = sharedMetadataDbPathForRoot(rootPath)
    if (!rows.length || !(await deps.exists(dbPath).catch(() => false))) return rows

    if (deps.runRustSharedMetadataOverlayRead) {
      const preflightDb = await deps.openSharedMetadataDb(rootPath, false)
      try {
        deps.ensureSharedTagOpsReplayedInOpenDb?.(preflightDb, rootPath, 'row-overlay-rust-preflight')
      } finally {
        deps.closeSqliteDb(preflightDb)
      }
    }

    const rustRows = await applySharedMetadataToMergedRowsWithRust(rootPath, dbPath, rows)
    if (rustRows) return rustRows
    if (!nodeStateFallbackCompatibilityAllowed()) {
      logNodeStateFallbackDisabled({
        appendStartupLog: deps.appendStartupLog,
        source: 'shared-metadata-overlay-read',
        reason: 'rust-row-overlay-returned-empty',
      })
      return rows
    }
    logNodeStateFallbackUsed({
      appendStartupLog: deps.appendStartupLog,
      source: 'shared-metadata-overlay-read',
      detail: `root=${rootPath}, rows=${rows.length}`,
    })

    const db = await deps.openSharedMetadataDb(rootPath, false)
    try {
      return applyMetadataToRowsInOpenDb(db, rootPath, rows)
    } finally {
      deps.closeSqliteDb(db)
    }
  }

  return {
    applySharedMetadataOverlay,
    applySharedMetadataToMergedRows,
  }
}
