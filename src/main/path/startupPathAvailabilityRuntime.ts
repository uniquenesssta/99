import { isApplicationClosing, applicationWorkEpoch } from '../app/shutdownCoordinatorRuntime'
import { registerIsolatedRoot } from '../rust-core/rustSharedIoCommandRuntime'
import { probeStartupDirectory } from './sharedPathProbeRuntime'
import { resolve } from 'node:path'
import { mappedDriveTableAsync, normalizeNativePathText } from './pathCanonicalizer'
import { normalizePathForCacheCompare } from './cachePath'
import { unavailableRootTtlMs, uncRootProbeTimeoutMs } from './ioDeadlineRuntime'

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
  const key = normalizePathForCacheCompare(/^(?:[a-z]:|\\\\)/i.test(normalized) ? normalized : resolve(rootPath))
  return aliases.get(key) || key
}

export function getStartupPathRootState(rootPath: string): SharedRootAvailabilitySnapshot {
  const rootId = entryKey(rootPath)
  let entry = entries.get(rootId)
  if (!entry) {
    entry = { state: 'checking', generation: ++generation, available: false, expiresAt: 0 }
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
  entries.set(key, {
    state: 'offline',
    generation: previous?.state === 'offline' ? previous.generation : ++generation,
    promise: previous?.promise,
    available: false,
    expiresAt: current + ttlMs,
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

export async function ensureStartupPathRootAvailable(rootPath: string, appendLog?: StartupPathAvailabilityLogger, reason = 'startup-path'): Promise<boolean> {
  if (isApplicationClosing()) return false
  const workEpoch = applicationWorkEpoch()
  if (!rootPath) return true
  const normalized = normalizeNativePathText(rootPath)
  const drive = normalized.match(/^([a-z]:)(\\.*)?$/i)
  if (drive && process.platform === 'win32') {
    const mapping = await mappedDriveTableAsync()
    if (isApplicationClosing() || applicationWorkEpoch() !== workEpoch) return false
    const remote = mapping?.get(drive[1].toUpperCase())
    const alias = normalizePathForCacheCompare(normalized)
    if (!remote && aliases.has(alias)) {
      markStartupPathRootUnavailable(rootPath, new Error('mapped root identity unverified'), appendLog, reason)
      return false
    }
    if (remote) {
      const canonical = normalizePathForCacheCompare(remote + (drive[2] || ''))
      if (aliases.has(alias) && aliases.get(alias) !== canonical) {
        markStartupPathRootUnavailable(rootPath, new Error('mapped root identity changed'), appendLog, reason)
        return false
      }
      aliases.set(alias, canonical)
      registerIsolatedRoot(rootPath, canonical)
    }
  }
  const key = entryKey(rootPath)
  const current = now()
  const existing = entries.get(key)
  if (existing?.promise) return existing.promise
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
    lastError: existing?.lastError,
    lastLoggedAt: existing?.lastLoggedAt,
    lastProbeQueuedMs: existing?.lastProbeQueuedMs,
    lastProbeExecutionMs: existing?.lastProbeExecutionMs,
  }
  entries.set(key, probeEntry)

  const promise = (async () => {
    try {
      const result = await probeStartupDirectory(rootPath, key, timeoutMs)
      if (isApplicationClosing() || applicationWorkEpoch() !== workEpoch || entries.get(key)?.generation !== stateGeneration) return false
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
        }
        return false
      }
      entries.set(key, {
        state: 'online',
        generation: stateGeneration,
        available: true,
        expiresAt: now() + Math.max(1000, Math.min(5000, timeoutMs)),
        lastProbeQueuedMs: result.queuedMs,
        lastProbeExecutionMs: result.executionMs,
      })
      return true
    } catch (error) {
      if (isApplicationClosing() || applicationWorkEpoch() !== workEpoch || entries.get(key)?.generation !== stateGeneration) return false
      const probeError = error as { reason?: string; queuedMs?: number; executionMs?: number }
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
          return true
        }
        return false
      }
      markStartupPathRootUnavailable(rootPath, error, appendLog, reason)
      const offline = entries.get(key)
      if (offline) {
        offline.lastProbeQueuedMs = Number(probeError.queuedMs || 0)
        offline.lastProbeExecutionMs = Number(probeError.executionMs || 0)
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
