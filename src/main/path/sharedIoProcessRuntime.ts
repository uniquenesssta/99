import { detailedStartupLogsEnabled } from '../logging/startupLogPolicy'
import { createHash } from 'node:crypto'
import { currentOperationTrace, logOperation } from '../logging/operationTraceContext'
import { sharedIoAccessConflict, type SharedIoAccess } from './sharedIoAccessRuntime'
import { isApplicationClosing, onApplicationClosing } from '../app/shutdownCoordinatorRuntime'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'

export type SharedIoProcessRequest = {
  file: string
  args: string[]
  accesses?: SharedIoAccess[]
  roots: string[]
  timeoutMs: number
  label?: string
  lane?: 'default' | 'root-probe' | 'preview-read'
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
function workerFailureDetail(stdout: string): string {
  try {
    const receipt = JSON.parse(stdout.split(/\r?\n/).find(line => line.trim()) || '')
    // Preserve only the bounded error message, never echo inputs or arbitrary output.
    if (receipt.ok === false && typeof receipt.message === 'string') {
      return receipt.message.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 1024)
    }
  } catch { /* A malformed envelope still retains its process-exit classification. */ }
  return ''
}
type Result = { stdout: string; stderr: string; queuedMs: number; executionMs: number }
export type SharedIoProcessMetricRow = {
  requests: number
  accepted: number
  started: number
  completed: number
  failed: number
  closed: number
}
export type SharedIoProcessMetrics = SharedIoProcessMetricRow & {
  byLabel: Record<string, SharedIoProcessMetricRow>
}
type Job = {
  trace?: ReturnType<typeof currentOperationTrace>
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
  const metricTotals: SharedIoProcessMetricRow = { requests: 0, accepted: 0, started: 0, completed: 0, failed: 0, closed: 0 }
  const metricByLabel = new Map<string, SharedIoProcessMetricRow>()
  let closed = false, nextId = 0
  const log = (message: string) => { try { appendLog(message) } catch { /* Diagnostics cannot alter settlement. */ } }
  const requestLabel = (request: SharedIoProcessRequest) => String(request.label || request.args[0] || 'unknown').slice(0, 120)
  const metricRow = (label: string) => {
    let row = metricByLabel.get(label)
    if (!row) {
      row = { requests: 0, accepted: 0, started: 0, completed: 0, failed: 0, closed: 0 }
      metricByLabel.set(label, row)
    }
    return row
  }
  const count = (request: SharedIoProcessRequest, field: keyof SharedIoProcessMetricRow) => {
    metricTotals[field] += 1
    metricRow(requestLabel(request))[field] += 1
  }
  const snapshotMetrics = (): SharedIoProcessMetrics => ({
    ...metricTotals,
    byLabel: Object.fromEntries([...metricByLabel].sort(([a], [b]) => a.localeCompare(b)).map(([label, row]) => [label, { ...row }])),
  })
  const laneOf = (job: Job) => job.request.lane || 'default'
  const timingOf = (job: Job) => {
    const current = Date.now()
    return {
      queuedMs: Math.max(0, (job.startedAt ?? current) - job.enqueuedAt),
      executionMs: job.startedAt ? Math.max(0, current - job.startedAt) : 0,
    }
  }
  const rootsOverlap = (a: Job, b: Job) => [...a.request.roots, ...b.request.roots].some(root => root.startsWith('configured-root:')) || a.request.roots.some(root => b.request.roots.includes(root))
  const conflicts = (a: Job, b: Job) => {
    if (!rootsOverlap(a, b)) return false
    if (a.request.accesses?.length && b.request.accesses?.length)
      return a.request.accesses.some(left => b.request.accesses!.some(right => sharedIoAccessConflict(left, right)))
    if ((laneOf(a) === 'root-probe' || laneOf(b) === 'root-probe') && !a.request.write && !b.request.write) return false
    // Legacy callers remain conservative. Preserve the two explicitly read-only lanes.
    if (laneOf(a) !== 'default' && laneOf(b) !== 'default' && !a.request.write && !b.request.write) return false
    return true
  }
  const canStart = (job: Job) => {
    const lane = laneOf(job)
    const limit = lane === 'preview-read' ? 10 : lane === 'root-probe' ? 1 : 2
    if ([...active].filter(other => laneOf(other) === lane).length >= limit) return false
    if (queue.some(other => other.id < job.id && conflicts(job, other))) return false
    return ![...active].some(other => conflicts(job, other))
  }
  const traceJob = (job: Job, stage: string, reason?: string, blockedBy?: number) => {
    if (!detailedStartupLogsEnabled()) return
    const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 20)
    logOperation({ trace: job.trace, stage, reason, jobId: String(job.id), blockedBy: blockedBy === undefined ? undefined : String(blockedBy), rootId: hash(job.request.roots), resourceId: hash(job.request.accesses || job.request.roots), ...timingOf(job) }, appendLog)
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
      count(job.request, 'failed')
      if (error instanceof SharedIoProcessError) {
        error.closed = job.whenClosed
        const timing = timingOf(job)
        error.queuedMs ??= timing.queuedMs
        error.executionMs ??= timing.executionMs
      }
      job.reject(error)
    }
    else {
      count(job.request, 'completed')
      job.resolve(result!)
    }
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
        if (index < 0) index = queue.findIndex(job => laneOf(job) === 'preview-read' && canStart(job))
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
      count(request, 'started')
      traceJob(job, 'shared-started')
      child.stdin.on('error', () => cancel(job, 'stdin-error'))
      child.stdin.end()
      log(`shared io started: request=${job.id}, pid=${child.pid}, label=${requestLabel(request)}, lane=${request.lane || 'default'}, roots=${request.roots.length}, queuedMs=${job.startedAt - job.enqueuedAt}, write=${request.write}`)
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
        count(request, 'closed')
        traceJob(job, 'shared-closed')
        release(job)
        if (!job.settled) {
          if (code === 0) settle(job, { stdout, stderr, ...timingOf(job) })
          else {
            const detail = workerFailureDetail(stdout)
            const error = new SharedIoProcessError(`Shared I/O process failed: code=${code}, signal=${signal}${detail ? `, message=${detail}` : ''}`, 'unknown', 'process-exit')
            log(`shared io failed: request=${job.id}, label=${requestLabel(request)}, ${error.message}`)
            settle(job, undefined, error)
          }
        }
        log(`shared io closed: request=${job.id}, pid=${child.pid}, label=${requestLabel(request)}, code=${code}, signal=${signal}, active=${active.size}, startedTotal=${metricTotals.started}, closedTotal=${metricTotals.closed}`)
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
    request = { ...request, accesses: request.accesses?.map(access => ({ ...access })), args: [...request.args], roots: [...new Set(request.roots)], env: request.env ? { ...request.env } : undefined }
    count(request, 'requests')
    const reject = (message: string, reason: string) => {
      count(request, 'failed')
      try { request.onClose?.() } catch (error) { log(`shared io cleanup failed: ${String(error)}`) }
      return Promise.reject(new SharedIoProcessError(message, 'not-started', reason))
    }
    if (closed || request.signal?.aborted) return reject('Shared I/O is closed or cancelled', 'cancelled')
    if (!request.roots.length) return reject('Shared I/O requires a resource identity', 'invalid-root')
    if (request.accesses && (request.roots.some(root => !request.accesses!.some(access => access.root === root)) || request.accesses.some(access => !request.roots.includes(access.root) || !access.path || !['file','database','tree'].includes(access.scope) || !['read','write'].includes(access.mode)))) request.accesses = undefined
    const requestLane = request.lane || 'default'
    const queuedInLane = queue.filter(job => laneOf(job) === requestLane).length
    if (requestLane === 'preview-read' && request.write) return reject('Preview lane accepts shared reads only', 'invalid-lane')
    if (requestLane === 'preview-read' && queuedInLane >= 128) return reject('Shared preview queue full', 'queue-full')
    if (requestLane === 'default' && queuedInLane >= 128) return reject('Shared I/O queue full', 'queue-full')
    if (requestLane === 'root-probe' && queuedInLane >= 8) return reject('Shared root probe queue full', 'queue-full')
    count(request, 'accepted')
    return new Promise((resolve, reject) => {
      let close!: () => void
      const whenClosed = new Promise<void>(resolve => { close = resolve })
      const job: Job = { trace: currentOperationTrace(), whenClosed, close, id: ++nextId, request, resolve, reject, settled: false, enqueuedAt: Date.now() }
      job.abort = () => cancel(job, 'cancelled')
      request.signal?.addEventListener('abort', job.abort, { once: true })
      job.timer = setTimeout(() => cancel(job, 'queue-timeout'), request.queueTimeoutMs ?? 3000)
      const blocker = [...active, ...queue].find(other => conflicts(job, other))
      queue.push(job)
      traceJob(job, 'shared-admission', !request.accesses ? 'conservative-scope' : blocker ? 'resource-conflict' : canStart(job) ? 'ready' : 'capacity', blocker?.id)
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
      activePreviewRead: [...active].filter(job => laneOf(job) === 'preview-read').length,
      activeRootProbe: [...active].filter(job => laneOf(job) === 'root-probe').length,
      pids: [...active].map(job => job.child?.pid).filter(Boolean),
      metrics: snapshotMetrics(),
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
