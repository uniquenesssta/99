import { awaitPhysicalIoClose } from '../../path/ioDeadlineRuntime'
import { AsyncLocalStorage } from 'node:async_hooks'
import { performance } from 'node:perf_hooks'
import { createHash } from 'node:crypto'
import { applicationWorkEpoch, isApplicationClosing } from '../../app/shutdownCoordinatorRuntime'
import { currentSharedIoSignal, withSharedIoSignal, withoutSharedIoSignal } from '../../path/sharedFileSystemRuntime'
import { SharedIoProcessError } from '../../path/sharedIoProcessRuntime'
import { currentOperationTrace, logOperation } from '../../logging/operationTraceContext'
import { previewFailure, previewFailureKind } from '../../../shared/previewFailure'

const scope = new AsyncLocalStorage<PreviewRenderLifetime | undefined>()
const QUEUE_BUDGET_MS = 3000
let decisionSamples = 0
type PreviewRenderBudget = { startedAt: number; deadline: number; queuedMs: number }

/** Constructed only after a typed native domain receipt and physical close. */
export class PreviewRenderDomainError extends Error {
  readonly reason = 'system-family-unavailable'
  constructor(readonly cause: SharedIoProcessError) {
    super('Installed font family unavailable')
    this.name = 'PreviewRenderDomainError'
  }
}

/** One native owner, including its compatible routes, owns both budgets. */
export class PreviewRenderLifetime {
  private readonly budget: PreviewRenderBudget
  private get startedAt(): number { return this.budget.startedAt }
  private get deadline(): number { return this.budget.deadline }
  private get queuedMs(): number { return this.budget.queuedMs }
  private readonly epoch = applicationWorkEpoch()
  private readonly controller = new AbortController()
  private readonly timer: ReturnType<typeof setTimeout>
  private readonly parent = currentSharedIoSignal()
  private readonly abort = () => this.controller.abort()
  private expired = false
  readonly signal = this.controller.signal

  constructor() {
    const configured = Number(process.env.HFM_RUST_PREVIEW_RENDER_TIMEOUT_MS || 30000) || 30000
    const executionMs = Math.min(30000, Math.max(5000, Number.isFinite(configured) ? configured : 30000))
    const parentBudget = scope.getStore()?.budget
    const startedAt = performance.now()
    this.budget = parentBudget || { startedAt, deadline: startedAt + QUEUE_BUDGET_MS + executionMs, queuedMs: 0 }
    if (this.parent?.aborted) this.abort()
    else this.parent?.addEventListener('abort', this.abort, { once: true })
    this.timer = setTimeout(() => { this.expired = true; this.abort() }, this.remainingMs())
  }

  assertCurrent(): void {
    if (this.parent?.aborted || isApplicationClosing() || applicationWorkEpoch() !== this.epoch)
      throw new SharedIoProcessError(previewFailure('cancelled').message, 'not-started', 'cancelled')
    if (this.expired || performance.now() >= this.deadline)
      throw new SharedIoProcessError(previewFailure('timeout').message, 'not-started', 'timeout')
  }

  remainingMs(): number { return Math.max(1, Math.ceil(this.deadline - performance.now())) }

  queueTimeoutMs(): number {
    this.assertCurrent()
    const remaining = QUEUE_BUDGET_MS - this.queuedMs
    if (remaining <= 0) throw new SharedIoProcessError(previewFailure('timeout').message, 'not-started', 'queue-timeout')
    return Math.max(1, Math.min(remaining, this.remainingMs()))
  }

  // Called exactly once per physical submission, never by its outer wrappers.
  recordQueueWait(queuedMs: unknown): void {
    if (typeof queuedMs === 'number' && Number.isFinite(queuedMs) && queuedMs > 0) this.budget.queuedMs += queuedMs
  }

  failure(error: unknown): unknown {
    const value = error as Partial<SharedIoProcessError> | null
    // The global I/O queue uses the existing local cancellation type rather
    // than a shared-process receipt. Keep its cause, but serialize a stable
    // preview code when our own signal retired queued work before admission.
    if (value?.name === 'OperationCancelledError' && this.signal.aborted) {
      const timeout = !this.parent?.aborted && (this.expired || performance.now() >= this.deadline)
      return Object.assign(new SharedIoProcessError(previewFailure(timeout ? 'timeout' : 'cancelled').message, 'not-started', timeout ? 'timeout' : 'cancelled'), { cause: error })
    }
    if (!this.parent?.aborted && (this.expired || performance.now() >= this.deadline) && value?.reason === 'cancelled') {
      const timeout = new SharedIoProcessError(previewFailure('timeout').message, value.outcome || 'unknown', 'timeout')
      timeout.closed = value.closed; timeout.queuedMs = value.queuedMs; timeout.executionMs = value.executionMs
      timeout.requestId = value.requestId; timeout.blockedBy = value.blockedBy; timeout.phase = value.phase; timeout.blocker = value.blocker
      return timeout
    }
    return error
  }

