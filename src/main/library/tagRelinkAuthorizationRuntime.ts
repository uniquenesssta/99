import type { FontItem } from '../../shared/types'
import { sharedFileSystem as fsp } from '../path/sharedFileSystemRuntime'
import { normalizePathForCacheCompare as key } from '../path/cachePath'

// Written only by the main-process relink service after its native file chooser.
// Renderer-supplied tag metadata alone must never grant access outside watched roots.
export function createTagRelinkAuthorizationRuntime(openLibraryDb: () => Promise<any>) {
  async function open() {
    const db = await openLibraryDb()
    db.exec('CREATE TABLE IF NOT EXISTS tag_relinked_files (real_path TEXT PRIMARY KEY, font_path TEXT NOT NULL, file_size INTEGER NOT NULL, modified_at REAL NOT NULL)')
    return db
  }
  async function rememberRelinkedFontFile(font: FontItem): Promise<void> {
    const real = await fsp.realpath(font.path)
    const stat = await fsp.stat(real)
    if (!stat.isFile() || stat.size !== font.fileSize || stat.mtimeMs !== font.modifiedAt) throw new Error('所选字体已变化，请重新选择。')
    const db = await open()
    db.prepare('INSERT OR REPLACE INTO tag_relinked_files VALUES (?, ?, ?, ?)').run(key(real), key(font.path), stat.size, stat.mtimeMs)
  }
  async function contains(comparePath: string): Promise<boolean> {
    const db = await open()
    const row = db.prepare(`SELECT r.file_size, r.modified_at FROM tag_relinked_files r
      WHERE r.real_path = ? AND EXISTS (SELECT 1 FROM local_font_tags t WHERE t.font_path = r.font_path)`).get(key(comparePath))
    if (!row) return false
    try {
      const stat = await fsp.stat(comparePath)
      return stat.isFile() && stat.size === row.file_size && stat.mtimeMs === row.modified_at
    } catch { return false }
  }
  async function canReadDetached(path: string): Promise<boolean> {
    try { return contains(await fsp.realpath(path)) } catch { return false }
  }
  return { rememberRelinkedFontFile, contains, canReadDetached }
}
