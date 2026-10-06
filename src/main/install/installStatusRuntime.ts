import { createInstallStatusCompareNormalizeRuntime } from './status/installStatusCompareNormalizeRuntime'
import { createInstallStatusDbOpenRuntime } from './status/installStatusDbOpenRuntime'
import { createInstallStatusDeleteRuntime } from './status/installStatusDeleteRuntime'
import { createInstallStatusMachineIdentityRuntime } from './status/installStatusMachineIdentity'
import { createInstallStatusReadRuntime } from './status/installStatusReadRuntime'
import { createInstallStatusSchemaRuntime } from './status/installStatusSchemaRuntime'
import { createInstallStatusSignatureRuntime } from './status/installStatusSignatureRuntime'
import { createInstallStatusSummaryRuntime } from './status/installStatusSummaryRuntime'
import type { InstallStatusDbRuntime,InstallStatusRuntimeDeps } from './status/installStatusTypes'
import { createInstallStatusWriteRuntime } from './status/installStatusWriteRuntime'

export type { InstallStatusReadWorkerGroup,InstallStatusRuntimeDeps,InstallStatusSaveWorkerGroup } from './status/installStatusTypes'
export type InstallStatusRuntime = ReturnType<typeof createInstallStatusRuntime>

export function createInstallStatusRuntime(deps: InstallStatusRuntimeDeps) {
  const signatureRuntime = createInstallStatusSignatureRuntime(deps)
  const machineIdentityRuntime = createInstallStatusMachineIdentityRuntime(deps)
  const schemaRuntime = createInstallStatusSchemaRuntime(deps)
  const dbOpenRuntime = createInstallStatusDbOpenRuntime(deps, {
    installStatusDbPathForRoot: machineIdentityRuntime.installStatusDbPathForRoot,
    fallbackInstallStatusDbPath: machineIdentityRuntime.fallbackInstallStatusDbPath,
    initializeMachineInstallDb: schemaRuntime.initializeMachineInstallDb
  })
  const dbRuntime: InstallStatusDbRuntime = {
    installStatusDbPathForRoot: machineIdentityRuntime.installStatusDbPathForRoot,
    fallbackInstallStatusDbPath: machineIdentityRuntime.fallbackInstallStatusDbPath,
    rootForFontPath: machineIdentityRuntime.rootForFontPath,
    openMachineInstallDbForRoot: dbOpenRuntime.openMachineInstallDbForRoot,
    openFallbackInstallDb: dbOpenRuntime.openFallbackInstallDb,
    initializeMachineInstallDb: schemaRuntime.initializeMachineInstallDb
  }
  const normalizeRuntime = createInstallStatusCompareNormalizeRuntime()
  const summaryRuntime = createInstallStatusSummaryRuntime(deps, {
    openMachineInstallDbForRoot: dbOpenRuntime.openMachineInstallDbForRoot
  })
  const readRuntime = createInstallStatusReadRuntime(deps, {
    ...dbRuntime,
    ...signatureRuntime,
    ...normalizeRuntime
  })
  const writeRuntime = createInstallStatusWriteRuntime(deps, {
    ...dbRuntime,
    ...signatureRuntime
  })
  const deleteRuntime = createInstallStatusDeleteRuntime(deps, dbRuntime)

  // All state writers share one short write lane. A background refresh captures
  // this revision before reading candidates and cannot overwrite newer targets.
  let writeRevision = 0
  let writeTail: Promise<void> = Promise.resolve()
  const itemWriteRevisions = new Map<string, number>()
  const serialize = (run: () => Promise<void>) => {
    const task = writeTail.catch(() => undefined).then(run)
    writeTail = task.catch(() => undefined)
    return task
  }
  const mark = (ids: string[], revision: number) => { for (const id of ids) itemWriteRevisions.set(id, Math.max(revision, itemWriteRevisions.get(id) || 0)) }
  const saveInstallStatusIndex: typeof writeRuntime.saveInstallStatusIndex = (results, items, options = {}) => {
    const revision = ++writeRevision
    if (options.expectedRevision === undefined) mark(Object.keys(results), revision)
    return serialize(async () => {
      const accepted = Object.fromEntries(Object.entries(results).filter(([id]) => options.expectedRevision === undefined || (itemWriteRevisions.get(id) || 0) <= options.expectedRevision))
      if (Object.keys(accepted).length !== Object.keys(results).length) deps.appendStartupLog(`install status stale refresh rows skipped: rows=${Object.keys(results).length - Object.keys(accepted).length}, expectedRevision=${options.expectedRevision}, revision=${writeRevision}`)
      if (!Object.keys(accepted).length) return
      mark(Object.keys(accepted), revision)
      await writeRuntime.saveInstallStatusIndex(accepted, items, options)
      options.onPersisted?.(Object.keys(accepted))
    })
  }
  const deleteInstallStatusIndex = (ids: string[]) => {
    mark(ids, ++writeRevision)
    return serialize(() => deleteRuntime.deleteInstallStatusIndex(ids))
  }
  return {
    ...signatureRuntime,
    ...machineIdentityRuntime,
    ...schemaRuntime,
    ...summaryRuntime,
    ...dbOpenRuntime,
    ...normalizeRuntime,
    ...readRuntime,
    ...writeRuntime,
    ...deleteRuntime,
    saveInstallStatusIndex, deleteInstallStatusIndex,
    installStatusWriteRevision: () => writeRevision,
  }
}
