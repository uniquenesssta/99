import { parseJsonLine, hasCapability } from '../rustCoreWorkerTransportRuntime'
import type { SystemInstalledFont } from '../../../shared/types'
import {
  rethrowRustCoreDaemonSubmittedJob,
  markRustCoreDaemonSubmittedError,
} from '../rustCoreDaemonWriteBoundaryRuntime'
import type {
  RustSystemInstalledFontsInput,
  RustSystemInstalledFontsResult,
  RustPhysicalFolderTreeInput,
  RustPhysicalFolderTreeResult,
  RustFontActivationFilesInput,
  RustFontActivationFilesResult,
  RustFontResourceBatchResult,
  RustFontRegistryResult,
  RustFontNotifyResult,
} from '../rustCoreWorkerContracts'
import type {
  RustSystemInstalledFontsPayload,
  RustPhysicalFolderTreePayload,
  RustFontActivationFilesPayload,
  RustFontResourceBatchPayload,
  RustFontRegistryPayload,
  RustFontNotifyPayload,
} from '../rustCoreWorkerPayloadTypes'
import type { RustCoreWorkerRuntimeOptions } from '../rustCoreWorkerContracts'
import type { RustCoreWorkerTransportRuntime } from '../rustCoreWorkerTransportRuntime'

export type RustWindowsClientOptions = Pick<RustCoreWorkerTransportRuntime,
  'diagnoseRustCoreWorker' | 'runRustCoreScheduledCommand' | 'createTemporaryJsonFile'> & Pick<RustCoreWorkerRuntimeOptions, 'appendStartupLog'>

