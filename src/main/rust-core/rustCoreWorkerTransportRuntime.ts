import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { promises as fsp } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { RustCoreWorkerRuntimeOptions, RustCoreWorkerStatus } from './rustCoreWorkerContracts'
import type { RustCoreWorkerHandshake, RustCoreSchedulerProfilePayload } from './rustCoreWorkerPayloadTypes'
import { tryBuildRustCoreWorkerForDevelopment } from './rustCoreWorkerAutoBuildRuntime'
import { EXPECTED_RUST_CORE_PROTOCOL_VERSION, rustCoreWorkerIsCompatible } from './rustCoreProtocolRuntime'
import { resolveRustCoreWorkerPathWithDiagnostics } from './rustCoreWorkerPathRuntime'
import { createRustCoreSchedulerRuntime } from './rustCoreSchedulerRuntime'
import { createRustCoreDaemonRuntime, isRustCoreDaemonSubmittedError } from './rustCoreDaemonRuntime'

const execFileAsync = promisify(execFile)

export type RustCoreExecOptions = {
  timeout?: number
  windowsHide?: boolean
  maxBuffer?: number
  signal?: AbortSignal
}

export function parseJsonLine<T>(stdout: string): T {
  const line = stdout.split(/\r?\n/).map((entry) => entry.trim()).find(Boolean)
  if (!line) throw new Error('empty rust worker output')
  return JSON.parse(line) as T
}

function parseHandshake(stdout: string): RustCoreWorkerHandshake {
  return parseJsonLine<RustCoreWorkerHandshake>(stdout)
}

export function hasCapability(status: RustCoreWorkerStatus, capability: string): boolean {
  return Boolean(status.available && Array.isArray(status.capabilities) && status.capabilities.includes(capability))
}

function mergeAbortSignals(primary: AbortSignal, secondary?: AbortSignal): { signal: AbortSignal; cleanup: () => void } {
  if (!secondary) return { signal: primary, cleanup: () => undefined }
  const controller = new AbortController()
  const abort = (signal: AbortSignal) => {
    if (!controller.signal.aborted) controller.abort(signal.reason)
  }
  const onPrimaryAbort = () => abort(primary)
  const onSecondaryAbort = () => abort(secondary)
  if (primary.aborted) abort(primary)
  else primary.addEventListener('abort', onPrimaryAbort, { once: true })
  if (secondary.aborted) abort(secondary)
  else secondary.addEventListener('abort', onSecondaryAbort, { once: true })
  return {
    signal: controller.signal,
    cleanup: () => {
      primary.removeEventListener('abort', onPrimaryAbort)
      secondary.removeEventListener('abort', onSecondaryAbort)
    },
  }
}

function execOptionsWithoutExternalSignal(options: RustCoreExecOptions): Omit<RustCoreExecOptions, 'signal'> {
  const { signal: _signal, ...rest } = options
  return rest
}

type RustCoreJsonFile = {
  path: string
  writeJson: (value: unknown) => Promise<void>
  readText: () => Promise<string>
  dispose: () => Promise<void>
}

// The transport owns path allocation, encoding and best-effort deletion.
// Callers dispose in their original finally block to preserve settlement order.
function createTemporaryJsonFile(prefix: string): RustCoreJsonFile {
  const filePath = join(tmpdir(), `${prefix}-${process.pid}-${Date.now()}-${randomUUID()}.json`)
  return {
    path: filePath,
    writeJson: value => fsp.writeFile(filePath, JSON.stringify(value), 'utf-8'),
    readText: () => fsp.readFile(filePath, 'utf-8'),
    dispose: () => fsp.rm(filePath, { force: true }).catch(() => undefined),
  }
}

