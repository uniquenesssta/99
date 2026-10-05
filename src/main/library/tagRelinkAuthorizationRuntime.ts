import { readFontContentIdentity } from '../fonts/fontContentIdentityRuntime'
import type { FontItem } from '../../shared/types'
import { sharedFileSystem as fsp } from '../path/sharedFileSystemRuntime'
import { normalizePathForCacheCompare as key } from '../path/cachePath'

// Written only by the main-process relink service after its native file chooser.
// Renderer-supplied tag metadata alone must never grant access outside watched roots.
export function createTagRelinkAuthorizationRuntime(openLibraryDb: () => Promise<any>) {
  async function open() {
    const db = await openLibraryDb()
    db.exec('CREATE TABLE IF NOT EXISTS tag_relinked_files (real_path TEXT PRIMARY KEY, font_path TEXT NOT NULL, file_size INTEGER NOT NULL, modified_at REAL NOT NULL, content_sha256 TEXT)')
    if (!db.prepare('PRAGMA table_info(tag_relinked_files)').all().some((column: { name: string }) => column.name === 'content_sha256')) db.exec('ALTER TABLE tag_relinked_files ADD COLUMN content_sha256 TEXT')
    return db
  }
  async function rememberRelinkedFontFile(font: FontItem): Promise<void> {
    const identity = await readFontContentIdentity(font.path)
    const real = identity.path
    if (identity.size !== font.fileSize || identity.modified !== font.modifiedAt || font.recoveryContentHash && font.recoveryContentHash !== identity.sha256) throw new Error('所选字体已变化，请重新选择。')
    const db = await open()
    db.transaction(() => {
      db.prepare('DELETE FROM tag_relinked_files WHERE font_path = ? AND real_path <> ?').run(key(font.path), key(real))
      db.prepare('INSERT OR REPLACE INTO tag_relinked_files(real_path, font_path, file_size, modified_at, content_sha256) VALUES (?, ?, ?, ?, ?)').run(key(real), key(font.path), identity.size, identity.modified, identity.sha256)
    })()
  }
  async function stateForRealPath(comparePath: string): Promise<'authorized' | 'changed' | 'unknown'> {
    const db = await open()
    const row = db.prepare(`SELECT r.file_size, r.modified_at, r.content_sha256 FROM tag_relinked_files r
      WHERE r.real_path = ? AND EXISTS (SELECT 1 FROM local_font_tags t WHERE t.font_path = r.font_path)`).get(key(comparePath))
    if (!row) return 'unknown'
    try {
      const stat = await fsp.stat(comparePath)
      if (!stat.isFile()) return 'unknown'
      if (stat.size !== row.file_size || stat.mtimeMs !== row.modified_at || !row.content_sha256) return 'changed'
      return (await readFontContentIdentity(comparePath)).sha256 === row.content_sha256 ? 'authorized' : 'changed'
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
