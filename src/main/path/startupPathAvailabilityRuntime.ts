import { isApplicationClosing, applicationWorkEpoch } from '../app/shutdownCoordinatorRuntime'
import { AsyncLocalStorage } from 'node:async_hooks'
import { registerIsolatedRoot } from '../rust-core/rustSharedIoCommandRuntime'
import { probeStartupDirectory } from './sharedPathProbeRuntime'
import { resolve, win32 } from 'node:path'
import { mappedDriveTableAsync, normalizeNativePathText } from './pathCanonicalizer'
import { normalizePathForCacheCompare } from './cachePath'
import { awaitPhysicalIoClose, unavailableRootTtlMs, uncRootProbeTimeoutMs } from './ioDeadlineRuntime'

export type StartupPathAvailabilityLogger = (message: string) => void

export type SharedRootAvailabilityState = 'checking' | 'online' | 'offline' | 'recovering'
export type SharedRootAvailabilitySnapshot = Readonly<{
  rootId: string
  state: SharedRootAvailabilityState
  generation: number
  lastError?: string
  lastProbeQueuedMs?: number
  lastProbeExecutionMs?: number
}>

type AvailabilityEntry = {
  state: SharedRootAvailabilityState
  generation: number
  available: boolean
  expiresAt: number
  backgroundProbeAt: number
  backgroundBackoffStep: number
  promise?: Promise<boolean>
  lastError?: string
  lastLoggedAt?: number
  lastProbeQueuedMs?: number
  lastProbeExecutionMs?: number
}

const entries = new Map<string, AvailabilityEntry>()
const aliases = new Map<string, string>()
let generation = 0
const DEFAULT_LOG_THROTTLE_MS = 30000
const rootGuardScope = new AsyncLocalStorage<Array<() => void>>()

// Admission leases are main-owned and compose across nested operations. They
// are checked before side effects, never used to reinterpret a committed write.
export function assertStartupPathRootGuardCurrent(): void {
  for (const guard of rootGuardScope.getStore() || []) guard()
}

export function withStartupPathRootGuard<T>(guard: () => void, operation: () => Promise<T>): Promise<T> {
  assertStartupPathRootGuardCurrent()
  guard()
  return rootGuardScope.run([...(rootGuardScope.getStore() || []), guard], operation)
}

function now(): number {
  return Date.now()
}

function availabilityTtlMs(): number {
  return unavailableRootTtlMs()
}

function logThrottleMs(): number {
  return DEFAULT_LOG_THROTTLE_MS
}

function entryKey(rootPath: string): string {
  const normalized = normalizeNativePathText(rootPath)
  const key = normalizePathForCacheCompare(/^(?:[a-z]:|\\\\)/i.test(normalized) ? win32.normalize(normalized) : resolve(rootPath))
  return aliases.get(key) || key
}

function backgroundDelayMs(step: number): number {
  const base = Math.max(1000, availabilityTtlMs())
  return Math.min(300000, [base, base * 2, base * 4, 300000][Math.min(3, step)])
}

// The scheduler and background callers observe this owner's deadline. Reading
// it never refreshes mapping, extends a cooldown or creates a physical probe.
export function isStartupPathRootProbeDue(rootPath: string): boolean {
  const entry = entries.get(entryKey(rootPath))
  return !entry || (!entry.promise && Math.max(entry.backgroundProbeAt, entry.expiresAt) <= now())
}

