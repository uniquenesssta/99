import { assertLocalShutdownWorkAllowed } from '../app/shutdownCoordinatorRuntime'
import type { ChildProcess } from 'node:child_process'
import { getStartupPathRootState, markStartupPathRootUnavailable } from '../path/startupPathAvailabilityRuntime'
import { sharedIoAvailabilityRoot } from './rustSharedIoCommandRuntime'
import { configureSharedFileExecutor } from '../path/sharedFileSystemRuntime'
import { traceRustInput, logOperation } from '../logging/operationTraceContext'
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
import { applicationSharedIoProcessRuntime, SharedIoProcessError } from '../path/sharedIoProcessRuntime'
import { sharedIoResourceKeys, sharedIoPathsInInput, type RustSharedIoTarget } from './rustSharedIoCommandRuntime'
import { stopSharedPathProbes } from '../path/sharedPathProbeRuntime'

const execFileAsync = promisify(execFile)

export type RustCoreExecOptions = {
  timeout?: number
  windowsHide?: boolean
  maxBuffer?: number
  signal?: AbortSignal
  sharedIo?: RustSharedIoTarget
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
function allocateTemporaryJsonFile(prefix: string): RustCoreJsonFile {
  const filePath = join(tmpdir(), `${prefix}-${process.pid}-${Date.now()}-${randomUUID()}.json`)
  return {
    path: filePath,
    writeJson: value => fsp.writeFile(filePath, JSON.stringify(traceRustInput(value)), 'utf-8'),
    readText: () => fsp.readFile(filePath, 'utf-8'),
    dispose: () => fsp.rm(filePath, { force: true }).catch(() => undefined),
  }
}

export function createRustCoreWorkerTransportRuntime(options: RustCoreWorkerRuntimeOptions) {
  let cachedStatus: RustCoreWorkerStatus | null = null
  let transportStopped = false
  const localChildren = new Set<ChildProcess>()
  const sharedIo = applicationSharedIoProcessRuntime(options.appendStartupLog)
  const temporaryFiles = new Map<string, { holds: number; disposed: boolean; file: RustCoreJsonFile; input?: unknown }>()
  function createTemporaryJsonFile(prefix: string): RustCoreJsonFile {
    const file = allocateTemporaryJsonFile(prefix)
    const entry: { holds: number; disposed: boolean; file: RustCoreJsonFile; input?: unknown } = { holds: 0, disposed: false, file }
    temporaryFiles.set(file.path, entry)
    return { ...file, writeJson: async value => {
      const snapshot = JSON.parse(JSON.stringify(value))
      await file.writeJson(snapshot)
      entry.input = snapshot
    }, dispose: async () => {
      entry.disposed = true
      if (entry.holds) return
      temporaryFiles.delete(file.path)
      await file.dispose()
    } }
  }
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

  async function runRustCoreScheduledCommand(workerPath: string, args: string[], execOptions: RustCoreExecOptions): Promise<{ stdout: string; stderr: string; daemon?: boolean; sharedIo?: boolean }> {
    assertLocalShutdownWorkAllowed()
    if (transportStopped) throw new SharedIoProcessError('原生执行器已经停止。', 'not-started', 'stopping')
    // Copy caller-owned identities before awaiting mapping discovery.
    const inferredPaths = sharedIoPathsInInput([args, ...args.map(path => temporaryFiles.get(path)?.input)])
    const target = execOptions.sharedIo
      ? { paths: [...execOptions.sharedIo.paths], write: execOptions.sharedIo.write }
      : inferredPaths.length ? { paths: inferredPaths, write: true } : undefined
    execOptions = { ...execOptions, sharedIo: target }
    args = [...args]
    const roots = target ? await sharedIoResourceKeys(target.paths) : []
    // Preflight writes must never enter a replaceable/cached daemon read lane.
    if (!roots.length && target?.write && args[0] === '--shared-metadata-overlay-read') roots.push(`local-metadata:${target.paths.join('|').toLowerCase()}`)
    if (roots.length) {
      const rootGenerations = new Map(target!.paths.map(sharedIoAvailabilityRoot).filter((root): root is string => !!root).map(root => [root,getStartupPathRootState(root).generation]));
      const admit = () => [...rootGenerations].every(([root,generation]) => {
        const current = getStartupPathRootState(root);
        return current.generation === generation && current.state !== 'offline';
      });
      const leased = [...new Set(args)].map(path => temporaryFiles.get(path)).filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
      for (const entry of leased) entry.holds += 1
      const onClose = () => {
        for (const entry of leased) {
          entry.holds -= 1
          if (!entry.holds && entry.disposed) {
            temporaryFiles.delete(entry.file.path)
            void entry.file.dispose()
          }
        }
      }
      logOperation({ stage: 'backend-submit', backend: 'rust', transport: 'shared-one-shot' }, options.appendStartupLog)
      const result = await sharedIo.run({ file: workerPath, args, roots, write: target!.write,
        timeoutMs: Math.min(30000, Math.max(100, execOptions.timeout || 30000)),
        queueTimeoutMs: 3000, maxBuffer: execOptions.maxBuffer, signal: execOptions.signal, onClose, admit }).catch(error => {
          if (error.reason === 'timeout') for (const root of rootGenerations.keys()) markStartupPathRootUnavailable(root,error,options.appendStartupLog,'isolated-io-timeout')
          logOperation({ stage: 'transport-result', outcome: error.outcome || 'unknown', reason: error.reason || 'worker-rejected', transport: 'shared-one-shot' }, options.appendStartupLog)
          throw error
        })
      for (const line of result.stderr.split(/\r?\n/)) if (line.startsWith('operation-chain: ')) {
        try { logOperation(JSON.parse(line.slice(17)), options.appendStartupLog) } catch { /* Preserve the worker result. */ }
      }
      if (!target!.write && !admit()) throw new SharedIoProcessError('共享根状态已变化，旧读取结果已丢弃。','unknown','stale-generation')
      // A malformed success envelope can follow a commit. It must never trigger a fallback write.
      try {
        const payload = parseJsonLine<{ ok?: boolean }>(result.stdout)
        if (payload.ok !== true && !(args[0] === '--shared-file-io' && payload.ok === false)) throw new Error('worker returned ok=false')
      } catch (error) {
        throw new SharedIoProcessError(`Shared I/O invalid receipt: ${String(error)}`, 'unknown', 'invalid-receipt')
      }
      return { ...result, daemon: false, sharedIo: true }
    }
    assertLocalShutdownWorkAllowed()
    if (transportStopped) throw new SharedIoProcessError('原生执行器已经停止。', 'not-started', 'stopping')
    logOperation({ stage: 'backend-submit', backend: 'rust', transport: 'daemon-probe' }, options.appendStartupLog)
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
    logOperation({ stage: 'backend-submit', backend: 'rust', transport: 'one-shot' }, options.appendStartupLog)
    const result = await rustCoreScheduler.run(args, async (schedulerSignal) => {
      const mergedSignal = mergeAbortSignals(schedulerSignal, execOptions.signal)
      try {
        assertLocalShutdownWorkAllowed()
        if (transportStopped) throw new SharedIoProcessError('原生执行器已经停止。', 'not-started', 'stopping')
        const execution = execFileAsync(workerPath, args, { ...execOptionsWithoutExternalSignal(execOptions), signal: mergedSignal.signal,
          env: { ...process.env, HFM_PARENT_PID: String(process.pid) }, killSignal: 'SIGKILL' })
        if (execution.child) {
          localChildren.add(execution.child)
          execution.child.once('close', () => localChildren.delete(execution.child))
        }
        return await execution as { stdout: string; stderr: string }
      } catch (error) {
        const stderr = error && typeof error === 'object' ? (error as { stderr?: unknown }).stderr : undefined
        if (typeof stderr === 'string') {
          for (const line of stderr.split(/\r?\n/)) if (line.startsWith('operation-chain: ')) {
            try { logOperation(JSON.parse(line.slice(17)), options.appendStartupLog) } catch { /* Preserve original error. */ }
          }
        }
        logOperation({ stage: 'transport-result', outcome: 'unknown', reason: 'worker-rejected', transport: 'one-shot' }, options.appendStartupLog)
        throw error
      } finally {
        mergedSignal.cleanup()
      }
    })
    for (const line of result.stderr.split(/\r?\n/)) {
      if (line.startsWith('operation-chain: ')) {
        try { logOperation(JSON.parse(line.slice(17)), options.appendStartupLog) } catch { /* Best effort diagnostic. */ }
      }
    }
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
  configureSharedFileExecutor(async (request, bytes) => {
    const status = await diagnoseRustCoreWorker()
    if (!status.available || !status.path || !hasCapability(status, 'shared-file-io-v1')) throw new SharedIoProcessError('原生 worker 不支持共享文件隔离。', 'not-started', 'capability-unavailable')
    const inputFile = createTemporaryJsonFile('hfm-shared-file-input')
    const transferFile = createTemporaryJsonFile('hfm-shared-file-transfer')
    let retainSnapshot = false
    const write = !['stat','lstat','access','realpath','readdir','readFile','sqliteSnapshot','treeSnapshot'].includes(request.operation)
    try {
      if (bytes) await fsp.writeFile(transferFile.path, bytes)
      else if (request.operation === 'readFile') await transferFile.writeJson(null)
      const input = { ...request, transferPath: transferFile.path }
      await inputFile.writeJson(input)
      const output = await runRustCoreScheduledCommand(status.path, ['--shared-file-io','--input',inputFile.path,'--transfer',transferFile.path], {
        timeout: ['stat','lstat','access','realpath','openFile'].includes(request.operation) ? 500 : write ? 5000 : 2000,
        windowsHide: true, maxBuffer: 32*1024*1024, sharedIo: { paths: [request.path, request.dest || ''], write },
      })
      const result = parseJsonLine<import('../path/sharedFileSystemRuntime').SharedFileResult>(output.stdout)
      if (typeof result.ok !== 'boolean' || result.operation !== request.operation) throw new SharedIoProcessError('共享文件隔离回执无效。','unknown','invalid-receipt')
      if (!result.ok && write) throw Object.assign(new SharedIoProcessError(result.message || '共享文件写入结果未确认。', result.code === 'EEXIST' ? 'not-started' : 'unknown', 'file-write-failed'), {code:result.code})
      if (result.ok && request.operation === 'sqliteSnapshot') {
        retainSnapshot = true
        return { result, snapshotPath: transferFile.path, dispose: transferFile.dispose }
      }
      return { result, bytes: result.ok && request.operation === 'readFile' ? await fsp.readFile(transferFile.path) : undefined }
    } finally {
      await inputFile.dispose()
      if (!retainSnapshot) await transferFile.dispose()
    }
  })
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
    stopRustCoreDaemon: () => {
      transportStopped = true
      sharedIo.stop(); stopSharedPathProbes(); rustCoreDaemon.stopImmediately()
      for (const child of localChildren) {
        try { child.kill('SIGKILL') } catch (error) { options.appendStartupLog(`local worker termination failed: ${String(error)}`) }
      }
    },
    runRustCoreScheduledCommand,
    appendPreviewCacheFailureLog,
    createTemporaryJsonFile,
  }
}

export type RustCoreWorkerTransportRuntime = ReturnType<typeof createRustCoreWorkerTransportRuntime>
