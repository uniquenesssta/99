import type { FontItem, FontProtectionResult } from '../../../shared/types'
import { isPathInsideAnyRoot } from '../../path/fontPathPolicy'
import { normalizePathForCacheCompare } from '../../path/cachePath'

// Only explicit decisions for fonts outside watched roots are stored here.
// Watched-root protection continues to belong to shared metadata.
export function createLocalFontProtectionRuntime(options: {
  openLibraryDb: () => Promise<any>
  invalidate: () => void
  watchedFolders: () => Promise<string[]>
}) {
  async function database() {
    const db = await options.openLibraryDb()
    db.exec('CREATE TABLE IF NOT EXISTS local_font_protection (font_path TEXT PRIMARY KEY, protected INTEGER NOT NULL CHECK (protected IN (0, 1)))')
    db.exec('CREATE TABLE IF NOT EXISTS local_font_protection_roots (root_path TEXT PRIMARY KEY)')
    return db
  }
  function key(font: FontItem): string {
    const path = normalizePathForCacheCompare(font.path || '')
    if (!font.id || !path) throw new Error('字体标识或路径为空，未写入保护状态。')
    return path
  }
  async function roots(): Promise<string[]> {
    const current = await options.watchedFolders(), db = await database()
    const save = db.prepare('INSERT OR IGNORE INTO local_font_protection_roots (root_path) VALUES (?)')
    db.transaction(() => { for (const root of current) save.run(normalizePathForCacheCompare(root)) })()
    return (db.prepare('SELECT root_path FROM local_font_protection_roots').all() as Array<{ root_path: string }>).map(row => row.root_path)
  }
  async function hydrate(items: FontItem[]): Promise<FontItem[]> {
    if (!items.length) return items
    const knownRoots = await roots()
    const db = await database()
    const read = db.prepare('SELECT protected FROM local_font_protection WHERE font_path = ?')
    return items.map(font => {
      const row = read.get(normalizePathForCacheCompare(font.path || ''))
      // A local cancellation must never clear a shared protection decision.
      return row ? { ...font, deleteProtected: !!row.protected || (isPathInsideAnyRoot(font.path, knownRoots) && !!font.deleteProtected) } : font
    })
  }
  async function set(items: FontItem[], protect: boolean): Promise<FontProtectionResult> {
    const targets = items.map(font => ({ font, path: key(font) }))
    const db = await database()
    const save = db.prepare('INSERT OR REPLACE INTO local_font_protection (font_path, protected) VALUES (?, ?)')
    db.transaction(() => { for (const target of targets) save.run(target.path, protect ? 1 : 0) })()
    options.invalidate()
    return { ok: true, updatedIds: items.map(font => font.id), failed: [], message: `${protect ? '加入保护' : '取消保护'} ${items.length} 个（本机非监听字体）。` }
  }
  async function clear(items: FontItem[]): Promise<void> {
    if (!items.length) return
    const paths = items.map(key), db = await database()
    const remove = db.prepare('DELETE FROM local_font_protection WHERE font_path = ?')
    db.transaction(() => { for (const path of paths) remove.run(path) })()
    options.invalidate()
  }
  async function read(item: FontItem): Promise<boolean> {
    const path = key(item), db = await database()
    return !!db.prepare('SELECT protected FROM local_font_protection WHERE font_path = ?').get(path)?.protected
  }
  return { hydrate, set, clear, read, roots }
}