export function getStartupPathRootState(rootPath: string): SharedRootAvailabilitySnapshot {
  const rootId = entryKey(rootPath)
  let entry = entries.get(rootId)
  if (!entry) {
    entry = { state: 'checking', generation: ++generation, available: false, expiresAt: 0, backgroundProbeAt: 0, backgroundBackoffStep: 0 }
    entries.set(rootId, entry)
  }
  return Object.freeze({
    rootId,
    state: entry.state,
    generation: entry.generation,
    lastError: entry.lastError,
    lastProbeQueuedMs: entry.lastProbeQueuedMs,
    lastProbeExecutionMs: entry.lastProbeExecutionMs,
  })
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function isUncLikePath(rootPath: string): boolean {
  const value = String(rootPath || '').trim()
  return value.startsWith('\\\\') || value.startsWith('//')
}

export function isStartupPathRootUnavailable(rootPath: string): boolean {
  if (!rootPath) return false
  const entry = entries.get(entryKey(rootPath))
  return Boolean(entry && entry.state === 'offline' && entry.expiresAt > now())
}

export function markStartupPathRootUnavailable(rootPath: string, error: unknown, appendLog?: StartupPathAvailabilityLogger, reason = 'startup-path'): void {
  if (!rootPath) return
  const key = entryKey(rootPath)
  const current = now()
  const previous = entries.get(key)
  const message = errorMessage(error)
  const ttlMs = availabilityTtlMs()
  const alreadyOffline = previous?.state === 'offline'
  entries.set(key, {
    state: 'offline',
    generation: previous?.state === 'offline' ? previous.generation : ++generation,
    promise: previous?.promise,
    available: false,
    // Observers and optional work may rediscover the same outage. Only a real
    // recovery attempt can establish another retry period.
    expiresAt: alreadyOffline ? previous.expiresAt : current + ttlMs,
    backgroundProbeAt: alreadyOffline ? previous.backgroundProbeAt : current + backgroundDelayMs(0),
    backgroundBackoffStep: alreadyOffline ? previous.backgroundBackoffStep : 0,
    lastError: message,
    lastLoggedAt: previous?.lastLoggedAt,
    lastProbeQueuedMs: previous?.lastProbeQueuedMs,
    lastProbeExecutionMs: previous?.lastProbeExecutionMs,
  })

  const latest = entries.get(key)
  if (latest?.lastLoggedAt && current - latest.lastLoggedAt < logThrottleMs() && latest.lastError === message) return
  if (latest) latest.lastLoggedAt = current
  appendLog?.(`startup path root unavailable: reason=${reason}, root=${rootPath}, ${message}; suppressed for ${ttlMs}ms`)
}

export async function ensureStartupPathRootAvailable(rootPath: string, appendLog?: StartupPathAvailabilityLogger, reason = 'startup-path', options: { background?: boolean; signal?: AbortSignal } = {}): Promise<boolean> {
  if (isApplicationClosing() || options.signal?.aborted) return false
  const workEpoch = applicationWorkEpoch()
  if (!rootPath) return true
  const known = entries.get(entryKey(rootPath))
  const normalized = normalizeNativePathText(rootPath)
  const drive = normalized.match(/^([a-z]:)(\\.*)?$/i)
  // Background observers must not refresh mapping or force a foreground-TTL
  // recheck while this identity's adaptive background deadline is pending.
  // A mapped caller still verifies its alias before joining a UNC-owned probe.
  if (known?.promise && (!drive || process.platform !== 'win32')) return known.promise
  if (options.background && known && !known.promise && known.backgroundProbeAt > now()) return known.state === 'online' && known.available
  if (known?.state === 'offline' && !known.promise && known.expiresAt > now()) return false
  const identityUnavailable = (error: unknown): false => {
    markStartupPathRootUnavailable(rootPath, error, appendLog, reason)
    const offline = entries.get(entryKey(rootPath))!
    // This is an actual identity attempt, unlike an observer marking the same
    // outage. Bound retries even when a remapped drive cannot be probed safely.
    offline.expiresAt = now() + availabilityTtlMs()
    offline.backgroundBackoffStep = options.background && known?.state === 'offline' ? Math.min(3, known.backgroundBackoffStep + 1) : 0
    offline.backgroundProbeAt = now() + backgroundDelayMs(offline.backgroundBackoffStep)
    return false
  }
  if (drive && process.platform === 'win32') {
    const mapping = await mappedDriveTableAsync()
    if (isApplicationClosing() || options.signal?.aborted || applicationWorkEpoch() !== workEpoch) return false
    const remote = mapping?.get(drive[1].toUpperCase())
    const alias = normalizePathForCacheCompare(win32.normalize(normalized))
    if (!mapping) return identityUnavailable(new Error('mapped root identity unavailable'))
    if (!remote && aliases.has(alias)) {
      return identityUnavailable(new Error('mapped root identity unverified'))
    }
    if (remote) {
      const canonical = normalizePathForCacheCompare(win32.normalize(remote + (drive[2] || '')))
      if (aliases.has(alias) && aliases.get(alias) !== canonical) {
        return identityUnavailable(new Error('mapped root identity changed'))
      }
      try { registerIsolatedRoot(rootPath, canonical) }
      catch (error) { return identityUnavailable(error) }
      aliases.set(alias, canonical)
    }
  }
  const key = entryKey(rootPath)
  const current = now()
  const existing = entries.get(key)
  if (existing?.promise) return existing.promise
  if (options.background && existing && existing.backgroundProbeAt > current) return existing.state === 'online' && existing.available
  if (existing && existing.expiresAt > current) return existing.available

  const enteringRecovery = existing?.state === 'offline' || existing?.state === 'recovering'
  const stateGeneration = enteringRecovery ? ++generation : existing?.generation ?? ++generation
  const probeState: SharedRootAvailabilityState = existing?.state === 'online' ? 'online' : enteringRecovery ? 'recovering' : 'checking'
  const timeoutMs = uncRootProbeTimeoutMs()
  const probeEntry: AvailabilityEntry = {
    state: probeState,
    generation: stateGeneration,
    available: probeState === 'online' && Boolean(existing?.available),
    expiresAt: current + availabilityTtlMs(),
    backgroundProbeAt: current + backgroundDelayMs(existing?.backgroundBackoffStep || 0),
    backgroundBackoffStep: existing?.backgroundBackoffStep || 0,
    lastError: existing?.lastError,
    lastLoggedAt: existing?.lastLoggedAt,
    lastProbeQueuedMs: existing?.lastProbeQueuedMs,
    lastProbeExecutionMs: existing?.lastProbeExecutionMs,
  }
  entries.set(key, probeEntry)

  const currentAttempt = () => !isApplicationClosing() && !options.signal?.aborted && applicationWorkEpoch() === workEpoch && entries.get(key)?.generation === stateGeneration
  const restoreInterrupted = () => {
    const latest = entries.get(key)
    if (!latest || latest.generation !== stateGeneration) return
    // An aborted quit/start-stop must not leave a recovering owner stuck or
    // accept its late receipt. The next explicit owner can initialize it again.
    Object.assign(latest, {
      state: existing?.state === 'online' ? 'online' : existing?.state === 'offline' ? 'offline' : 'checking',
      available: existing?.state === 'online' && existing.available,
      expiresAt: existing?.expiresAt || 0,
      backgroundProbeAt: existing?.backgroundProbeAt || 0,
      backgroundBackoffStep: existing?.backgroundBackoffStep || 0,
    })
  }
  const scheduleBackground = (entry: AvailabilityEntry, sameState: boolean) => {
    entry.backgroundBackoffStep = options.background && sameState ? Math.min(3, (existing?.backgroundBackoffStep || 0) + 1) : 0
    entry.backgroundProbeAt = now() + backgroundDelayMs(entry.backgroundBackoffStep)
  }

  const promise = (async () => {
    try {
      const result = await probeStartupDirectory(rootPath, key, timeoutMs, { signal: options.signal, registerRoot: false })
      if (!currentAttempt()) { restoreInterrupted(); return false }
      const latest = entries.get(key)
      if (!latest || latest.generation !== stateGeneration) return false
      latest.lastProbeQueuedMs = result.queuedMs
      latest.lastProbeExecutionMs = result.executionMs
      if (!result.directory) {
        markStartupPathRootUnavailable(rootPath, new Error('root path is not a directory'), appendLog, reason)
        const offline = entries.get(key)
        if (offline) {
          offline.lastProbeQueuedMs = result.queuedMs
          offline.lastProbeExecutionMs = result.executionMs
          scheduleBackground(offline, enteringRecovery)
        }
        return false
      }
      // Publication/registration belongs to this generation after the physical
      // receipt, not to the lower-level process caller before stop/removal checks.
      if (result.physicalPath) registerIsolatedRoot(rootPath, result.physicalPath)
      const online: AvailabilityEntry = {
        state: 'online',
        generation: stateGeneration,
        available: true,
        expiresAt: now() + Math.max(1000, Math.min(5000, timeoutMs)),
        backgroundProbeAt: 0,
        backgroundBackoffStep: 0,
        promise: probeEntry.promise,
        lastProbeQueuedMs: result.queuedMs,
        lastProbeExecutionMs: result.executionMs,
      }
      scheduleBackground(online, existing?.state === 'online')
      entries.set(key, online)
      return true
    } catch (error) {
      const probeError = (error && typeof error === 'object' ? error : {}) as { reason?: string; queuedMs?: number; executionMs?: number; closed?: Promise<unknown> }
      // Logical timeout/cancellation is not physical completion. The canonical
      // promise owns the probe until close, including across stop/resume.
      await awaitPhysicalIoClose(error)
      if (!currentAttempt()) { restoreInterrupted(); return false }
      const latest = entries.get(key)
      if (latest) {
        latest.lastProbeQueuedMs = Number(probeError.queuedMs || 0)
        latest.lastProbeExecutionMs = Number(probeError.executionMs || 0)
      }
      if (['queue-timeout','queue-full','cancelled','stopping','closing','stale-generation'].includes(String(probeError.reason || ''))) {
        appendLog?.(`startup path root probe inconclusive: reason=${reason}, root=${rootPath}, probeReason=${probeError.reason}, queuedMs=${probeError.queuedMs || 0}, executionMs=${probeError.executionMs || 0}`)
        if (existing?.state === 'online' && existing.available) {
          entries.set(key, {
            ...latest!,
            state: 'online',
            generation: stateGeneration,
            available: true,
            expiresAt: now() + Math.max(1000, timeoutMs),
          })
          scheduleBackground(entries.get(key)!, true)
          return true
        }
        restoreInterrupted()
        const interrupted = entries.get(key)
        if (interrupted) scheduleBackground(interrupted, enteringRecovery)
        return false
      }
      markStartupPathRootUnavailable(rootPath, error, appendLog, reason)
      const offline = entries.get(key)
      if (offline) {
        offline.lastProbeQueuedMs = Number(probeError.queuedMs || 0)
        offline.lastProbeExecutionMs = Number(probeError.executionMs || 0)
        scheduleBackground(offline, enteringRecovery)
      }
      return false
    }
  })()
  probeEntry.promise = promise
  try { return await promise } finally {
    const latest = entries.get(key)
    if (latest?.promise === promise) latest.promise = undefined
  }
}

export async function filterStartupAvailableRoots(roots: string[], appendLog?: StartupPathAvailabilityLogger, reason = 'startup-path'): Promise<{ availableRoots: string[]; skippedRoots: string[] }> {
  const availableRoots: string[] = []
  const skippedRoots: string[] = []
  for (const root of roots || []) {
    if (!root) continue
    if (isStartupPathRootUnavailable(root)) {
      skippedRoots.push(root)
      continue
    }
    if (await ensureStartupPathRootAvailable(root, appendLog, reason)) {
      availableRoots.push(root)
    } else {
      skippedRoots.push(root)
    }
  }
  return { availableRoots, skippedRoots }
}
