import { AsyncLocalStorage } from 'node:async_hooks'
import { performance } from 'node:perf_hooks'

export const SHUTDOWN_BUDGET_MS = 15000
export const RENDERER_CLOSE_MS = 3000
class ShutdownTimeout extends Error {}
const shutdownWork = new AsyncLocalStorage<AbortSignal>()
type Alarm = { remaining: number; started: number; timer?: ReturnType<typeof setTimeout>; fire: () => void }
class ExitBudget {
  private alarms = new Set<Alarm>()
  private paused = 0
  private disposed = false
  alarm(ms: number, fire: () => void): () => void {
    const alarm: Alarm = { remaining: ms, started: performance.now(), fire }
    this.alarms.add(alarm)
    this.arm(alarm)
    return () => { clearTimeout(alarm.timer); this.alarms.delete(alarm) }
  }
  private arm(alarm: Alarm): void {
    if (this.paused || this.disposed) return
    alarm.started = performance.now()
    alarm.timer = setTimeout(() => { this.alarms.delete(alarm); alarm.fire() }, Math.max(0, alarm.remaining))
  }
  async prompt<T>(action: () => Promise<T>): Promise<T> {
    if (++this.paused === 1) for (const alarm of this.alarms) {
      clearTimeout(alarm.timer)
      alarm.remaining -= performance.now() - alarm.started
    }
    try { return await action() }
    finally { if (--this.paused === 0) for (const alarm of this.alarms) this.arm(alarm) }
  }
  async run<T>(name: string, ms: number, action: () => Promise<T>): Promise<T> {
    if (this.disposed) throw new ShutdownTimeout('退出流程已经结束。')
    const controller = new AbortController()
    let cancel = () => undefined as void
    const timeout = new Promise<never>((_, reject) => { cancel = this.alarm(ms, () => reject(new ShutdownTimeout(`${name}超时；未确认结果保留。`))) })
    try { return await Promise.race([Promise.resolve().then(() => shutdownWork.run(controller.signal, action)), timeout]) }
    finally { cancel(); controller.abort() }
  }
  dispose(): void { this.disposed = true; for (const alarm of this.alarms) clearTimeout(alarm.timer); this.alarms.clear() }
}

let closing = false, finishing = false, epoch = 0
let activeBudget: ExitBudget | undefined
let persistenceFailure: unknown
const freezeListeners = new Set<() => void>()
const resumeListeners = new Set<() => void>()
export function onApplicationResumed(listener: () => void): void { resumeListeners.add(listener) }
export function isApplicationClosing(): boolean { return closing }
export function applicationWorkEpoch(): number { return epoch }
export function assertApplicationOpen(ticket = epoch): void {
  if (closing || ticket !== epoch) throw new Error('软件正在退出，此操作未继续执行。')
}
export function assertLocalShutdownWorkAllowed(): void {
  if (finishing || shutdownWork.getStore()?.aborted) throw new Error('退出清理期限已结束，剩余记录将在下次启动核验。')
}
export function onApplicationClosing(listener: () => void): () => void {
  freezeListeners.add(listener)
  return () => { freezeListeners.delete(listener) }
}
export function noteRecoveryPersistenceFailure(error: unknown): void { if (closing) persistenceFailure = error }
export async function withShutdownPrompt<T>(action: () => Promise<T>): Promise<T> {
  return activeBudget ? activeBudget.prompt(action) : action()
}

export type ShutdownOutcomeReason =
  | 'complete'
  | 'residual'
  | 'cleanup-timeout'
  | 'persistence-failure'
  | 'forced-exit'
  | 'deadline'
  | 'log-failure'

export type ShutdownOutcome = {
  processExitClean: boolean
  persistenceComplete: boolean
  localCleanupComplete: boolean
  cleanupRemaining: number | null
  cleanupTimedOut: boolean
  forced: boolean
  reason: ShutdownOutcomeReason
}

