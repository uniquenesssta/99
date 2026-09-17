import type { FontItem, FontProtectionResult } from '../../../shared/types'
import { normalizePathForCacheCompare } from '../../path/cachePath'

type FavoriteRow = { font_id: string; font_path: string; favorite: number }

// The local app database is the only favorite authority. Shared metadata remains
// readable by old clients, but is never imported after the one-time local migration.
export function createLocalFontFavoritesRuntime(options: {
  openLibraryDb: () => Promise<any>
  loadLegacyLocalSnapshot: () => Promise<FontItem[]>
  invalidate: () => void
  appendLog: (message: string) => void
}) {
  let initializing: Promise<void> | undefined
  let initialized = false

  async function initialize(): Promise<void> {
    if (initialized) return
    if (initializing) return initializing
    initializing = (async () => {
      const db = await options.openLibraryDb()
      if (db.prepare('SELECT value FROM meta WHERE key = ?').get('localFavoritesMigrated')?.value !== '1') {
        const fonts = await options.loadLegacyLocalSnapshot()
        const insert = db.prepare('INSERT OR IGNORE INTO local_font_favorites (font_id, font_path, favorite) VALUES (?, ?, 1)')
        db.transaction(() => {
          for (const font of fonts) if (font.favorite && font.id) insert.run(font.id.toLowerCase(), normalizePathForCacheCompare(font.path || ''))
          db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run('localFavoritesMigrated', '1')
        })()
        options.appendLog(`local favorites migrated from existing local snapshot: favorites=${fonts.filter(font => font.favorite).length}`)
      }
      initialized = true
    })()
    try { await initializing } finally { initializing = undefined }
  }

  async function hydrate(items: FontItem[]): Promise<FontItem[]> {
    await initialize()
    const db = await options.openLibraryDb()
    const rows = db.prepare('SELECT font_id, font_path, favorite FROM local_font_favorites').all() as FavoriteRow[]
    const byId = new Map(rows.map(row => [row.font_id, !!row.favorite]))
    const byPath = new Map(rows.filter(row => row.font_path).map(row => [row.font_path, !!row.favorite]))
    return items.map(font => {
      const favorite = byPath.get(normalizePathForCacheCompare(font.path || ''))
        ?? byId.get(String(font.id || '').toLowerCase())
        ?? byId.get(String(font.sourceId || '').toLowerCase()) ?? false
      return { ...font, favorite }
    })
  }

  async function setFavorite(items: FontItem[], _watchedFolders: string[], favorite: boolean): Promise<FontProtectionResult> {
    await initialize()
    const db = await options.openLibraryDb()
    const unique = [...new Map((items || []).filter(item => item?.id).map(item => [item.id, item])).values()]
    const save = db.prepare('INSERT OR REPLACE INTO local_font_favorites (font_id, font_path, favorite) VALUES (?, ?, ?)')
    const clearAliases = db.prepare('DELETE FROM local_font_favorites WHERE font_id = ? OR font_id = ? OR (font_path <> ? AND font_path = ?)')
    db.transaction(() => {
      for (const item of unique) {
        const path = normalizePathForCacheCompare(item.path || '')
        clearAliases.run(item.id.toLowerCase(), String(item.sourceId || '').toLowerCase(), '', path)
        // Keep false as a local decision as well: neither a stale snapshot nor an
        // alternate identity may resurrect an explicitly removed favorite.
        save.run(item.id.toLowerCase(), path, favorite ? 1 : 0)
      }
    })()
    options.invalidate()
    return { ok: true, updatedIds: unique.map(item => item.id), failed: [], message: `${favorite ? '收藏' : '取消收藏'} ${unique.length} 个（仅本机）。` }
  }

  return { initialize, hydrate, setFavorite }
}
