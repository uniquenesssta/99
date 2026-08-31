import type { InstallStatusDbRuntime,InstallStatusRuntimeDeps } from './installStatusTypes'

export function createInstallStatusDeleteRuntime(deps: InstallStatusRuntimeDeps, helpers: InstallStatusDbRuntime) {
  async function deleteInstallStatusIndex(fontIds: string[]): Promise<void> {
    const ids = Array.from(new Set((fontIds || []).filter(Boolean)))
    if (!ids.length) return
    const folders = await deps.appWatchedFolders().catch(() => [])
    const dbPaths = new Set<string>()
    for (const folder of folders) dbPaths.add(await helpers.installStatusDbPathForRoot(folder))
    dbPaths.add(await helpers.fallbackInstallStatusDbPath())
    for (const dbPath of dbPaths) {
      if (!(await deps.exists(dbPath))) continue
      const db = deps.openStableSqliteDb(dbPath, 'machine-install:delete')
      try {
        helpers.initializeMachineInstallDb(db, dbPath)
        const remove = db.prepare('DELETE FROM install_status WHERE font_id = ?')
        db.exec('BEGIN IMMEDIATE')
        try {
          for (const id of ids) remove.run(id)
          db.exec('COMMIT')
        } catch (error) {
          try { db.exec('ROLLBACK') } catch { /* ignore */ }
          throw error
        }
      } finally {
        deps.closeSqliteDb(db)
      }
    }
  }

  return { deleteInstallStatusIndex }
}
