import { isApplicationClosing, onApplicationClosing } from '../app/shutdownCoordinatorRuntime'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'

export type SharedIoProcessRequest = {
  file: string
  args: string[]
  roots: string[]
  timeoutMs: number
  lane?: 'default' | 'root-probe'
  queueTimeoutMs?: number
  maxBuffer?: number
  write: boolean
  signal?: AbortSignal
  env?: NodeJS.ProcessEnv
  onClose?: () => void
  admit?: () => boolean
}
export class SharedIoProcessError extends Error {
  readonly sharedIo = true
  closed?: Promise<void>
  queuedMs?: number
  executionMs?: number
  constructor(message: string, readonly outcome: 'not-started' | 'unknown', readonly reason: string) {
    super(message)
    this.name = 'SharedIoProcessError'
  }
}
export function rethrowSharedIoProcessError(error: unknown): void {
  if (error && typeof error === 'object' && (error as SharedIoProcessError).sharedIo === true) throw error
}
type Result = { stdout: string; stderr: string; queuedMs: number; executionMs: number }
type Job = {
  id: number
  request: SharedIoProcessRequest
  resolve: (result: Result) => void
  reject: (error: unknown) => void
  child?: ChildProcessWithoutNullStreams
  timer?: ReturnType<typeof setTimeout>
  killTimer?: ReturnType<typeof setTimeout>
  abort?: () => void
  settled: boolean
  enqueuedAt: number
  startedAt?: number
  released?: boolean
  whenClosed: Promise<void>
  close: () => void
}

