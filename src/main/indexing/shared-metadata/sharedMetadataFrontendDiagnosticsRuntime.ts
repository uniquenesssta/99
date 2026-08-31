import type { SharedMetadataRepairOptions, SharedMetadataRepairReport } from './sharedMetadataRepairRuntime'
import type { SharedMetadataMigrationDiagnosticsReport } from './sharedMetadataMigrationDiagnosticsRuntime'
import type { SharedTagOpsConflictReport, SharedTagOpsDiagnosticsReport, SharedTagOpsReplayReport } from './sharedTagOpsReplayRuntime'

export type SharedMetadataFrontendDiagnosticsOptions = {
  roots?: string[]
  synchronize?: boolean
  includeRepairDryRun?: boolean
}

export type SharedMetadataFrontendRepairOptions = SharedMetadataRepairOptions & {
  roots?: string[]
  apply?: boolean
  synchronizeAfterRepair?: boolean
}

export type SharedMetadataRootFrontendDiagnostics = {
  ok: boolean
  rootPath: string
  dbPath: string
  exists: boolean
  synchronized: boolean
  replay?: SharedTagOpsReplayReport
  migration?: SharedMetadataMigrationDiagnosticsReport
  tagOps?: SharedTagOpsDiagnosticsReport
  conflicts?: SharedTagOpsConflictReport
  repairDryRun?: SharedMetadataRepairReport
  severity: 'ok' | 'info' | 'warning' | 'critical'
  suggestedActions: string[]
  error?: string
}

export type SharedMetadataFrontendDiagnosticsReport = {
  ok: boolean
  checkedAt: string
  roots: number
  existingRoots: number
  synchronizedRoots: number
  severity: 'ok' | 'info' | 'warning' | 'critical'
  summary: {
    invalidTagJsonRows: number
    missingTagOps: number
    conflicts: number
    revisionTies: number
    latestRemovalConflicts: number
    multiMachineConflicts: number
    orphanTagOps: number
    archivedOrphanTagOps: number
    purgedOrphanTagOps: number
  }
  reports: SharedMetadataRootFrontendDiagnostics[]
  suggestedActions: string[]
}

export type SharedMetadataFrontendRepairReport = {
  ok: boolean
  repairedAt: string
  dryRun: boolean
  roots: number
  existingRoots: number
  appliedRoots: number
  reports: Array<{
    rootPath: string
    dbPath: string
    exists: boolean
    repair?: SharedMetadataRepairReport
    replay?: SharedTagOpsReplayReport
    error?: string
  }>
  suggestedActions: string[]
}

export interface SharedMetadataFrontendDiagnosticsRuntimeDeps {
  appWatchedFolders: () => Promise<string[]>
  uniqueResolvedFolders: (folders: string[]) => string[]
  exists: (filePath: string) => Promise<boolean>
  sharedMetadataDbPathForRoot: (rootPath: string) => string
  openSharedMetadataDb: (rootPath: string, touch?: boolean) => Promise<any>
  closeSqliteDb: (db: any) => void
  ensureSharedTagOpsBackfilledInOpenDb: (db: any, rootPath: string, reason?: string) => unknown
  ensureSharedTagOpsReplayedInOpenDb: (db: any, rootPath: string, reason?: string) => SharedTagOpsReplayReport
  readSharedTagOpsDiagnosticsInOpenDb: (db: any, rootPath: string) => SharedTagOpsDiagnosticsReport
  readSharedTagOpsConflictReportInOpenDb: (db: any, rootPath: string) => SharedTagOpsConflictReport
  readSharedMetadataMigrationDiagnosticsInOpenDb: (db: any, rootPath: string) => SharedMetadataMigrationDiagnosticsReport
  repairSharedMetadataInOpenDb: (db: any, rootPath: string, options?: SharedMetadataRepairOptions) => SharedMetadataRepairReport
  appendStartupLog: (message: string) => void
}

