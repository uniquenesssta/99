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
    db.transaction(() => {
      db.prepare('DELETE FROM tag_relinked_files WHERE font_path = ? AND real_path <> ?').run(key(font.path), key(real))
      db.prepare('INSERT OR REPLACE INTO tag_relinked_files VALUES (?, ?, ?, ?)').run(key(real), key(font.path), stat.size, stat.mtimeMs)
    })()
  }
  async function stateForRealPath(comparePath: string): Promise<'authorized' | 'changed' | 'unknown'> {
    const db = await open()
    const row = db.prepare(`SELECT r.file_size, r.modified_at FROM tag_relinked_files r
      WHERE r.real_path = ? AND EXISTS (SELECT 1 FROM local_font_tags t WHERE t.font_path = r.font_path)`).get(key(comparePath))
    if (!row) return 'unknown'
    try {
      const stat = await fsp.stat(comparePath)
      if (!stat.isFile()) return 'unknown'
      return stat.size === row.file_size && stat.mtimeMs === row.modified_at ? 'authorized' : 'changed'
    } catch { return 'unknown' }
  }
  const contains = async (comparePath: string) => await stateForRealPath(comparePath) === 'authorized'
  async function readDetachedState(path: string): Promise<'authorized' | 'changed' | 'unknown'> {
    try {
      const real = await fsp.realpath(path)
      const state = await stateForRealPath(real)
      if (state !== 'unknown') return state
      const db = await open()
      const previous = db.prepare(`SELECT r.real_path FROM tag_relinked_files r
        WHERE r.font_path = ? AND EXISTS (SELECT 1 FROM local_font_tags t WHERE t.font_path = r.font_path)`).get(key(path))
      // A previously picked path now resolving to another file may be confirmed
      // again, but that new file is not authorized until the native picker runs.
      return previous && key(real) !== previous.real_path && (await fsp.stat(real)).isFile() ? 'changed' : 'unknown'
    } catch { return 'unknown' }
  }
  async function canReadDetached(path: string): Promise<boolean> {
    return await readDetachedState(path) === 'authorized'
  }
  return { rememberRelinkedFontFile, contains, canReadDetached, readDetachedState }
}
