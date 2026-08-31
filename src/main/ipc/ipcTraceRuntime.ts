import { ipcMain } from "electron";
import { assertTrustedIpcSender } from "../security/ipcSenderValidation";
import { detailedStartupLogsEnabled } from "../logging/startupLogPolicy";
import type { IpcHandlerRuntime,IpcInvokeHandler } from "./ipcHandlerTypes";

const IPC_TRACE_SLOW_MS = 120
const IPC_TRACE_WARN_MS = 300

function ipcTraceSlowMs(channel: string): number {
  if (channel === 'fonts:checkSharedMetadataUpdates') return 600
  return IPC_TRACE_SLOW_MS
}

function ipcTraceWarnMs(channel: string): number {
  if (channel === 'fonts:checkSharedMetadataUpdates') return 1500
  return IPC_TRACE_WARN_MS
}

const IPC_TRACE_DETAILED_CHANNELS = new Set([
  'library:load',
  'library:loadShell',
  'library:save',
  'fonts:scanFolders',
  'fonts:loadFolderCache',
  'fonts:query',
  'fonts:queryPage',
  'fonts:getMetrics',
  'fonts:refreshInstallStatusIndex',
  'fonts:startInstallStatusRefreshIndex',
  'fonts:getInstallStatusIndex',
  'fonts:getSystemInstalledFonts',
  'fonts:scanSystemInstalledFonts',
  'fonts:compareManyInstalled',
  'fonts:activateFonts',
  'fonts:deactivateFonts',
  'fonts:installSystem',
  'fonts:uninstallSystem',
  'fonts:installCurrentUser',
  'fonts:uninstallManaged',
  'fonts:deleteFiles',
  'fonts:setFavorite',
  'fonts:setDeleteProtection',
  'fonts:setLocalTagsBatch',
  'fonts:setSharedTagsBatch',
  'fonts:renameSharedTag',
  'folders:refreshWatched',
  'folders:listPhysicalTree',
  'fonts:moveFileToFolder',
  'fonts:renderPreviewImage',
  'fonts:getCachedPreviewImage',
  'fonts:getCachedPreviewImages',
  'fonts:ensurePreviewCache',
  'fonts:getPreviewCacheStatus',
  'maintenance:healthCheck',
  'maintenance:run',
  'maintenance:createBackup',
  'cache:getStats',
  'cache:clearScanCache',
  'cache:clearPreviewCache',
  'tasks:runNow',
  'tasks:list'
])

const IPC_TRACE_IMPORTANT_RESULT_CHANNELS = new Set([
  'library:save',
  'fonts:scanFolders',
  'fonts:loadFolderCache',
  'fonts:refreshInstallStatusIndex',
  'fonts:startInstallStatusRefreshIndex',
  'fonts:activateFonts',
  'fonts:deactivateFonts',
  'fonts:installSystem',
  'fonts:uninstallSystem',
  'fonts:installCurrentUser',
  'fonts:uninstallManaged',
  'fonts:deleteFiles',
  'fonts:setFavorite',
  'fonts:setDeleteProtection',
  'fonts:setLocalTagsBatch',
  'fonts:setSharedTagsBatch',
  'fonts:renameSharedTag',
  'folders:refreshWatched',
  'fonts:moveFileToFolder',
  'maintenance:run',
  'maintenance:createBackup',
  'cache:clearScanCache',
  'cache:clearPreviewCache',
  'tasks:runNow'
])

function safeString(value: unknown, maxLength = 180): string {
  const text = String(value ?? '')
  if (text.startsWith('data:image/')) return `[data-url image length=${text.length}]`
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text
}

function summarizeFontItem(value: unknown): Record<string, unknown> {
  const item = (value || {}) as { id?: unknown; fileName?: unknown; path?: unknown; format?: unknown; fileSize?: unknown }
  return {
    id: safeString(item.id, 24),
    fileName: safeString(item.fileName, 80),
    format: safeString(item.format, 16),
    fileSize: typeof item.fileSize === 'number' ? item.fileSize : undefined,
    path: item.path ? safeString(item.path, 140) : undefined
  }
}

