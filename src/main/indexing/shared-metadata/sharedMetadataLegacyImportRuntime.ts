import os from 'node:os'
import type { FontScanCacheFile } from '../rootIndexRuntime'
import type { SharedFontMetadataRuntimeDeps } from './sharedFontMetadataRuntime'
import { fontPathKey, stateFromFont } from './sharedMetadataStateRuntime'

export interface SharedMetadataLegacyImportRuntimeDeps {
  runtimeDeps: SharedFontMetadataRuntimeDeps
  openSharedMetadataDb: (rootPath: string, touch?: boolean) => Promise<any>
  readMeta: (db: any, key: string) => string
  writeMeta: (db: any, key: string, value: string) => void
}

export function createSharedMetadataLegacyImportRuntime(deps: SharedMetadataLegacyImportRuntimeDeps) {
  const runtimeDeps = deps.runtimeDeps

  function migrateLegacyMetadataFromCacheInOpenDb(db: any, rootPath: string, cache: FontScanCacheFile): number {
    if (deps.readMeta(db, 'legacyRootIndexMetadataImportedAt')) return 0

    const now = new Date().toISOString()
    const insert = db.prepare(`
      INSERT OR IGNORE INTO font_metadata (
        font_id, relative_path, path_key, tag_names_json, favorite, delete_protected, revision, updated_at, updated_by
      ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
    `)
    let imported = 0
    for (const [relativePath, entry] of Object.entries(cache.entries || {})) {
      const font = entry.font
      if (!font?.id) continue
      const state = stateFromFont(font)
      if (!state.tagNames.length && !state.favorite && !state.deleteProtected) continue
      const info = insert.run(
        font.id,
        relativePath.replace(/\\/g, '/'),
        fontPathKey(font, runtimeDeps.cacheEntryRuntimePath(rootPath, entry.path || relativePath)),
        JSON.stringify(state.tagNames),
        state.favorite ? 1 : 0,
        state.deleteProtected ? 1 : 0,
        now,
        os.hostname(),
      )
      if (Number(info.changes || 0) > 0) imported += 1
    }
    deps.writeMeta(db, 'legacyRootIndexMetadataImportedAt', now)
    deps.writeMeta(db, 'updatedAt', now)
    if (imported) {
      db.prepare(`
        INSERT INTO metadata_events (event_type, font_id, relative_path, payload_json, created_at, writer_host, writer_pid)
        VALUES ('legacy_import', NULL, NULL, ?, ?, ?, ?)
      `).run(JSON.stringify({ rows: imported }), now, os.hostname(), process.pid)
    }
    return imported
  }

  async function ensureLegacyMetadataImported(rootPath: string, cache: FontScanCacheFile): Promise<void> {
    const db = await deps.openSharedMetadataDb(rootPath)
    try {
      const imported = migrateLegacyMetadataFromCacheInOpenDb(db, rootPath, cache)
      if (imported) runtimeDeps.appendStartupLog(`shared metadata legacy import: root=${rootPath}, rows=${imported}`)
    } finally {
      runtimeDeps.closeSqliteDb(db)
    }
  }

  return {
    migrateLegacyMetadataFromCacheInOpenDb,
    ensureLegacyMetadataImported,
  }
}