const SEVERITY_WEIGHT = {
  ok: 0,
  info: 1,
  warning: 2,
  critical: 3,
} as const

type Severity = keyof typeof SEVERITY_WEIGHT

function maxSeverity(values: Array<Severity | undefined>): Severity {
  return values.reduce<Severity>((max, value) => {
    if (!value) return max
    return SEVERITY_WEIGHT[value] > SEVERITY_WEIGHT[max] ? value : max
  }, 'ok')
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => String(value || '').trim()).filter(Boolean)))
}

function toRootList(input: string[] | undefined, fallback: string[], uniqueResolvedFolders: (folders: string[]) => string[]): string[] {
  const roots = Array.isArray(input) && input.length ? input : fallback
  return uniqueResolvedFolders(roots)
}

export function createSharedMetadataFrontendDiagnosticsRuntime(deps: SharedMetadataFrontendDiagnosticsRuntimeDeps) {
  async function readSharedMetadataFrontendDiagnostics(
    options: SharedMetadataFrontendDiagnosticsOptions = {},
  ): Promise<SharedMetadataFrontendDiagnosticsReport> {
    const checkedAt = new Date().toISOString()
    const roots = toRootList(options.roots, await deps.appWatchedFolders(), deps.uniqueResolvedFolders)
    const reports: SharedMetadataRootFrontendDiagnostics[] = []
    let existingRoots = 0
    let synchronizedRoots = 0

    for (const rootPath of roots) {
      const dbPath = deps.sharedMetadataDbPathForRoot(rootPath)
      try {
        const hasDb = await deps.exists(dbPath)
        if (!hasDb) {
          reports.push({
            ok: true,
            rootPath,
            dbPath,
            exists: false,
            synchronized: false,
            severity: 'info',
            suggestedActions: ['shared metadata database does not exist yet; it will be created after the first shared tag/favorite/protection write'],
          })
          continue
        }

        existingRoots += 1
        const db = await deps.openSharedMetadataDb(rootPath, false)
        try {
          let replay: SharedTagOpsReplayReport | undefined
          if (options.synchronize === true) {
            replay = deps.ensureSharedTagOpsReplayedInOpenDb(db, rootPath, 'frontend-diagnostics')
            synchronizedRoots += 1
          } else {
            deps.ensureSharedTagOpsBackfilledInOpenDb(db, rootPath, 'frontend-diagnostics-readonly')
          }
          const migration = deps.readSharedMetadataMigrationDiagnosticsInOpenDb(db, rootPath)
          const tagOps = deps.readSharedTagOpsDiagnosticsInOpenDb(db, rootPath)
          const conflicts = deps.readSharedTagOpsConflictReportInOpenDb(db, rootPath)
          const repairDryRun = options.includeRepairDryRun === false
            ? undefined
            : deps.repairSharedMetadataInOpenDb(db, rootPath, { dryRun: true })
          const severity = maxSeverity([
            migration.severity,
            conflicts.severity,
            repairDryRun && !repairDryRun.ok ? 'warning' : 'ok',
          ])
          const suggestedActions = uniqueStrings([
            ...migration.suggestedActions,
            ...conflicts.suggestedActions,
            ...(repairDryRun?.suggestedActions || []),
          ])
          reports.push({
            ok: severity !== 'critical',
            rootPath,
            dbPath,
            exists: true,
            synchronized: options.synchronize === true,
            replay,
            migration,
            tagOps,
            conflicts,
            repairDryRun,
            severity,
            suggestedActions,
          })
        } finally {
          deps.closeSqliteDb(db)
        }
      } catch (error) {
        reports.push({
          ok: false,
          rootPath,
          dbPath,
          exists: false,
          synchronized: false,
          severity: 'critical',
          suggestedActions: ['inspect shared metadata database path and SQLite availability before running repair'],
          error: errorMessage(error),
        })
      }
    }

    const severity = maxSeverity(reports.map((report) => report.severity))
    const suggestedActions = uniqueStrings(reports.flatMap((report) => report.suggestedActions))
    const summary = reports.reduce<SharedMetadataFrontendDiagnosticsReport['summary']>((acc, report) => {
      acc.invalidTagJsonRows += report.migration?.invalidTagJsonRows || report.repairDryRun?.invalidTagJsonRows || 0
      acc.missingTagOps += report.migration?.missingTagOps || 0
      acc.conflicts += report.conflicts?.conflicts || 0
      acc.revisionTies += report.conflicts?.revisionTies || 0
      acc.latestRemovalConflicts += report.conflicts?.latestRemovalConflicts || 0
      acc.multiMachineConflicts += report.conflicts?.multiMachineConflicts || 0
      acc.orphanTagOps += report.repairDryRun?.orphanTagOps || 0
      acc.archivedOrphanTagOps += report.repairDryRun?.archivedOrphanTagOps || 0
      acc.purgedOrphanTagOps += report.repairDryRun?.purgedOrphanTagOps || 0
      return acc
    }, {
      invalidTagJsonRows: 0,
      missingTagOps: 0,
      conflicts: 0,
      revisionTies: 0,
      latestRemovalConflicts: 0,
      multiMachineConflicts: 0,
      orphanTagOps: 0,
      archivedOrphanTagOps: 0,
      purgedOrphanTagOps: 0,
    })

    return {
      ok: severity !== 'critical',
      checkedAt,
      roots: roots.length,
      existingRoots,
      synchronizedRoots,
      severity,
      summary,
      reports,
      suggestedActions: suggestedActions.length ? suggestedActions : ['no shared metadata action required'],
    }
  }

  async function repairSharedMetadataFromFrontend(
    options: SharedMetadataFrontendRepairOptions = {},
  ): Promise<SharedMetadataFrontendRepairReport> {
    const repairedAt = new Date().toISOString()
    const roots = toRootList(options.roots, await deps.appWatchedFolders(), deps.uniqueResolvedFolders)
    const dryRun = options.apply !== true
    const reports: SharedMetadataFrontendRepairReport['reports'] = []
    let existingRoots = 0
    let appliedRoots = 0

    for (const rootPath of roots) {
      const dbPath = deps.sharedMetadataDbPathForRoot(rootPath)
      try {
        const hasDb = await deps.exists(dbPath)
        if (!hasDb) {
          reports.push({ rootPath, dbPath, exists: false })
          continue
        }
        existingRoots += 1
        const db = await deps.openSharedMetadataDb(rootPath, false)
        try {
          const repair = deps.repairSharedMetadataInOpenDb(db, rootPath, {
            ...options,
            dryRun,
          })
          let replay: SharedTagOpsReplayReport | undefined
          if (!dryRun) {
            appliedRoots += 1
            if (options.synchronizeAfterRepair !== false) {
              replay = deps.ensureSharedTagOpsReplayedInOpenDb(db, rootPath, 'frontend-repair')
            }
          }
          reports.push({ rootPath, dbPath, exists: true, repair, replay })
        } finally {
          deps.closeSqliteDb(db)
        }
      } catch (error) {
        reports.push({ rootPath, dbPath, exists: false, error: errorMessage(error) })
      }
    }

    const suggestedActions = uniqueStrings(reports.flatMap((report) => report.repair?.suggestedActions || []))
    const ok = reports.every((report) => !report.error && (report.repair ? report.repair.ok || dryRun : true))
    if (!dryRun) {
      deps.appendStartupLog(`shared metadata frontend repair: roots=${roots.length}, existing=${existingRoots}, applied=${appliedRoots}`)
    }
    return {
      ok,
      repairedAt,
      dryRun,
      roots: roots.length,
      existingRoots,
      appliedRoots,
      reports,
      suggestedActions: suggestedActions.length ? suggestedActions : ['no shared metadata repair action required'],
    }
  }

  return {
    readSharedMetadataFrontendDiagnostics,
    repairSharedMetadataFromFrontend,
  }
}