function summarizeValue(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value
  if (typeof value === 'string') return safeString(value, depth > 0 ? 140 : 220)
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (Array.isArray(value)) {
    const first = value.length > 0 ? summarizeValue(value[0], depth + 1) : undefined
    return { type: 'array', length: value.length, first }
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    if ('fileName' in record || 'path' in record) return summarizeFontItem(value)
    const keys = Object.keys(record)
    const summary: Record<string, unknown> = { type: 'object', keys: keys.slice(0, 12) }
    for (const key of keys.slice(0, 8)) {
      if (key.toLowerCase().includes('path')) summary[key] = safeString(record[key], 140)
      else if (key.toLowerCase().includes('text')) summary[key] = safeString(record[key], 60)
      else if (typeof record[key] !== 'object' || record[key] === null) summary[key] = summarizeValue(record[key], depth + 1)
      else if (Array.isArray(record[key])) summary[key] = { type: 'array', length: (record[key] as unknown[]).length }
    }
    return summary
  }
  return typeof value
}

function summarizeIpcArgs(channel: string, args: unknown[]): string {
  try {
    if (channel === 'fonts:queryPage' || channel === 'fonts:query') {
      const request = (args[0] || {}) as Record<string, unknown>
      const activeFilter = (request.activeFilter || {}) as Record<string, unknown>
      return JSON.stringify({
        sidebarPage: request.sidebarPage || request.page,
        keyword: safeString(request.keyword || request.search, 80),
        activeFilterKind: activeFilter.kind || 'all',
        activeFilterId: activeFilter.id,
        activeFilterName: activeFilter.name,
        installStatus: request.installStatus || 'all',
        sortMode: request.sortMode,
        timeSortMode: request.timeSortMode,
        selectedFolderId: request.selectedFolderId,
        selectedFolderPath: safeString(request.selectedFolderPath, 140),
        offset: request.offset,
        limit: request.limit,
        folders: Array.isArray(request.folders) ? request.folders.length : undefined,
        selectedWatchedFolders: Array.isArray(request.selectedWatchedFolders) ? request.selectedWatchedFolders.length : undefined,
        selectedFormats: Array.isArray(request.selectedFormats) ? request.selectedFormats.length : undefined,
        selectedScripts: Array.isArray(request.selectedScripts) ? request.selectedScripts.length : undefined
      })
    }
    return JSON.stringify(args.map((arg) => summarizeValue(arg)))
  } catch {
    return '[unserializable]'
  }
}

function summarizeIpcResult(channel: string, result: unknown): string {
  try {
    if (typeof result === 'string' && result.startsWith('data:image/')) {
      return JSON.stringify({ type: 'data-url-image', length: result.length, channel })
    }
    if (channel === 'fonts:getCachedPreviewImages' && result && typeof result === 'object') {
      const keys = Object.keys(result as Record<string, unknown>)
      const totalBytes = keys.reduce((sum, key) => {
        const value = (result as Record<string, unknown>)[key]
        return sum + (typeof value === 'string' ? value.length : 0)
      }, 0)
      return JSON.stringify({ type: 'preview-cache-batch', hits: keys.length, totalBytes })
    }
    if (result && typeof result === 'object') {
      const record = result as Record<string, unknown>
      if ('failed' in record || 'updatedIds' in record) {
        const failed = Array.isArray(record.failed) ? record.failed as Record<string, unknown>[] : []
        return JSON.stringify({
          ok: record.ok,
          updatedIds: Array.isArray(record.updatedIds) ? record.updatedIds.length : undefined,
          failed: failed.length,
          firstFailure: failed.length ? {
            id: safeString(failed[0].id, 24),
            fileName: safeString(failed[0].fileName, 80),
            message: safeString(failed[0].message, 180)
          } : undefined,
          message: safeString(record.message, 220)
        })
      }
      if ('items' in record || 'total' in record || 'fonts' in record || 'elapsedMs' in record) {
        return JSON.stringify({
          total: record.total,
          items: Array.isArray(record.items) ? record.items.length : undefined,
          fonts: Array.isArray(record.fonts) ? record.fonts.length : undefined,
          errors: Array.isArray(record.errors) ? record.errors.length : undefined,
          engine: record.engine,
          workerMode: record.workerMode,
          elapsedMs: record.elapsedMs,
          offset: record.offset,
          limit: record.limit,
          cacheHit: record.cacheHit,
          timings: record.timings
        })
      }
      if (channel.includes('InstallStatus') || channel.includes('installStatus') || 'missingIds' in record || 'updated' in record) {
        return JSON.stringify({
          total: record.total,
          updated: record.updated,
          missing: Array.isArray(record.missingIds) ? record.missingIds.length : record.missing,
          installed: record.installed,
          notInstalled: record.notInstalled,
          jobId: record.jobId,
          alreadyRunning: record.alreadyRunning
        })
      }
    }
    return JSON.stringify(summarizeValue(result))
  } catch {
    return '[unserializable]'
  }
}

