import type { FontItem } from '../../shared/types'
import { normalizePathForCacheCompare } from '../path/cachePath'

// Display/matching metadata only. Tag membership remains in the existing tag stores.
export function openTagFontSnapshots(db: any) {
  db.exec('CREATE TABLE IF NOT EXISTS tag_font_snapshots (font_path TEXT PRIMARY KEY, font_json TEXT NOT NULL)')
  const read = db.prepare('SELECT font_json FROM tag_font_snapshots WHERE font_path = ?')
  const write = db.prepare('INSERT OR REPLACE INTO tag_font_snapshots (font_path, font_json) VALUES (?, ?)')
  return {
    read(path: string): FontItem | undefined {
      const row = read.get(normalizePathForCacheCompare(path))
      try { return row ? JSON.parse(row.font_json) : undefined } catch { return undefined }
    },
    remember(items: FontItem[]): void {
      db.transaction(() => {
        for (const item of items) {
          if (!item.path || item.fileAvailability === 'missing' || item.fileAvailability === 'unavailable') continue
          const { tagNames: _shared, localTagNames: _local, ...metadata } = item
          write.run(normalizePathForCacheCompare(item.path), JSON.stringify({ ...metadata, tagNames: [], localTagNames: [] }))
        }
      })()
    },
  }
}
