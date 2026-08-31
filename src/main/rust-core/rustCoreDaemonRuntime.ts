import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface, type Interface } from 'node:readline'
import { randomUUID } from 'node:crypto'
import { RUST_CORE_DAEMON_SAFE_COMMANDS, RUST_CORE_DAEMON_SAFE_COMMAND_SUMMARY, rustCoreDaemonBlocksOneShotFallbackAfterSubmit } from './rustCoreDaemonCommandPolicy'

export type RustCoreDaemonExecOptions = {
  timeout?: number
  windowsHide?: boolean
  maxBuffer?: number
  signal?: AbortSignal
}

export type RustCoreDaemonDomainEvent = {
  id?: string
  command?: string
  lane?: string
  domain?: string
  event?: string
  stateSignal?: unknown
  mutationProtocol?: unknown
  indexProtocol?: unknown
}

export type RustCoreDaemonRuntimeOptions = {
  appendStartupLog: (message: string) => void
  onDomainEvent?: (event: RustCoreDaemonDomainEvent) => void
}

type RustCoreDaemonJobView = { id?: string; command?: string; lane?: string; sequence?: number }

export type RustCoreDaemonSubmittedError = Error & {
  daemonSubmitted?: true
  command?: string
}

export function isRustCoreDaemonSubmittedError(error: unknown): error is RustCoreDaemonSubmittedError {
  return Boolean(error && typeof error === 'object' && (error as RustCoreDaemonSubmittedError).daemonSubmitted)
}

function abortError(signal?: AbortSignal): Error {
  const reason = signal?.reason
  const message = reason instanceof Error ? reason.message : typeof reason === 'string' && reason.trim() ? reason.trim() : 'Rust core daemon job cancelled'
  const error = new Error(message)
  error.name = 'AbortError'
  return error
}

function cleanupJob(job: PendingDaemonJob): void {
  if (job.timeoutTimer) clearTimeout(job.timeoutTimer)
  if (job.abortListener && job.signal) job.signal.removeEventListener('abort', job.abortListener)
}

function submittedError(command: string, message: string): RustCoreDaemonSubmittedError {
  const error = new Error(message) as RustCoreDaemonSubmittedError
  error.daemonSubmitted = true
  error.command = command
  return error
}


type RustCoreDaemonEvent = {
  id?: string
  type?: string
  ok?: boolean
  command?: string
  lane?: string
  stage?: string
  progress?: number
  metadataBarrierWaitMs?: number
  sequence?: number
  domain?: string
  event?: string
  stateSignal?: unknown
  mutationProtocol?: unknown
  indexProtocol?: unknown
  stdout?: string
  stderr?: string
  message?: string
  elapsedMs?: number
  queued?: number
  running?: RustCoreDaemonJobView | RustCoreDaemonJobView[] | null
  queuedJobs?: RustCoreDaemonJobView[]
  lanes?: Array<{ lane?: string; queued?: number; running?: number }>
  completed?: number
  cancelled?: number
  failed?: number
  rejected?: number
  nextSequence?: number
  writeBarrier?: {
    queuedWrites?: number
    runningWrites?: number
    metadataBarrierWaits?: number
    metadataBarrierTimeouts?: number
  }
}

export type RustCoreDaemonStatus = {
  enabled: boolean
  running: boolean
  pending: number
  safeCommands: string[]
  rustState?: {
    queued: number
    running: RustCoreDaemonJobView | RustCoreDaemonJobView[] | null
    queuedJobs: RustCoreDaemonJobView[]
    lanes: Array<{ lane: string; queued: number; running: number }>
    completed: number
    cancelled: number
    failed: number
    rejected: number
    nextSequence?: number
    writeBarrier?: {
      queuedWrites: number
      runningWrites: number
      metadataBarrierWaits: number
      metadataBarrierTimeouts: number
    }
  }
  recentEvents: RustCoreDaemonRecentEvent[]
}

type RustCoreDaemonRecentEvent = {
  at: number
  id?: string
  type: string
  command?: string
  lane?: string
  stage?: string
  progress?: number
  metadataBarrierWaitMs?: number
  sequence?: number
  domain?: string
  event?: string
}

type PendingDaemonJob = {
  id: string
  command: string
  startedAt: number
  maxBuffer: number
  timeoutTimer: ReturnType<typeof setTimeout> | null
  resolve: (value: { stdout: string; stderr: string }) => void
  reject: (error: unknown) => void
  abortListener?: () => void
  signal?: AbortSignal
}

