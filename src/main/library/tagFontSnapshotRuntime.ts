import type { FontItem } from '../../shared/types'
import { normalizePathForCacheCompare } from '../path/cachePath'
import { readFontContentIdentity, readFontIdentityMetadata } from '../fonts/fontContentIdentityRuntime'

// Display/matching metadata only. Tag membership remains in the existing tag stores.
export function openTagFontSnapshots(db: any) {
  db.exec('CREATE TABLE IF NOT EXISTS tag_font_snapshots (font_path TEXT PRIMARY KEY, font_json TEXT NOT NULL)')
  const read = db.prepare('SELECT font_json FROM tag_font_snapshots WHERE font_path = ?')
  const write = db.prepare('INSERT OR REPLACE INTO tag_font_snapshots (font_path, font_json) VALUES (?, ?)')
  const previous = (path: string): FontItem | undefined => {
    try { const row = read.get(normalizePathForCacheCompare(path)); return row ? JSON.parse(row.font_json) : undefined } catch { return undefined }
  }
  function remember(items: FontItem[]): void {
    db.transaction(() => {
      for (const item of items) {
        if (!item.path || item.fileAvailability === 'missing' || item.fileAvailability === 'unavailable') continue
        const old = previous(item.path)
        const { tagNames: _shared, localTagNames: _local, recoveryContentHash: _untrusted, recoveryFileStamp: _untrustedStamp, ...metadata } = item
        const recoveryContentHash = old?.fileSize === item.fileSize && old.modifiedAt === item.modifiedAt ? old.recoveryContentHash : undefined
        write.run(normalizePathForCacheCompare(item.path), JSON.stringify({ ...metadata, recoveryContentHash, recoveryFileStamp: recoveryContentHash ? old?.recoveryFileStamp : undefined, tagNames: [], localTagNames: [] }))
      }
    })()
  }
  return {
    read(path: string): FontItem | undefined {
      const row = read.get(normalizePathForCacheCompare(path))
      try { return row ? JSON.parse(row.font_json) : undefined } catch { return undefined }
    },
    remember,
    async capture(items: FontItem[]): Promise<void> {
      remember(items)
      for (const item of items) {
        if (item.fileAvailability === 'missing' || item.fileAvailability === 'unavailable') continue
        const old = previous(item.path)
        try {
          const { stamp } = await readFontIdentityMetadata(item.path)
          if (old?.recoveryContentHash && old.recoveryFileStamp === stamp) continue
          const evidence = await readFontContentIdentity(item.path)
          if (evidence.size !== item.fileSize || evidence.modified !== item.modifiedAt) continue
          const current = previous(item.path)
          if (!current || current.fileSize !== item.fileSize || current.modifiedAt !== item.modifiedAt) continue
          write.run(normalizePathForCacheCompare(item.path), JSON.stringify({ ...current, recoveryContentHash: evidence.sha256, recoveryFileStamp: evidence.stamp }))
        } catch { /* Missing/denied files retain their last proven evidence, never guessed metadata. */ }
      }
    },
  }
}
