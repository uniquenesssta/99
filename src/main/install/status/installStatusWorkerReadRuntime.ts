import { fileRuntimeFontId } from '../../fonts/fontFileIdentity'
import { migrateInstallStatusIdentity } from './installStatusIdentityMigration'
import type { InstallStatusRuntimeDeps } from './installStatusTypes'

type Reader = NonNullable<InstallStatusRuntimeDeps['readInstallStatusIndexInWorker']>

// The production storage boundary owns both migration and worker delegation.
// Invalid historical/display metadata cannot suppress valid rows in the batch.
export function createInstallStatusWorkerReadRuntime(options: {
  openLibraryDb: () => Promise<unknown>
  exists: InstallStatusRuntimeDeps['exists']
  openStableSqliteDb: InstallStatusRuntimeDeps['openStableSqliteDb']
  closeSqliteDb: InstallStatusRuntimeDeps['closeSqliteDb']
  initializeMachineInstallDb: (db: any, root: string) => void
  readRust: (groups: Parameters<Reader>[0]) => Promise<Awaited<ReturnType<Reader>> | null>
  readWorker: Reader
  appendStartupLog: (message: string) => void
}): Reader {
  return async groups => {
    await options.openLibraryDb()
    const invalidIds = new Set<string>()
    const samples: Array<{ group: number; row: number; reason: string }> = []
    const validGroups = groups.map((group, groupIndex) => ({ ...group, items: group.items.filter((item, row) => {
      try { fileRuntimeFontId(item.path, item.fileSize, item.modifiedAt); return true }
      catch (error) {
        invalidIds.add(item.id)
        if (samples.length < 3) samples.push({ group: groupIndex, row, reason: (error instanceof Error ? error.message : String(error)).slice(0, 160) })
        return false
      }
    }) })).filter(group => group.items.length > 0)
    if (invalidIds.size) options.appendStartupLog(`install status invalid identity rows isolated: count=${invalidIds.size}, samples=${JSON.stringify(samples)}`)
    for (const group of validGroups) {
      if (!(await options.exists(group.dbPath))) continue
      const db = options.openStableSqliteDb(group.dbPath, 'install-identity-items')
      try {
        options.initializeMachineInstallDb(db, group.rootPath)
        migrateInstallStatusIdentity(db, group.items.map(item => ({ root_path: '', relative_path: item.path,
          file_size: item.fileSize, modified_at: item.modifiedAt, font_json: JSON.stringify(item) })))
      } finally { options.closeSqliteDb(db) }
    }
    const rust = validGroups.length ? await options.readRust(validGroups) : null
    const value: Awaited<ReturnType<Reader>> = rust || (validGroups.length ? await options.readWorker(validGroups) : { results: {}, missingIds: [] })
    // Duplicate corrupt IDs also remain unknown; an invalid row never borrows a
    // valid row's authority merely because their supplied IDs happen to match.
    const results = { ...value.results }
    for (const id of invalidIds) delete results[id]
    options.appendStartupLog(`machine install status ${rust ? 'rust' : 'db worker'} read: groups=${validGroups.length}, known=${Object.keys(results).length}, missing=${value.missingIds.length + invalidIds.size}, elapsed=${value.timings?.elapsed || 0}ms`)
    return { ...value, results, missingIds: [...new Set([...value.missingIds, ...invalidIds])] }
  }
}
