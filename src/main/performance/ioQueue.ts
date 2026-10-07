export type IoTaskPriority = 'background' | 'normal' | 'foreground'

export class OperationCancelledError extends Error {
  constructor(message = '操作已取消。') {
    super(message)
    this.name = 'OperationCancelledError'
  }
}

export function isOperationCancelledError(error: unknown): boolean {
  return error instanceof OperationCancelledError || (error instanceof Error && (error.name === 'AbortError' || error.name === 'OperationCancelledError'))
}

export function abortMessage(signal?: AbortSignal): string {
  const reason = signal?.reason
  if (reason instanceof Error) return reason.message
  if (typeof reason === 'string' && reason.trim()) return reason.trim()
  return '操作已取消。'
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new OperationCancelledError(abortMessage(signal))
}

interface QueuedIoTask<T> {
  label: string
  priority: number
  sequence: number
  signal?: AbortSignal
  fn: () => Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
  onAbort?: () => void
}

export class AdaptiveIoQueue {
  private active = 0
  private sequence = 0
  private readonly pending: Array<QueuedIoTask<unknown>> = []

  constructor(private readonly concurrencyProvider: () => number) {}

  add<T>(label: string, fn: () => Promise<T>, options: { priority?: IoTaskPriority | number; signal?: AbortSignal } = {}): Promise<T> {
    throwIfAborted(options.signal)
    const priority = typeof options.priority === 'number'
      ? options.priority
      : options.priority === 'foreground'
        ? 20
        : options.priority === 'background'
          ? 0
          : 10

    return new Promise<T>((resolveTask, rejectTask) => {
      const task: QueuedIoTask<T> = {
        label,
        priority,
        sequence: this.sequence += 1,
        signal: options.signal,
        fn,
        resolve: resolveTask,
        reject: rejectTask
      }

      task.onAbort = () => {
        const index = this.pending.indexOf(task as QueuedIoTask<unknown>)
        if (index >= 0) {
          this.pending.splice(index, 1)
          rejectTask(new OperationCancelledError(abortMessage(options.signal)))
        }
      }

      options.signal?.addEventListener('abort', task.onAbort, { once: true })
      this.pending.push(task as QueuedIoTask<unknown>)
      this.pump()
    })
  }

  recheck(): void {
    this.pump()
  }

  snapshot(): { active: number; pending: number; concurrency: number } {
    return {
      active: this.active,
      pending: this.pending.length,
      concurrency: this.currentConcurrency()
    }
  }

  private currentConcurrency(): number {
    return Math.max(1, Math.floor(this.concurrencyProvider() || 1))
  }

  private pump(): void {
    while (this.active < this.currentConcurrency() && this.pending.length) {
      this.pending.sort((a, b) => b.priority - a.priority || a.sequence - b.sequence)
      const task = this.pending.shift()!
      if (task.signal?.aborted) {
        task.reject(new OperationCancelledError(abortMessage(task.signal)))
        continue
      }

      task.signal?.removeEventListener('abort', task.onAbort || (() => undefined))
      this.active += 1
      void Promise.resolve()
        .then(() => {
          throwIfAborted(task.signal)
          return task.fn()
        })
        .then((result) => task.resolve(result))
        .catch((error) => task.reject(error))
        .finally(() => {
          this.active = Math.max(0, this.active - 1)
          this.pump()
        })
    }
  }
}