  async allowFallback(error: unknown): Promise<void> {
    await awaitPhysicalIoClose(error)
    // Admission, retirement and uncertain worker receipts are not render errors.
    if (isTerminalPreviewRenderFailure(error)) throw error
    this.assertCurrent()
    this.queueTimeoutMs()
  }

  traceDecision(phase: 'system' | 'native', action: 'fallback' | 'stop', error: unknown, root: string, append: (message: string) => void): void {
    if (decisionSamples++ >= 128) return
    const value = error as Partial<SharedIoProcessError> | null
    const reason = typeof value?.reason === 'string' && /^[a-z-]{1,48}$/.test(value.reason) ? value.reason : previewFailureKind(error)
    const rootHash = createHash('sha256').update(root).digest('hex').slice(0, 20)
    const caller = createHash('sha256').update(currentOperationTrace()?.operationId || 'unlinked').digest('hex').slice(0, 20)
    const boundedId = (id: unknown) => typeof id === 'number' && Number.isSafeInteger(id) && id > 0 ? String(id) : undefined
    const request = boundedId(value?.requestId), blockedBy = boundedId(value?.blockedBy)
    const processPhase = value?.phase === 'queued' || value?.phase === 'executing' ? value.phase : 'unknown'
    const blocker = ['resource-conflict', 'prior-conflicting-request', 'lane-capacity'].includes(value?.blocker || '') ? value!.blocker : 'none'
    logOperation({ stage: `preview-${phase}-${action}`, reason, rootId: rootHash, jobId: request, blockedBy, queuedMs: this.queuedMs, elapsedMs: performance.now() - this.startedAt }, append)
    try { append(`preview route decision: caller=${caller}, rootHash=${rootHash}, phase=${phase}, action=${action}, reason=${reason}, request=${request || 'none'}, processPhase=${processPhase}, blocker=${blocker}, blockedBy=${blockedBy || 'none'}, queuedMs=${Math.round(this.queuedMs)}, remainingQueueMs=${Math.max(0, Math.round(QUEUE_BUDGET_MS - this.queuedMs))}`) } catch { /* Diagnostics cannot alter ownership. */ }
  }

  dispose(): void {
    clearTimeout(this.timer)
    this.parent?.removeEventListener('abort', this.abort)
  }
}

export function isTerminalPreviewRenderFailure(error: unknown): boolean {
  const value = error as { sharedIo?: boolean; daemonSubmitted?: boolean; name?: string }
  return value?.sharedIo === true || value?.daemonSubmitted === true || value?.name === 'AbortError' || previewFailureKind(error) !== 'failed'
}

export function currentPreviewRenderLifetime(): PreviewRenderLifetime | undefined { return scope.getStore() }

export async function allowPreviewRenderFallback(error: unknown): Promise<void> {
  const lifetime = currentPreviewRenderLifetime()
  if (lifetime) return lifetime.allowFallback(error)
  await awaitPhysicalIoClose(error)
  if (isTerminalPreviewRenderFailure(error)) throw error
}

export async function withPreviewRenderLifetime<T>(operation: (lifetime: PreviewRenderLifetime) => Promise<T>): Promise<T> {
  const lifetime = new PreviewRenderLifetime()
  try {
    return await scope.run(lifetime, () => withSharedIoSignal(lifetime.signal, async () => {
      lifetime.assertCurrent()
      try {
        const result = await operation(lifetime)
        lifetime.assertCurrent()
        return result
      } catch (error) {
        await awaitPhysicalIoClose(error)
        // Preserve original terminal reasons and their physical-close receipt.
        throw lifetime.failure(error)
      }
    }))
  } finally { lifetime.dispose() }
}

/** Retiring a caller cannot cancel the owner cleanup that follows child close. */
export function withoutPreviewRenderLifetime<T>(operation: () => Promise<T>): Promise<T> {
  return scope.run(undefined, () => withoutSharedIoSignal(operation))
}
