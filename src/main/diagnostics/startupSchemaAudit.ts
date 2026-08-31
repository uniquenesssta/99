import { resolve } from 'node:path'
import { filterStartupAvailableRoots } from '../path/startupPathAvailabilityRuntime'

export interface StartupSchemaAuditDeps {
  openMergedIndexDb: () => Promise<any>
  openMachineInstallDbForRoot: (rootPath: string) => Promise<any>
  openLibraryDb: () => Promise<any>
  closeSqliteDb: (db: any) => void
  getSqliteMeta: (db: any, key: string, fallback?: string) => string | undefined
  appWatchedFolders: () => Promise<string[]>
  delayToEventLoop: () => Promise<void>
  appendStartupLog: (message: string) => void
}

export async function runStartupCriticalSchemaAudit(deps: StartupSchemaAuditDeps): Promise<void> {
  const startedAt = Date.now()
  const results: string[] = []
  let mergedDb: any | null = null
  try {
    mergedDb = await deps.openMergedIndexDb()
    const version = deps.getSqliteMeta(mergedDb, 'schemaVersion') || ''
    results.push(`merged-index:schema=${version}`)
  } catch (error) {
    results.push(`merged-index:error=${error instanceof Error ? error.message : String(error)}`)
  } finally {
    if (mergedDb) deps.closeSqliteDb(mergedDb)
  }

  try {
    const folders = await deps.appWatchedFolders().catch(() => [])
    const uniqueFolders = Array.from(new Set((folders || []).filter(Boolean).map((item) => resolve(item))))
    const { availableRoots, skippedRoots } = await filterStartupAvailableRoots(uniqueFolders, deps.appendStartupLog, 'startup-schema-audit')
    let checkedInstallDbs = 0
    for (const folder of availableRoots) {
      let db: any | null = null
      try {
        db = await deps.openMachineInstallDbForRoot(folder)
        checkedInstallDbs += 1
      } finally {
        if (db) deps.closeSqliteDb(db)
      }
      await deps.delayToEventLoop()
    }
    results.push(`install-status:roots=${checkedInstallDbs},skippedUnavailable=${skippedRoots.length}`)
  } catch (error) {
    results.push(`install-status:error=${error instanceof Error ? error.message : String(error)}`)
  }

  try {
    const libraryDb = await deps.openLibraryDb()
    const version = deps.getSqliteMeta(libraryDb, 'schemaVersion') || ''
    results.push(`library:schema=${version}`)
  } catch (error) {
    results.push(`library:error=${error instanceof Error ? error.message : String(error)}`)
  }

  deps.appendStartupLog(`startup critical schema audit finished: ${results.join(', ')}, elapsed=${Date.now() - startedAt}ms`)
}