function processMemorySummary(): { rssMb: number; heapUsedMb: number; heapTotalMb: number; externalMb: number } {
  const memory = process.memoryUsage()
  const toMb = (bytes: number): number => Math.round((bytes / 1024 / 1024) * 10) / 10
  return {
    rssMb: toMb(memory.rss),
    heapUsedMb: toMb(memory.heapUsed),
    heapTotalMb: toMb(memory.heapTotal),
    externalMb: toMb(memory.external)
  }
}

export function registerTracedIpcHandler(runtime: IpcHandlerRuntime, channel: string, handler: IpcInvokeHandler): void {
  ipcMain.handle(channel, async (event, ...args) => {
    assertTrustedIpcSender(event, channel, runtime.appendLog)
    const startedAt = Date.now()
    const cpuStarted = process.cpuUsage()
    const heapBefore = process.memoryUsage().heapUsed
    const detailedIpcLogs = detailedStartupLogsEnabled()
    const shouldTraceDetailed = IPC_TRACE_DETAILED_CHANNELS.has(channel)
    const shouldTraceStart = detailedIpcLogs && shouldTraceDetailed
    const argsSummary = shouldTraceDetailed ? summarizeIpcArgs(channel, args) : ''
    if (shouldTraceStart) {
      runtime.appendLog?.(`perf ipc start: channel=${channel}, sender=${event.sender.id}, args=${argsSummary}`)
    }
    try {
      runtime.assertFeatureForChannel?.(channel)
      const result = await handler(event, ...args)
      const elapsed = Date.now() - startedAt
      const cpu = process.cpuUsage(cpuStarted)
      const heapAfter = process.memoryUsage().heapUsed
      const slowMs = ipcTraceSlowMs(channel)
      const warnMs = ipcTraceWarnMs(channel)
      const severity = elapsed >= warnMs ? 'warn' : elapsed >= slowMs ? 'slow' : 'info'
      const shouldTraceEnd =
        (detailedIpcLogs && shouldTraceDetailed) ||
        elapsed >= slowMs ||
        IPC_TRACE_IMPORTANT_RESULT_CHANNELS.has(channel)
      if (shouldTraceEnd) {
        runtime.appendLog?.(
          `perf ipc end: channel=${channel}, severity=${severity}, status=ok, durationMs=${elapsed}, cpuUserMs=${Math.round(cpu.user / 1000)}, cpuSystemMs=${Math.round(cpu.system / 1000)}, heapDeltaMb=${Math.round(((heapAfter - heapBefore) / 1024 / 1024) * 10) / 10}, memory=${JSON.stringify(processMemorySummary())}, result=${summarizeIpcResult(channel, result)}`
        )
      }
      return result
    } catch (error) {
      const elapsed = Date.now() - startedAt
      const cpu = process.cpuUsage(cpuStarted)
      runtime.appendLog?.(
        `perf ipc end: channel=${channel}, severity=error, status=failed, durationMs=${elapsed}, cpuUserMs=${Math.round(cpu.user / 1000)}, cpuSystemMs=${Math.round(cpu.system / 1000)}, error=${error instanceof Error ? safeString(error.message, 240) : safeString(error, 240)}, args=${argsSummary || summarizeIpcArgs(channel, args)}`
      )
      throw error
    }
  })
}
