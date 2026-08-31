import type { BackgroundTaskStatus } from "../../tasks/backgroundTasks";
import type { IpcHandleRegistrar,IpcHandlerRuntime,RendererPerformanceEventPayload } from "../ipcHandlerTypes";

export function registerMaintenanceIpcHandlers(handle: IpcHandleRegistrar, runtime: IpcHandlerRuntime): void {
  handle("cache:getStats", () => runtime.getCacheStats());
  handle("cache:getArchitecture", () => runtime.cacheArchitectureInfo());
  handle("diagnostics:getMigrationStatus", () => runtime.getMigrationDiagnostics?.() || { unavailable: true });
  handle("diagnostics:clearMigrationStatus", () => {
    runtime.clearMigrationDiagnostics?.();
    return runtime.getMigrationDiagnostics?.() || { ok: true };
  });
  handle("sharedMetadata:getDiagnostics", (_event, options?: { roots?: string[]; synchronize?: boolean; includeRepairDryRun?: boolean }) =>
    runtime.readSharedMetadataFrontendDiagnostics?.(options || {}) || { unavailable: true },
  );
  handle("sharedMetadata:repair", (_event, options?: { roots?: string[]; apply?: boolean; synchronizeAfterRepair?: boolean; repairInvalidTagJson?: boolean; purgeInvalidTagOps?: boolean; archiveOrphanTagOps?: boolean; purgeArchivedOrphanTagOps?: boolean; orphanArchiveReason?: string }) =>
    runtime.repairSharedMetadataFromFrontend?.(options || {}) || { unavailable: true },
  );
  handle("sharedIndexSnapshots:getDiagnostics", () =>
    runtime.readSharedIndexSnapshotFrontendDiagnostics?.() || { unavailable: true },
  );
  handle("sharedIndexSnapshots:repair", (_event, options?: { apply?: boolean }) =>
    runtime.repairSharedIndexSnapshotFromFrontend?.(options || {}) || { unavailable: true },
  );
  handle("cache:clearScanCache", () => runtime.clearScanCache());
  handle("cache:clearPreviewCache", () => runtime.clearPreviewCache());
  handle("maintenance:healthCheck", () => runtime.runDatabaseHealthCheck());
  handle("maintenance:createBackup", (_event, reason?: string) => runtime.createDatabaseBackup(reason || "manual"));
  handle("maintenance:run", () =>
    runtime.runDatabaseMaintenance({
      createBackup: true,
      backupReason: "manual-maintenance",
    }),
  );
  handle("maintenance:restoreLatestBackup", (_event, label: "library" | "tasks" | "preview") =>
    runtime.restoreLatestApplicationDatabase(label),
  );
  handle("tasks:list", (_event, status?: BackgroundTaskStatus, limit?: number) =>
    runtime.listBackgroundTaskSummaries(status, limit),
  );
  handle("tasks:runNow", () =>
    runtime.runBackgroundTaskSchedulerOnce().then(() => runtime.backgroundTaskSchedulerStatus()),
  );
  handle("tasks:getSchedulerStatus", () => runtime.backgroundTaskSchedulerStatus());
  handle("performance:userActivity", (_event, durationMs?: number, reason?: string) =>
    runtime.markRendererUserActivity(durationMs, reason),
  );
  handle("performance:rendererLongTask", (_event, payload: { durationMs?: number; name?: string; startTime?: number; source?: string }) =>
    runtime.reportRendererLongTask(payload || {}),
  );
  handle("performance:rendererTrace", (_event, payload: RendererPerformanceEventPayload) =>
    runtime.reportPerformanceEvent?.(payload || {}) || { ok: true },
  );
}