// A slot and its root locks belong to the process until close, not to its caller's Promise.
export function createSharedIoProcessRuntime(appendLog: (message: string) => void) {
  const active = new Set<Job>()
  const queue: Job[] = []
  const idleWaiters: Array<() => void> = []
  let closed = false, nextId = 0
  const log = (message: string) => { try { appendLog(message) } catch { /* Diagnostics cannot alter settlement. */ } }
  const laneOf = (job: Job) => job.request.lane || 'default'
  const timingOf = (job: Job) => {
    const current = Date.now()
    return {
      queuedMs: Math.max(0, (job.startedAt ?? current) - job.enqueuedAt),
      executionMs: job.startedAt ? Math.max(0, current - job.startedAt) : 0,
    }
  }
  const rootsOverlap = (a: Job, b: Job) => a.request.roots.some(root => b.request.roots.includes(root))
  const canStart = (job: Job) => {
    if (laneOf(job) === 'root-probe') {
      if ([...active].some(other => laneOf(other) === 'root-probe')) return false
      return ![...active].some(other => rootsOverlap(job, other) && (other.request.write || laneOf(other) === 'root-probe'))
    }
    if ([...active].filter(other => laneOf(other) === 'default').length >= 2) return false
    return ![...active].some(other => rootsOverlap(job, other))
  }
  const release = (job: Job) => {
    if (job.released) return
    job.released = true
    job.close()
    try { job.request.onClose?.() } catch (error) { log(`shared io cleanup failed: ${String(error)}`) }
  }
  const detach = (job: Job) => {
    if (job.timer) clearTimeout(job.timer)
    if (job.abort) job.request.signal?.removeEventListener('abort', job.abort)
  }
  function settle(job: Job, result?: Result, error?: unknown): void {
    if (job.settled) return
    job.settled = true
    detach(job)
    if (error) {
      if (error instanceof SharedIoProcessError) {
        error.closed = job.whenClosed
        const timing = timingOf(job)
        error.queuedMs ??= timing.queuedMs
        error.executionMs ??= timing.executionMs
      }
      job.reject(error)
    }
    else job.resolve(result!)
  }
  function cancel(job: Job, reason: string): void {
    if (job.settled) return
    const started = Boolean(job.child?.pid)
    settle(job, undefined, new SharedIoProcessError(`Shared I/O ${reason}: request=${job.id}`, started ? 'unknown' : 'not-started', reason))
    if (!job.child) {
      const index = queue.indexOf(job)
      if (index >= 0) queue.splice(index, 1)
      release(job)
      drain()
      return
    }
    const child = job.child!
    log(`shared io cancel: request=${job.id}, pid=${child.pid}, outcome=unknown, reason=${reason}`)
    try { child.kill('SIGTERM') } catch { /* Keep the slot and escalate. */ }
    job.killTimer = setTimeout(() => {
      if (!active.has(job)) return
      try { child.kill('SIGKILL') } catch (error) { log(`shared io kill failed: request=${job.id}, ${String(error)}`) }
    }, 1000)
  }
  function drain(): void {
    if (!closed) {
      while (true) {
        let index = queue.findIndex(job => laneOf(job) === 'root-probe' && canStart(job))
        if (index < 0) index = queue.findIndex(job => laneOf(job) === 'default' && canStart(job))
        if (index < 0) break
        const job = queue.splice(index, 1)[0]
        if (job.timer) clearTimeout(job.timer)
        start(job)
      }
    }
    if (!active.size && !queue.length) for (const done of idleWaiters.splice(0)) done()
  }
  function start(job: Job): void {
    const request = job.request
    if (request.signal?.aborted) { cancel(job, 'cancelled'); return }
    if (request.admit && !request.admit()) { cancel(job, 'stale-generation'); return }
    let stdout = '', stderr = '', bytes = 0
    try {
      const child = spawn(request.file, request.args, { stdio: ['pipe', 'pipe', 'pipe', 'pipe'], windowsHide: true, shell: false, env: { ...process.env, ...request.env, HFM_PARENT_PID: String(process.pid) } })
      child.stdio[3]?.on('error', () => undefined)
      job.child = child as ChildProcessWithoutNullStreams
      job.startedAt = Date.now()
      active.add(job)
      child.stdin.on('error', () => cancel(job, 'stdin-error'))
      child.stdin.end()
      log(`shared io started: request=${job.id}, pid=${child.pid}, lane=${request.lane || 'default'}, roots=${request.roots.length}, queuedMs=${job.startedAt - job.enqueuedAt}, write=${request.write}`)
      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')
      const collect = (kind: 'stdout' | 'stderr', chunk: string) => {
        if (job.settled) return
        bytes += Buffer.byteLength(chunk, 'utf8')
        if (bytes > (request.maxBuffer ?? 8 * 1024 * 1024)) { cancel(job, 'output-limit'); return }
        if (kind === 'stdout') stdout += chunk
        else stderr += chunk
      }
      child.stdout.on('data', chunk => collect('stdout', chunk))
      child.stderr.on('data', chunk => collect('stderr', chunk))
      child.once('error', error => { cancel(job, 'process-error'); log(`shared io process error: request=${job.id}, ${String(error)}`) })
      child.once('close', (code, signal) => {
        if (job.killTimer) clearTimeout(job.killTimer)
        active.delete(job)
        release(job)
        if (!job.settled) {
          if (code === 0) settle(job, { stdout, stderr, ...timingOf(job) })
          else settle(job, undefined, new SharedIoProcessError(`Shared I/O process failed: code=${code}, signal=${signal}`, 'unknown', 'process-exit'))
        }
        log(`shared io closed: request=${job.id}, pid=${child.pid}, code=${code}, signal=${signal}, active=${active.size}`)
        drain()
      })
      job.timer = setTimeout(() => cancel(job, 'timeout'), Math.max(1, request.timeoutMs))
    } catch (error) {
      settle(job, undefined, new SharedIoProcessError(`Shared I/O spawn failed: ${String(error)}`, 'not-started', 'spawn-error'))
      release(job)
      drain()
    }
  }
  function run(request: SharedIoProcessRequest): Promise<Result> {
    request = { ...request, args: [...request.args], roots: [...new Set(request.roots)], env: request.env ? { ...request.env } : undefined }
    const reject = (message: string, reason: string) => {
      try { request.onClose?.() } catch (error) { log(`shared io cleanup failed: ${String(error)}`) }
      return Promise.reject(new SharedIoProcessError(message, 'not-started', reason))
    }
    if (closed || request.signal?.aborted) return reject('Shared I/O is closed or cancelled', 'cancelled')
    if (!request.roots.length) return reject('Shared I/O requires a resource identity', 'invalid-root')
    const requestLane = request.lane || 'default'
    const queuedInLane = queue.filter(job => laneOf(job) === requestLane).length
    if (requestLane === 'default' && queuedInLane >= 128) return reject('Shared I/O queue full', 'queue-full')
    if (requestLane === 'root-probe' && queuedInLane >= 8) return reject('Shared root probe queue full', 'queue-full')
    return new Promise((resolve, reject) => {
      let close!: () => void
      const whenClosed = new Promise<void>(resolve => { close = resolve })
      const job: Job = { whenClosed, close, id: ++nextId, request, resolve, reject, settled: false, enqueuedAt: Date.now() }
      job.abort = () => cancel(job, 'cancelled')
      request.signal?.addEventListener('abort', job.abort, { once: true })
      job.timer = setTimeout(() => cancel(job, 'queue-timeout'), request.queueTimeoutMs ?? 3000)
      queue.push(job)
      drain()
    })
  }
  function cancelAll(): void {
    const wasClosed = closed; closed = true
    for (const job of [...queue, ...active]) cancel(job, 'stopping')
    closed = wasClosed; drain()
  }
  function stop(): void {
    closed = true; cancelAll()
    for (const job of active) { try { job.child?.kill('SIGKILL') } catch { /* Parent guard remains active. */ } }
  }
  return {
    run, stop, cancelAll,
    whenIdle: () => active.size || queue.length ? new Promise<void>(resolve => idleWaiters.push(resolve)) : Promise.resolve(),
    status: () => ({
      closed,
      active: active.size,
      queued: queue.length,
      activeDefault: [...active].filter(job => laneOf(job) === 'default').length,
      activeRootProbe: [...active].filter(job => laneOf(job) === 'root-probe').length,
      pids: [...active].map(job => job.child?.pid).filter(Boolean),
    }),
  }
}

let applicationPool: ReturnType<typeof createSharedIoProcessRuntime> | undefined
let applicationLog: (message: string) => void = () => undefined
export function applicationSharedIoProcessRuntime(appendLog?: (message: string) => void) {
  if (appendLog) applicationLog = appendLog
  if (!applicationPool) {
    const pool = createSharedIoProcessRuntime(message => applicationLog(message))
    onApplicationClosing(() => pool.cancelAll())
    applicationPool = { ...pool, run: request => {
      if (!isApplicationClosing()) return pool.run(request)
      try { request.onClose?.() } catch { /* No executor owns this input. */ }
      return Promise.reject(new SharedIoProcessError('应用退出中，网络操作未提交。', 'not-started', 'closing'))
    } }
  }
  return applicationPool
}