const DAEMON_SAFE_COMMANDS = new Set<string>(RUST_CORE_DAEMON_SAFE_COMMANDS)

function daemonEnabled(): boolean {
  const mode = String(process.env.HFM_RUST_CORE_DAEMON || '1').trim().toLowerCase()
  return mode !== '0' && mode !== 'false' && mode !== 'off'
}

function commandFromArgs(args: string[]): string {
  return args.find((arg) => arg.startsWith('--')) || '*'
}

function safeMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function createRustCoreDaemonRuntime(options: RustCoreDaemonRuntimeOptions) {
  const enabled = daemonEnabled()
  const pending = new Map<string, PendingDaemonJob>()
  let child: ChildProcessWithoutNullStreams | null = null
  let lineReader: Interface | null = null
  let childPath = ''
  let stderrTail = ''
  let loggedDisabled = false
  let loggedReady = false
  let exitHookInstalled = false
  let rustState: RustCoreDaemonStatus['rustState'] | undefined
  let stdinErrorLoggedAt = 0
  const recentEvents: RustCoreDaemonRecentEvent[] = []

  function logDaemonStdinError(error: unknown): void {
    const now = Date.now()
    if (now - stdinErrorLoggedAt < 5000) return
    stdinErrorLoggedAt = now
    options.appendStartupLog(`rust core daemon stdin error: ${safeMessage(error)}; one-shot worker fallback remains active`)
  }

  function writeDaemonLine(line: string): boolean {
    const active = child
    if (!active || active.killed || active.stdin.destroyed || !active.stdin.writable) return false
    try {
      active.stdin.write(`${line}\n`, (error) => {
        if (error) logDaemonStdinError(error)
      })
      return true
    } catch (error) {
      logDaemonStdinError(error)
      return false
    }
  }

  function canRun(args: string[]): boolean {
    return enabled && DAEMON_SAFE_COMMANDS.has(commandFromArgs(args))
  }

  function stop(): void {
    const active = child
    child = null
    lineReader?.close()
    lineReader = null
    childPath = ''
    rustState = undefined
    recentEvents.length = 0
    if (active && !active.killed) {
      try {
        writeDaemonLine(JSON.stringify({ type: 'shutdown' }))
      } catch {
        // ignore shutdown write failures; kill below is the fallback
      }
      active.kill()
    }
  }

  function rejectJob(job: PendingDaemonJob, message: string): void {
    const error = rustCoreDaemonBlocksOneShotFallbackAfterSubmit(job.command)
      ? submittedError(job.command, message)
      : new Error(message)
    job.reject(error)
  }

  function rejectAll(message: string): void {
    for (const job of pending.values()) {
      cleanupJob(job)
      rejectJob(job, message)
    }
    pending.clear()
  }

  function rememberEvent(event: RustCoreDaemonEvent): void {
    if (!event.type) return
    recentEvents.push({
      at: Date.now(),
      id: event.id,
      type: event.type,
      command: event.command,
      lane: event.lane,
      stage: event.stage,
      progress: typeof event.progress === 'number' ? event.progress : undefined,
      metadataBarrierWaitMs: typeof event.metadataBarrierWaitMs === 'number' ? event.metadataBarrierWaitMs : undefined,
      sequence: typeof event.sequence === 'number' ? event.sequence : undefined,
      domain: event.domain,
      event: event.event,
    })
    if (recentEvents.length > 120) recentEvents.splice(0, recentEvents.length - 120)
  }

  function handleStatusEvent(event: RustCoreDaemonEvent): void {
    rustState = {
      queued: Number(event.queued || 0),
      running: event.running || null,
      queuedJobs: Array.isArray(event.queuedJobs) ? event.queuedJobs : [],
      lanes: Array.isArray(event.lanes) ? event.lanes.map((lane) => ({
        lane: String(lane.lane || 'unknown'),
        queued: Number(lane.queued || 0),
        running: Number(lane.running || 0),
      })) : [],
      completed: Number(event.completed || 0),
      cancelled: Number(event.cancelled || 0),
      failed: Number(event.failed || 0),
      rejected: Number(event.rejected || 0),
      nextSequence: typeof event.nextSequence === 'number' ? event.nextSequence : undefined,
      writeBarrier: event.writeBarrier && typeof event.writeBarrier === 'object' ? {
        queuedWrites: Number(event.writeBarrier.queuedWrites || 0),
        runningWrites: Number(event.writeBarrier.runningWrites || 0),
        metadataBarrierWaits: Number(event.writeBarrier.metadataBarrierWaits || 0),
        metadataBarrierTimeouts: Number(event.writeBarrier.metadataBarrierTimeouts || 0),
      } : undefined,
    }
  }

  function handleLine(line: string): void {
    const trimmed = line.trim()
    if (!trimmed) return
    let event: RustCoreDaemonEvent
    try {
      event = JSON.parse(trimmed) as RustCoreDaemonEvent
    } catch (error) {
      options.appendStartupLog(`rust core daemon protocol parse failed: ${safeMessage(error)}`)
      return
    }

    if (event.type === 'daemon_progress') {
      rememberEvent(event)
      return
    }

    if (event.type === 'domain_event') {
      rememberEvent(event)
      try {
        options.onDomainEvent?.({
          id: event.id,
          command: event.command,
          lane: event.lane,
          domain: event.domain,
          event: event.event,
          stateSignal: event.stateSignal,
          mutationProtocol: event.mutationProtocol,
          indexProtocol: event.indexProtocol,
        })
      } catch (error) {
        options.appendStartupLog(`rust core daemon domain event handler failed: ${safeMessage(error)}`)
      }
      return
    }

    if (event.type === 'daemon_ready') {
      if (!loggedReady) {
        loggedReady = true
        options.appendStartupLog(`rust core daemon ready: mode=stdio-job-runtime, safeCommands=${RUST_CORE_DAEMON_SAFE_COMMAND_SUMMARY}`)
      }
      return
    }

    if (event.type === 'daemon_status') {
      handleStatusEvent(event)
      return
    }

    if (!event.id) return
    const job = pending.get(event.id)
    if (!job) return

    if (event.type === 'job_started') return
    if (event.type === 'job_queued') return
    if (event.type === 'job_cancel_requested') return

    if (event.type === 'job_cancelled') {
      pending.delete(event.id)
      cleanupJob(job)
      rejectJob(job, `rust core daemon job cancelled: ${job.command}`)
      return
    }

    if (event.type === 'job_finished') {
      pending.delete(event.id)
      cleanupJob(job)
      const stdout = typeof event.stdout === 'string' ? event.stdout : ''
      const stderr = typeof event.stderr === 'string' ? event.stderr : ''
      if (stdout.length > job.maxBuffer) {
        rejectJob(job, `rust core daemon output exceeded maxBuffer: command=${job.command}, bytes=${stdout.length}, maxBuffer=${job.maxBuffer}`)
        return
      }
      job.resolve({ stdout, stderr })
      return
    }

    if (event.type === 'job_failed') {
      pending.delete(event.id)
      cleanupJob(job)
      const stdout = typeof event.stdout === 'string' ? event.stdout : ''
      if (stdout) {
        job.resolve({ stdout, stderr: typeof event.stderr === 'string' ? event.stderr : '' })
        return
      }
      rejectJob(job, event.message || `rust core daemon job failed: ${job.command}`)
    }
  }

  function ensureStarted(workerPath: string): boolean {
    if (!enabled) {
      if (!loggedDisabled) {
        loggedDisabled = true
        options.appendStartupLog('rust core daemon disabled by HFM_RUST_CORE_DAEMON=0; one-shot worker remains active')
      }
      return false
    }

    if (child && childPath === workerPath && !child.killed) return true

    stop()
    stderrTail = ''
    loggedReady = false

    try {
      child = spawn(workerPath, ['--core-daemon'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      })
      childPath = workerPath
      lineReader = createInterface({ input: child.stdout })
      lineReader.on('line', handleLine)
      child.stderr.on('data', (chunk: Buffer) => {
        stderrTail = `${stderrTail}${chunk.toString('utf-8')}`.slice(-4096)
      })
      child.stdin.on('error', (error) => {
        logDaemonStdinError(error)
        if (pending.size) rejectAll(`rust core daemon stdin error: ${safeMessage(error)}`)
      })
      child.on('error', (error) => {
        options.appendStartupLog(`rust core daemon process error: ${safeMessage(error)}; one-shot worker fallback remains active`)
        rejectAll(`rust core daemon process error: ${safeMessage(error)}`)
      })
      child.on('exit', (code, signal) => {
        const message = `rust core daemon exited: code=${code ?? 'null'}, signal=${signal ?? 'null'}${stderrTail ? `, stderr=${stderrTail.replace(/\s+/g, ' ').slice(0, 300)}` : ''}`
        if (pending.size) rejectAll(message)
        child = null
        lineReader?.close()
        lineReader = null
        childPath = ''
        rustState = undefined
      recentEvents.length = 0
        options.appendStartupLog(`${message}; one-shot worker fallback remains active`)
      })
      if (!exitHookInstalled) {
        exitHookInstalled = true
        process.once('exit', stop)
      }
      return true
    } catch (error) {
      options.appendStartupLog(`rust core daemon start failed: ${safeMessage(error)}; one-shot worker fallback remains active`)
      stop()
      return false
    }
  }

  async function tryRun(workerPath: string, args: string[], execOptions: RustCoreDaemonExecOptions): Promise<{ stdout: string; stderr: string } | null> {
    if (!canRun(args)) return null
    if (!ensureStarted(workerPath) || !child || child.killed) return null

    const id = randomUUID()
    const command = commandFromArgs(args)
    const maxBuffer = Math.max(1024, Number(execOptions.maxBuffer || 8 * 1024 * 1024) || 8 * 1024 * 1024)
    const timeoutMs = Math.max(0, Number(execOptions.timeout || 0) || 0)
    const signal = execOptions.signal

    return new Promise((resolve, reject) => {
      const job: PendingDaemonJob = {
        id,
        command,
        startedAt: Date.now(),
        maxBuffer,
        timeoutTimer: null,
        resolve,
        reject,
        signal,
      }
      if (signal?.aborted) {
        pending.delete(id)
        reject(abortError(signal))
        return
      }
      if (signal) {
        job.abortListener = () => {
          pending.delete(id)
          try {
            writeDaemonLine(JSON.stringify({ id, type: 'cancel' }))
          } catch {
            // ignore cancel write failures; the caller has already been released
          }
          cleanupJob(job)
          reject(abortError(signal))
        }
        signal.addEventListener('abort', job.abortListener, { once: true })
      }

      if (timeoutMs > 0) {
        job.timeoutTimer = setTimeout(() => {
          pending.delete(id)
          try {
            writeDaemonLine(JSON.stringify({ id, type: 'cancel' }))
          } catch {
            // ignore cancel write failures; reject below is enough for the caller fallback
          }
          cleanupJob(job)
          reject(rustCoreDaemonBlocksOneShotFallbackAfterSubmit(command)
            ? submittedError(command, `rust core daemon job timeout: command=${command}, timeoutMs=${timeoutMs}, elapsedMs=${Date.now() - job.startedAt}`)
            : new Error(`rust core daemon job timeout: command=${command}, timeoutMs=${timeoutMs}, elapsedMs=${Date.now() - job.startedAt}`))
        }, timeoutMs)
        job.timeoutTimer.unref?.()
      }

      pending.set(id, job)
      try {
        if (!writeDaemonLine(JSON.stringify({ id, type: 'submit', args }))) throw new Error('rust core daemon stdin unavailable')
      } catch (error) {
        pending.delete(id)
        cleanupJob(job)
        reject(rustCoreDaemonBlocksOneShotFallbackAfterSubmit(command) ? submittedError(command, safeMessage(error)) : error)
      }
    })
  }

  function pollStatus(): boolean {
    if (!child || child.killed) return false
    try {
      return writeDaemonLine(JSON.stringify({ type: 'status' }))
    } catch {
      return false
    }
  }

  function cancel(ids: string[]): number {
    if (!child || child.killed) return 0
    let sent = 0
    for (const id of ids) {
      if (!pending.has(id)) continue
      if (writeDaemonLine(JSON.stringify({ id, type: 'cancel' }))) sent += 1
    }
    return sent
  }

  return {
    canRun,
    tryRun,
    cancel,
    stop,
    pollStatus,
    status: (): RustCoreDaemonStatus => ({
      enabled,
      running: Boolean(child && !child.killed),
      pending: pending.size,
      safeCommands: Array.from(DAEMON_SAFE_COMMANDS),
      rustState,
      recentEvents: recentEvents.slice(-60),
    }),
  }
}