export function createRustCoreWorkerTransportRuntime(options: RustCoreWorkerRuntimeOptions) {
  let cachedStatus: RustCoreWorkerStatus | null = null
  const rustCoreScheduler = createRustCoreSchedulerRuntime({ appendStartupLog: options.appendStartupLog })
  const rustCoreDaemon = createRustCoreDaemonRuntime({
    appendStartupLog: options.appendStartupLog,
    onDomainEvent: options.onDaemonDomainEvent,
  })
  const previewCacheFailureLogState = new Map<string, { at: number; suppressed: number }>()
  const daemonCommandFailureLogState = new Map<string, { at: number; suppressed: number }>()

  function normalizePreviewCacheFailureMessage(message: string): string {
    return message
      .replace(/generation=\d+->\d+/g, 'generation=*')
      .replace(/maxQueued=\d+/g, 'maxQueued=*')
      .replace(/code=[^,;]+, signal=[^,;]+/g, 'daemon-exited')
      .slice(0, 180)
  }



  function appendDaemonCommandFailureLog(message: string, submitted: boolean): void {
    const normalized = normalizePreviewCacheFailureMessage(message)
    const key = `${submitted ? 'submitted' : 'fallback'}:${normalized}`
    const now = Date.now()
    const previous = daemonCommandFailureLogState.get(key)
    if (previous && now - previous.at < 8000) {
      previous.suppressed += 1
      return
    }
    const suppressedText = previous?.suppressed ? `, suppressed=${previous.suppressed}` : ''
    daemonCommandFailureLogState.set(key, { at: now, suppressed: 0 })
    options.appendStartupLog(submitted
      ? `rust core daemon command failed after submit: ${message}${suppressedText}; one-shot worker fallback blocked`
      : `rust core daemon command failed: ${message}${suppressedText}; one-shot worker fallback remains active`)
  }

  function appendPreviewCacheFailureLog(label: string, message: string): void {
    const key = `${label}:${normalizePreviewCacheFailureMessage(message)}`
    const now = Date.now()
    const previous = previewCacheFailureLogState.get(key)
    if (previous && now - previous.at < 8000) {
      previous.suppressed += 1
      return
    }
    const suppressedText = previous?.suppressed ? `, suppressed=${previous.suppressed}` : ''
    previewCacheFailureLogState.set(key, { at: now, suppressed: 0 })
    options.appendStartupLog(`rust preview cache ${label} failed: ${message}${suppressedText}; Node fallback remains active`)
  }

  async function runRustCoreScheduledCommand(workerPath: string, args: string[], execOptions: RustCoreExecOptions): Promise<{ stdout: string; stderr: string; daemon?: boolean }> {
    const daemonResult = await rustCoreDaemon.tryRun(workerPath, args, execOptions).catch((error) => {
      if (error instanceof Error && error.name === 'AbortError') throw error
      if (isRustCoreDaemonSubmittedError(error)) {
        appendDaemonCommandFailureLog(error.message, true)
        throw error
      }
      appendDaemonCommandFailureLog(error instanceof Error ? error.message : String(error), false)
      return null
    })
    if (daemonResult) return { ...daemonResult, daemon: true }
    const result = await rustCoreScheduler.run(args, async (schedulerSignal) => {
      const mergedSignal = mergeAbortSignals(schedulerSignal, execOptions.signal)
      try {
        return await execFileAsync(workerPath, args, { ...execOptionsWithoutExternalSignal(execOptions), signal: mergedSignal.signal }) as { stdout: string; stderr: string }
      } finally {
        mergedSignal.cleanup()
      }
    })
    return { ...result, daemon: false }
  }

  function invalidateRustCoreSchedulerCaches(commands?: string[]): number {
    return rustCoreScheduler.invalidate(commands)
  }

  function cancelRustCoreSchedulerScopes(scopes: string[]): number {
    return rustCoreScheduler.cancelScopes(scopes)
  }

  function noteRustCoreSchedulerInteractiveActivity(reason?: string): void {
    rustCoreScheduler.markInteractiveActivity(reason || 'external')
  }

  async function loadRustCoreSchedulerProfile(workerPath: string): Promise<void> {
    try {
      const startedAt = Date.now()
      const { stdout } = await execFileAsync(workerPath, ['--core-scheduler-profile'], {
        timeout: 1500,
        windowsHide: true,
        maxBuffer: 512 * 1024,
      })
      const payload = parseJsonLine<RustCoreSchedulerProfilePayload>(stdout)
      if (!payload.ok) throw new Error(payload.message || 'scheduler profile returned ok=false')
      const applied = rustCoreScheduler.applyProfiles(payload.profiles || [], `rust-worker:${payload.schedulerVersion || 'unknown'}`, payload.queuePolicy)
      options.appendStartupLog(`rust core scheduler profile loaded from worker: applied=${applied}, schedulerVersion=${payload.schedulerVersion || 'unknown'}, elapsedMs=${Date.now() - startedAt}`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      options.appendStartupLog(`rust core scheduler profile load failed: ${message}; node-default profile remains active`)
    }
  }

  async function diagnoseRustCoreWorker(): Promise<RustCoreWorkerStatus> {
    if (cachedStatus) return cachedStatus

    if (!options.enabled) {
      cachedStatus = { available: false, message: 'disabled by HFM_RUST_CORE=0' }
      options.appendStartupLog(`rust core worker: disabled, message=${cachedStatus.message}`)
      return cachedStatus
    }

    let pathResolution = resolveRustCoreWorkerPathWithDiagnostics()
    let workerPath = pathResolution.path
    if (!workerPath) {
      const autoBuild = tryBuildRustCoreWorkerForDevelopment()
      if (autoBuild.attempted || autoBuild.built) {
        options.appendStartupLog(`rust core worker auto-build: built=${autoBuild.built}, message=${autoBuild.message}${autoBuild.targetPath ? `, target=${autoBuild.targetPath}` : ''}`)
        pathResolution = resolveRustCoreWorkerPathWithDiagnostics()
        workerPath = pathResolution.path
      }
    }

    if (!workerPath) {
      const candidates = pathResolution.candidates.slice(0, 8).join(' | ')
      const message = 'not found; JS/Node scan and query fallback remains active'
      cachedStatus = { available: false, message }
      options.appendStartupLog(`rust core worker: unavailable, ${message}; run npm run rust:build or keep HFM_RUST_CORE_AUTOBUILD=1; candidates=${candidates}`)
      if (options.required) throw new Error(`Rust core worker required but ${message}`)
      return cachedStatus
    }

    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const startedAt = Date.now()
        const { stdout } = await execFileAsync(workerPath, ['--handshake'], {
          timeout: 1500,
          windowsHide: true,
          maxBuffer: 256 * 1024,
        })
        const handshake = parseHandshake(stdout)
        if (!handshake.ok) {
          throw new Error(handshake.message || 'handshake returned ok=false')
        }
        const status: RustCoreWorkerStatus = {
          available: true,
          path: workerPath,
          version: handshake.version || 'unknown',
          protocolVersion: handshake.protocolVersion || 0,
          capabilities: Array.isArray(handshake.capabilities) ? handshake.capabilities : [],
        }
        const compatibility = rustCoreWorkerIsCompatible(status)
        if (!compatibility.ok) {
          if (attempt === 0) {
            options.appendStartupLog(`rust core worker stale: ${compatibility.message}, path=${workerPath}; attempting development auto-build`)
            const autoBuild = tryBuildRustCoreWorkerForDevelopment()
            options.appendStartupLog(`rust core worker auto-build: built=${autoBuild.built}, message=${autoBuild.message}${autoBuild.targetPath ? `, target=${autoBuild.targetPath}` : ''}`)
            if (autoBuild.built) {
              pathResolution = resolveRustCoreWorkerPathWithDiagnostics()
              workerPath = pathResolution.path || workerPath
              continue
            }
          }
          cachedStatus = { ...status, available: false, message: compatibility.message }
          options.appendStartupLog(`rust core worker incompatible: ${compatibility.message}, path=${workerPath}; JS/Node scan fallback remains active`)
          if (options.required) throw new Error(`Rust core worker required but ${compatibility.message}`)
          return cachedStatus
        }
        cachedStatus = status
        await loadRustCoreSchedulerProfile(workerPath)
        options.appendStartupLog(`rust core worker ready: version=${cachedStatus.version}, protocol=${cachedStatus.protocolVersion}, expectedProtocol>=${EXPECTED_RUST_CORE_PROTOCOL_VERSION}, capabilities=${cachedStatus.capabilities?.join(',') || 'none'}, path=${workerPath}, handshakeMs=${Date.now() - startedAt}`)
        return cachedStatus
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        cachedStatus = { available: false, path: workerPath, message }
        options.appendStartupLog(`rust core worker failed: ${message}, path=${workerPath}; JS/Node fallback remains active`)
        if (options.required) throw error
        return cachedStatus
      }
    }

    cachedStatus = { available: false, path: workerPath, message: 'incompatible rust worker after auto-build retry' }
    if (options.required) throw new Error(cachedStatus.message)
    return cachedStatus
  }
  return {
    diagnoseRustCoreWorker,
    rustCoreWorkerStatus: () => cachedStatus,
    invalidateRustCoreSchedulerCaches,
    cancelRustCoreSchedulerScopes,
    noteRustCoreSchedulerInteractiveActivity,
    rustCoreDaemonStatus: () => {
      rustCoreDaemon.pollStatus()
      return rustCoreDaemon.status()
    },
    stopRustCoreDaemon: rustCoreDaemon.stop,
    runRustCoreScheduledCommand,
    appendPreviewCacheFailureLog,
    createTemporaryJsonFile,
  }
}

export type RustCoreWorkerTransportRuntime = ReturnType<typeof createRustCoreWorkerTransportRuntime>
