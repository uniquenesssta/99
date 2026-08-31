import os from 'node:os'
import type { InstallStatusRuntimeDeps,SqliteDb } from './installStatusTypes'

export function createInstallStatusSchemaRuntime(deps: Pick<InstallStatusRuntimeDeps, 'setSqliteMeta'>) {
  function ensureInstallStatusColumns(db: SqliteDb): void {
    const columns = db.prepare('PRAGMA table_info(install_status)').all() as Array<{ name: string }>
    const names = new Set(columns.map((column) => column.name))
    const addColumn = (name: string, definition: string) => {
      if (!names.has(name)) {
        db.prepare(`ALTER TABLE install_status ADD COLUMN ${name} ${definition}`).run()
        names.add(name)
      }
    }

    addColumn('signature', `TEXT NOT NULL DEFAULT ''`)
    addColumn('installed', 'INTEGER NOT NULL DEFAULT 0')
    addColumn('by_type', `TEXT NOT NULL DEFAULT 'none'`)
    addColumn('matches_json', `TEXT NOT NULL DEFAULT '[]'`)
    addColumn('checked_at', 'TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP')
    addColumn('system_default', 'INTEGER NOT NULL DEFAULT 0')
  }

  function initializeMachineInstallDb(db: SqliteDb, rootPath: string): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS install_status (
        font_id TEXT PRIMARY KEY,
        signature TEXT NOT NULL DEFAULT '',
        installed INTEGER NOT NULL DEFAULT 0,
        by_type TEXT NOT NULL DEFAULT 'none',
        matches_json TEXT NOT NULL DEFAULT '[]',
        checked_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        system_default INTEGER NOT NULL DEFAULT 0
      );
    `)
    ensureInstallStatusColumns(db)
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_install_status_installed ON install_status(installed);
      CREATE INDEX IF NOT EXISTS idx_install_status_by_type ON install_status(by_type);
      CREATE INDEX IF NOT EXISTS idx_install_status_system_default ON install_status(system_default);
    `)
    deps.setSqliteMeta(db, 'schemaVersion', '1')
    deps.setSqliteMeta(db, 'cacheArchitecture', 'v1-clean-machine-install')
    deps.setSqliteMeta(db, 'rootPath', rootPath)
    deps.setSqliteMeta(db, 'machine', os.hostname())
  }

  return { ensureInstallStatusColumns, initializeMachineInstallDb }
}