export function createRustWindowsClientRuntime(options: RustWindowsClientOptions) {
  const { diagnoseRustCoreWorker, runRustCoreScheduledCommand, createTemporaryJsonFile } = options

  async function runRustFontResourceAdd(paths: string[], options: { notify?: boolean; reason?: string; strong?: boolean } = {}): Promise<RustFontResourceBatchResult | null> {
    return runRustFontResourceBatch('add', '--font-resource-add', 'font-resource-add', paths, options)
  }

  async function runRustFontResourceRemove(paths: string[], options: { notify?: boolean; reason?: string; strong?: boolean } = {}): Promise<RustFontResourceBatchResult | null> {
    return runRustFontResourceBatch('remove', '--font-resource-remove', 'font-resource-remove', paths, options)
  }

  async function runRustFontResourceBatch(
    label: 'add' | 'remove',
    command: string,
    capability: string,
    paths: string[],
    batchOptions: { notify?: boolean; reason?: string; strong?: boolean } = {},
  ): Promise<RustFontResourceBatchResult | null> {
    const status = await diagnoseRustCoreWorker()
    if (!status.available || !status.path || !hasCapability(status, capability)) return null

    const cleanPaths = Array.from(new Set(paths.filter(Boolean)))
    if (!cleanPaths.length) return {}

    const startedAt = Date.now()
    const inputFile = createTemporaryJsonFile(`hfm-rust-font-resource-${label}`)
    const inputPath = inputFile.path
    try {
      await inputFile.writeJson({ paths: cleanPaths, notify: Boolean(batchOptions.notify), strong: Boolean(batchOptions.strong) })
      const commandOutput = await runRustCoreScheduledCommand(status.path, [command, '--input', inputPath], {
        timeout: Math.max(5000, Number(process.env.HFM_RUST_FONT_RESOURCE_TIMEOUT_MS || 60 * 1000) || 60 * 1000),
        windowsHide: true,
        maxBuffer: 8 * 1024 * 1024,
      })
      const payload = parseJsonLine<RustFontResourceBatchPayload>(commandOutput.stdout)
      if (!Array.isArray(payload.results)) {
        const error = new Error(payload.message || `rust font resource ${label} returned no results`)
        throw commandOutput.daemon ? markRustCoreDaemonSubmittedError(error, command) : error
      }
      const results: RustFontResourceBatchResult = {}
      for (const row of payload.results) {
        const path = String(row.path || '')
        if (!path) continue
        results[path] = {
          ok: Boolean(row.ok),
          count: Number(row.count || 0),
          message: String(row.message || ''),
        }
      }
      const okCount = Number(payload.count || Object.values(results).filter((entry) => entry.ok).length)
      const failedCount = Number(payload.failed || Object.values(results).filter((entry) => !entry.ok).length)
      const workerElapsed = Number(payload.elapsedMs || Date.now() - startedAt)
      options.appendStartupLog(`rust font resource ${label} finished: reason=${batchOptions.reason || 'n/a'}, paths=${cleanPaths.length}, ok=${okCount}, failed=${failedCount}, elapsed=${Date.now() - startedAt}ms, workerElapsed=${workerElapsed}ms`)
      return results
    } catch (error) {
      rethrowRustCoreDaemonSubmittedJob(error, options.appendStartupLog, `rust font resource ${label}`)
      options.appendStartupLog(`rust font resource ${label} failed: ${error instanceof Error ? error.message : String(error)}; native helper fallback remains active`)
      return null
    } finally {
      await inputFile.dispose()
    }
  }

  async function runRustFontRegistryApply(records: Array<{ name: string; path: string }>): Promise<RustFontRegistryResult | null> {
    return runRustFontRegistryCommand('apply', '--font-registry-apply', 'font-registry-apply', { records })
  }

  async function runRustFontRegistryDelete(names: string[]): Promise<RustFontRegistryResult | null> {
    return runRustFontRegistryCommand('delete', '--font-registry-delete', 'font-registry-delete', { names })
  }

  async function runRustFontRegistryCommand(
    label: 'apply' | 'delete',
    command: string,
    capability: string,
    input: unknown,
  ): Promise<RustFontRegistryResult | null> {
    const status = await diagnoseRustCoreWorker()
    if (!status.available || !status.path || !hasCapability(status, capability)) return null

    const startedAt = Date.now()
    const inputFile = createTemporaryJsonFile(`hfm-rust-font-registry-${label}`)
    const inputPath = inputFile.path
    try {
      await inputFile.writeJson(input)
      const commandOutput = await runRustCoreScheduledCommand(status.path, [command, '--input', inputPath], {
        timeout: Math.max(5000, Number(process.env.HFM_RUST_FONT_REGISTRY_TIMEOUT_MS || 60 * 1000) || 60 * 1000),
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024,
      })
      const payload = parseJsonLine<RustFontRegistryPayload>(commandOutput.stdout)
      if (!payload.ok) {
        const error = new Error(payload.message || `rust font registry ${label} returned ok=false`)
        throw commandOutput.daemon ? markRustCoreDaemonSubmittedError(error, command) : error
      }
      const result: RustFontRegistryResult = {
        ok: true,
        count: Number(payload.count || 0),
        failed: Number(payload.failed || 0),
        elapsedMs: Number(payload.elapsedMs || Date.now() - startedAt),
        workerMode: label === 'apply' ? 'rust-font-registry-apply' : 'rust-font-registry-delete',
      }
      options.appendStartupLog(`rust font registry ${label} finished: count=${result.count}, failed=${result.failed}, elapsed=${Date.now() - startedAt}ms, workerElapsed=${result.elapsedMs}ms`)
      return result
    } catch (error) {
      rethrowRustCoreDaemonSubmittedJob(error, options.appendStartupLog, `rust font registry ${label}`)
      options.appendStartupLog(`rust font registry ${label} failed: ${error instanceof Error ? error.message : String(error)}; native helper fallback remains active`)
      return null
    } finally {
      await inputFile.dispose()
    }
  }

  async function runRustFontChangeNotify(input: { strong?: boolean; reason?: string } = {}): Promise<RustFontNotifyResult | null> {
    const status = await diagnoseRustCoreWorker()
    if (!status.available || !status.path || !hasCapability(status, 'font-resource-notify')) return null

    const startedAt = Date.now()
    const inputFile = createTemporaryJsonFile(`hfm-rust-font-notify`)
    const inputPath = inputFile.path
    try {
      await inputFile.writeJson({ strong: Boolean(input.strong) })
      const commandOutput = await runRustCoreScheduledCommand(status.path, ['--font-resource-notify', '--input', inputPath], {
        timeout: Math.max(1000, Number(process.env.HFM_RUST_FONT_NOTIFY_TIMEOUT_MS || 3000) || 3000),
        windowsHide: true,
        maxBuffer: 1024 * 1024,
      })
      const payload = parseJsonLine<RustFontNotifyPayload>(commandOutput.stdout)
      if (!payload.ok) {
        const error = new Error(payload.message || 'rust font notify returned ok=false')
        throw commandOutput.daemon ? markRustCoreDaemonSubmittedError(error, '--font-resource-notify') : error
      }
      const result: RustFontNotifyResult = {
        ok: true,
        elapsedMs: Number(payload.elapsedMs || Date.now() - startedAt),
        workerMode: 'rust-font-change-notify',
      }
      options.appendStartupLog(`rust WM_FONTCHANGE ${input.strong ? 'strong' : 'light'} broadcast sent: ${input.reason || 'manual'}, elapsed=${Date.now() - startedAt}ms, workerElapsed=${result.elapsedMs}ms`)
      return result
    } catch (error) {
      rethrowRustCoreDaemonSubmittedJob(error, options.appendStartupLog, 'rust WM_FONTCHANGE')
      options.appendStartupLog(`rust WM_FONTCHANGE failed: ${error instanceof Error ? error.message : String(error)}; native helper fallback remains active`)
      return null
    } finally {
      await inputFile.dispose()
    }
  }

  async function runRustPhysicalFolderTree(input: RustPhysicalFolderTreeInput): Promise<RustPhysicalFolderTreeResult | null> {
    const status = await diagnoseRustCoreWorker()
    if (!status.available || !status.path || !hasCapability(status, 'physical-folder-tree')) return null

    const startedAt = Date.now()
    const inputFile = createTemporaryJsonFile(`hfm-rust-folder-tree`)
    const inputPath = inputFile.path
    try {
      await inputFile.writeJson(input)
      const { stdout } = await runRustCoreScheduledCommand(status.path, ['--physical-folder-tree', '--input', inputPath], {
        timeout: Math.max(5000, Number(process.env.HFM_RUST_FOLDER_TREE_TIMEOUT_MS || 2 * 60 * 1000) || 2 * 60 * 1000),
        windowsHide: true,
        maxBuffer: 32 * 1024 * 1024,
      })
      const payload = parseJsonLine<RustPhysicalFolderTreePayload>(stdout)
      if (!payload.ok || !Array.isArray(payload.folders) || !Array.isArray(payload.nodes)) throw new Error(payload.message || 'rust physical folder tree returned ok=false')
      const result: RustPhysicalFolderTreeResult = {
        folders: payload.folders.filter((folder): folder is string => typeof folder === 'string'),
        nodes: payload.nodes.map((node) => ({
          id: String(node.id || ''),
          name: String(node.name || ''),
          parentId: String(node.parentId || ''),
          rootPath: String(node.rootPath || ''),
          createdAt: String(node.createdAt || ''),
        })).filter((node) => Boolean(node.id && node.name)),
        errors: Array.isArray(payload.errors) ? payload.errors.map(String) : [],
        elapsedMs: Number(payload.elapsedMs || Date.now() - startedAt),
        workerMode: 'rust-physical-folder-tree',
      }
      options.appendStartupLog(`rust physical folder tree finished: roots=${result.folders.length}, nodes=${result.nodes.length}, errors=${result.errors.length}, elapsed=${Date.now() - startedAt}ms, workerElapsed=${result.elapsedMs}ms`)
      return result
    } catch (error) {
      options.appendStartupLog(`rust physical folder tree failed: ${error instanceof Error ? error.message : String(error)}; Node fallback remains active`)
      return null
    } finally {
      await inputFile.dispose()
    }
  }

  async function runRustFontActivationFiles(input: RustFontActivationFilesInput): Promise<RustFontActivationFilesResult | null> {
    const status = await diagnoseRustCoreWorker()
    if (!status.available || !status.path || !hasCapability(status, 'font-activation-files')) return null

    const startedAt = Date.now()
    const inputFile = createTemporaryJsonFile(`hfm-rust-activation-files`)
    const inputPath = inputFile.path
    try {
      await inputFile.writeJson(input)
      const commandOutput = await runRustCoreScheduledCommand(status.path, ['--font-activation-files', '--input', inputPath], {
        timeout: Math.max(5000, Number(process.env.HFM_RUST_ACTIVATION_FILES_TIMEOUT_MS || 2 * 60 * 1000) || 2 * 60 * 1000),
        windowsHide: true,
        maxBuffer: 8 * 1024 * 1024,
      })
      const payload = parseJsonLine<RustFontActivationFilesPayload>(commandOutput.stdout)
      if (!payload.ok) {
        const error = new Error(payload.message || 'rust font activation files returned ok=false')
        throw commandOutput.daemon ? markRustCoreDaemonSubmittedError(error, '--font-activation-files') : error
      }
      const result: RustFontActivationFilesResult = {
        ok: true,
        copied: Number(payload.copied || 0),
        reused: Number(payload.reused || 0),
        deleted: Number(payload.deleted || 0),
        failed: Number(payload.failed || 0),
        copyResults: Array.isArray(payload.copyResults) ? payload.copyResults.map((row) => ({ id: String(row.id || ''), source: String(row.source || ''), dest: String(row.dest || ''), ok: Boolean(row.ok), mode: String(row.mode || ''), message: String(row.message || '') })) : [],
        deleteResults: Array.isArray(payload.deleteResults) ? payload.deleteResults.map((row) => ({ path: String(row.path || ''), ok: Boolean(row.ok), message: String(row.message || '') })) : [],
        elapsedMs: Number(payload.elapsedMs || Date.now() - startedAt),
        workerMode: 'rust-font-activation-files',
      }
      options.appendStartupLog(`rust font activation files finished: copied=${result.copied}, reused=${result.reused}, deleted=${result.deleted}, failed=${result.failed}, elapsed=${Date.now() - startedAt}ms, workerElapsed=${result.elapsedMs}ms`)
      return result
    } catch (error) {
      rethrowRustCoreDaemonSubmittedJob(error, options.appendStartupLog, 'rust font activation files')
      options.appendStartupLog(`rust font activation files failed: ${error instanceof Error ? error.message : String(error)}; Node fallback remains active`)
      return null
    } finally {
      await inputFile.dispose()
    }
  }

  async function runRustSystemInstalledFonts(input: RustSystemInstalledFontsInput): Promise<RustSystemInstalledFontsResult | null> {
    const status = await diagnoseRustCoreWorker()
    if (!status.available || !status.path || !hasCapability(status, 'system-installed-fonts')) return null

    const startedAt = Date.now()
    try {
      const args = [
        '--system-installed-fonts',
        '--windows-fonts-dir', input.windowsFontsDir,
        '--current-user-fonts-dir', input.currentUserFontsDir,
        '--extensions', input.extensions.map((value) => value.replace(/^\./, '').toLowerCase()).join(','),
      ]
      if (input.includeNameCandidates) args.push('--include-name-candidates')

      const { stdout } = await runRustCoreScheduledCommand(status.path, args, {
        timeout: Math.max(5000, Number(process.env.HFM_RUST_SYSTEM_INSTALLED_FONTS_TIMEOUT_MS || 60 * 1000) || 60 * 1000),
        windowsHide: true,
        maxBuffer: 32 * 1024 * 1024,
      })

      const payload = parseJsonLine<RustSystemInstalledFontsPayload>(stdout)
      if (!payload.ok || !Array.isArray(payload.items)) throw new Error(payload.message || 'rust system installed fonts returned ok=false')
      const items = payload.items.filter((item): item is SystemInstalledFont => {
        return !!item && typeof item.source === 'string' && typeof item.registryName === 'string' && typeof item.value === 'string'
      })
      const result: RustSystemInstalledFontsResult = {
        items,
        count: Number(payload.count ?? items.length),
        registryCount: Number(payload.registryCount || 0),
        folderCount: Number(payload.folderCount || 0),
        elapsedMs: Number(payload.elapsedMs || Date.now() - startedAt),
        workerMode: 'rust-system-installed-fonts',
      }
      options.appendStartupLog(`rust system installed fonts read finished: items=${result.items.length}, registry=${result.registryCount}, folder=${result.folderCount}, includeNameCandidates=${Boolean(input.includeNameCandidates)}, elapsed=${Date.now() - startedAt}ms, workerElapsed=${result.elapsedMs}ms`)
      return result
    } catch (error) {
      options.appendStartupLog(`rust system installed fonts read failed: ${error instanceof Error ? error.message : String(error)}; Node fallback remains active`)
      return null
    }
  }

  return {
    runRustFontResourceAdd,
    runRustFontResourceRemove,
    runRustFontRegistryApply,
    runRustFontRegistryDelete,
    runRustFontChangeNotify,
    runRustPhysicalFolderTree,
    runRustFontActivationFiles,
    runRustSystemInstalledFonts,
  }
}
