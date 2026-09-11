import { parseJsonLine, hasCapability } from '../rustCoreWorkerTransportRuntime'
import { rethrowRustCoreDaemonSubmittedJob, markRustCoreDaemonSubmittedError } from '../rustCoreDaemonWriteBoundaryRuntime'
import type { RustDatabaseHealthCheckInput, RustDatabaseHealthCheckResult, RustDatabaseBackupInput, RustDatabaseBackupResult } from '../rustCoreWorkerContracts'
import type { RustDatabaseHealthCheckPayload, RustDatabaseBackupPayload } from '../rustCoreWorkerPayloadTypes'
import type { RustCoreWorkerRuntimeOptions } from '../rustCoreWorkerContracts'
import type { RustCoreWorkerTransportRuntime } from '../rustCoreWorkerTransportRuntime'

export type RustMaintenanceClientOptions = Pick<RustCoreWorkerTransportRuntime,
  'diagnoseRustCoreWorker' | 'runRustCoreScheduledCommand' | 'createTemporaryJsonFile'> & Pick<RustCoreWorkerRuntimeOptions, 'appendStartupLog'>

export function createRustMaintenanceClientRuntime(options: RustMaintenanceClientOptions) {
  const { diagnoseRustCoreWorker, runRustCoreScheduledCommand, createTemporaryJsonFile } = options

  async function runRustDatabaseHealthCheck(input: RustDatabaseHealthCheckInput): Promise<RustDatabaseHealthCheckResult | null> {
    const status = await diagnoseRustCoreWorker()
    if (!status.available || !status.path || !hasCapability(status, 'database-health-check')) return null

    const payload = await runRustDatabaseMaintenanceInputCommand<RustDatabaseHealthCheckPayload>('health-check', '--database-health-check', input, { allowOkFalse: true })
    if (!payload || !Array.isArray(payload.items)) return null
    return {
      items: payload.items.map((item) => ({
        label: String(item.label || ''),
        filePath: String(item.filePath || ''),
        ok: Boolean(item.ok),
        message: String(item.message || ''),
      })),
      elapsedMs: Number(payload.elapsedMs || 0),
      workerMode: 'rust-database-health-check',
    }
  }

  async function runRustDatabaseBackup(input: RustDatabaseBackupInput): Promise<RustDatabaseBackupResult | null> {
    const status = await diagnoseRustCoreWorker()
    if (!status.available || !status.path || !hasCapability(status, 'database-backup')) return null

    const payload = await runRustDatabaseMaintenanceInputCommand<RustDatabaseBackupPayload>('backup', '--database-backup', input)
    if (!payload || !payload.ok || !Array.isArray(payload.items) || !payload.backupDir) return null
    return {
      ok: Boolean(payload.ok),
      reason: String(payload.reason || input.reason),
      backupDir: String(payload.backupDir),
      items: payload.items.map((item) => ({
        label: String(item.label || ''),
        sourcePath: String(item.sourcePath || ''),
        backupPath: typeof item.backupPath === 'string' ? item.backupPath : undefined,
        ok: Boolean(item.ok),
        sizeBytes: Number(item.sizeBytes || 0),
        message: String(item.message || ''),
      })),
      createdAt: String(payload.createdAt || input.createdAt),
      elapsedMs: Number(payload.elapsedMs || 0),
      workerMode: 'rust-database-backup',
    }
  }

  async function runRustDatabaseMaintenanceInputCommand<T extends { ok?: boolean; message?: string }>(label: string, command: string, input: unknown, commandOptions: { allowOkFalse?: boolean } = {}): Promise<T | null> {
    const status = await diagnoseRustCoreWorker()
    if (!status.available || !status.path) return null

    const startedAt = Date.now()
    const inputFile = createTemporaryJsonFile(`hfm-rust-db-maintenance-${label}`)
    const inputPath = inputFile.path
    try {
      await inputFile.writeJson(input)
      const commandOutput = await runRustCoreScheduledCommand(status.path, [command, '--input', inputPath], {
        timeout: Math.max(5000, Number(process.env.HFM_RUST_DATABASE_MAINTENANCE_TIMEOUT_MS || 5 * 60 * 1000) || 5 * 60 * 1000),
        windowsHide: true,
        maxBuffer: 8 * 1024 * 1024,
      })
      const payload = parseJsonLine<T>(commandOutput.stdout)
      if (!payload.ok && !commandOptions.allowOkFalse) {
        const error = new Error(payload.message || `rust database maintenance ${label} returned ok=false`)
        throw commandOutput.daemon ? markRustCoreDaemonSubmittedError(error, command) : error
      }
      options.appendStartupLog(`rust database maintenance ${label} finished: elapsed=${Date.now() - startedAt}ms`)
      return payload
    } catch (error) {
      rethrowRustCoreDaemonSubmittedJob(error, options.appendStartupLog, `rust database maintenance ${label}`)
      options.appendStartupLog(`rust database maintenance ${label} failed: ${error instanceof Error ? error.message : String(error)}; Node fallback remains active`)
      return null
    } finally {
      await inputFile.dispose()
    }
  }

  return { runRustDatabaseHealthCheck, runRustDatabaseBackup }
}
