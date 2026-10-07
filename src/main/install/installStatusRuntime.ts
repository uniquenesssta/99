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

  return {
    ...signatureRuntime,
    ...machineIdentityRuntime,
    ...schemaRuntime,
    ...summaryRuntime,
    ...dbOpenRuntime,
    ...normalizeRuntime,
    ...readRuntime,
    ...writeRuntime,
    ...deleteRuntime
  }
}