export type ShutdownPorts = {
  log: (message: string) => void
  closeRenderers: () => Promise<boolean>
  freeze: () => void
  restore: () => void
  cleanup: () => Promise<{ remaining: number }>
  save: () => Promise<void>
  confirmLoss: (message: string) => Promise<boolean>
  drainLogs: () => Promise<void>
  terminate: (outcome: ShutdownOutcome) => void
}
// This owner is shared by title-bar close, app.quit and repeated requests.
export function createShutdownCoordinator(ports: ShutdownPorts) {
  let running: Promise<void> | undefined
  function request(): Promise<void> {
    if (running) return running
    closing = true; finishing = false; persistenceFailure = undefined
    const quitId = ++epoch
    const budget = new ExitBudget(); activeBudget = budget
    let ended = false
    const log = (message: string) => { try { ports.log(`shutdown: quitId=${quitId}, ${message}`) } catch { /* Preserve shutdown outcome. */ } }
    const outcome: ShutdownOutcome = {
      processExitClean: true,
      persistenceComplete: true,
      localCleanupComplete: true,
      cleanupRemaining: 0,
      cleanupTimedOut: false,
      forced: false,
      reason: 'complete',
    }
    const finish = (patch: Partial<ShutdownOutcome> = {}) => {
      if (ended) return
      Object.assign(outcome, patch)
      if (!outcome.persistenceComplete) outcome.processExitClean = false
      ended = true; finishing = true; budget.dispose(); activeBudget = undefined
      log(`phase=terminate, processExitClean=${outcome.processExitClean}, persistenceComplete=${outcome.persistenceComplete}, localCleanupComplete=${outcome.localCleanupComplete}, cleanupRemaining=${outcome.cleanupRemaining === null ? 'unknown' : outcome.cleanupRemaining}, cleanupTimedOut=${outcome.cleanupTimedOut}, forced=${outcome.forced}, reason=${outcome.reason}`)
      ports.terminate({ ...outcome })
    }
    const restore = () => {
      if (ended) return
      ended = true; budget.dispose(); activeBudget = undefined; closing = false; finishing = false; ++epoch
      log('phase=cancelled'); ports.restore()
      for (const listener of resumeListeners) { try { listener() } catch (error) { log(`resume failed: ${String(error)}`) } }
    }
    const confirm = (error: unknown) => withShutdownPrompt(() => ports.confirmLoss(String(error)))
    budget.alarm(SHUTDOWN_BUDGET_MS, () => {
      log('phase=deadline, outcome=unknown')
      finish({
        processExitClean: false,
        persistenceComplete: false,
        localCleanupComplete: false,
        cleanupRemaining: null,
        cleanupTimedOut: false,
        forced: true,
        reason: 'deadline',
      })
    })
    running = Promise.resolve().then(async () => {
      log('phase=freeze, budgetMs=15000')
      ports.freeze()
      for (const listener of freezeListeners) listener()
      let renderersClosed = false
      try { renderersClosed = await budget.run('窗口保存', RENDERER_CLOSE_MS + 500, ports.closeRenderers) }
      catch (error) {
        log(`phase=renderer, error=${String(error)}`)
        renderersClosed = await confirm(error)
        if (renderersClosed) {
          outcome.processExitClean = false
          outcome.persistenceComplete = false
          outcome.forced = true
          outcome.reason = 'forced-exit'
        }
      }
      if (ended) return
      if (!renderersClosed) { restore(); return }
      try {
        const result = await budget.run('本地字体清理', 8000, ports.cleanup)
        outcome.cleanupRemaining = Math.max(0, Number(result.remaining) || 0)
        outcome.localCleanupComplete = outcome.cleanupRemaining === 0
        if (!outcome.localCleanupComplete) outcome.reason = 'residual'
        log(`phase=cleanup, remaining=${outcome.cleanupRemaining}, localCleanupComplete=${outcome.localCleanupComplete}`)
      } catch (error) {
        outcome.localCleanupComplete = false
        outcome.cleanupRemaining = null
        log(`phase=cleanup, outcome=unknown, error=${String(error)}`)
        // A stalled OS call retains the write-ahead recovery record. That is a
        // planned residual, not a process crash, provided persistence stayed healthy.
        if (error instanceof ShutdownTimeout && !persistenceFailure) {
          outcome.cleanupTimedOut = true
          outcome.reason = 'cleanup-timeout'
        } else {
          if (persistenceFailure) outcome.persistenceComplete = false
          if (!await confirm(persistenceFailure || error)) { restore(); return }
          outcome.processExitClean = false
          outcome.forced = true
          outcome.reason = outcome.persistenceComplete ? 'forced-exit' : 'persistence-failure'
          persistenceFailure = undefined
        }
      }
      if (ended) return
      if (persistenceFailure) {
        outcome.persistenceComplete = false
        if (!await confirm(persistenceFailure)) { restore(); return }
        outcome.processExitClean = false
        outcome.forced = true
        outcome.reason = 'persistence-failure'
        persistenceFailure = undefined
      }
      try { await budget.run('本地状态保存', 2000, ports.save) }
      catch (error) {
        outcome.persistenceComplete = false
        outcome.processExitClean = false
        log(`phase=save, error=${String(error)}`)
        if (ended) return
        if (!await confirm(error)) { restore(); return }
        outcome.forced = true
        outcome.reason = 'persistence-failure'
      }
      if (ended) return
      try { await budget.run('日志落盘', 500, ports.drainLogs) }
      catch (error) {
        outcome.processExitClean = false
        if (outcome.reason === 'complete' || outcome.reason === 'residual' || outcome.reason === 'cleanup-timeout') outcome.reason = 'log-failure'
        log(`phase=logs, error=${String(error)}`)
      }
      finish()
    }).catch(async error => {
      log(`phase=failed, error=${String(error)}`)
      if (!ended) {
        const forcedFailure: Partial<ShutdownOutcome> = {
          processExitClean: false,
          persistenceComplete: false,
          localCleanupComplete: false,
          cleanupRemaining: null,
          forced: true,
          reason: 'forced-exit',
        }
        try { if (await confirm(error)) finish(forcedFailure); else restore() }
        catch { finish(forcedFailure) }
      }
    }).finally(() => { if (!closing) running = undefined })
    return running
  }
  return { request }
}
