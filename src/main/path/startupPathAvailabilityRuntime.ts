import { isApplicationClosing, applicationWorkEpoch } from '../app/shutdownCoordinatorRuntime'
import { registerIsolatedRoot } from '../rust-core/rustSharedIoCommandRuntime'
import { probeStartupDirectory } from './sharedPathProbeRuntime'
import { resolve } from 'node:path'
import { mappedDriveTableAsync, normalizeNativePathText } from './pathCanonicalizer'
import { normalizePathForCacheCompare } from './cachePath'
import { unavailableRootTtlMs, uncRootProbeTimeoutMs, withIoDeadlineResult } from './ioDeadlineRuntime'

export type StartupPathAvailabilityLogger = (message: string) => void

export type SharedRootAvailabilityState = 'checking' | 'online' | 'offline' | 'recovering'
export type SharedRootAvailabilitySnapshot = Readonly<{
  rootId: string
  state: SharedRootAvailabilityState
  generation: number
  lastError?: string
}>

type AvailabilityEntry = {
  state: SharedRootAvailabilityState
  generation: number
  available: boolean
  expiresAt: number
  promise?: Promise<boolean>
  lastError?: string
  lastLoggedAt?: number
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
  return Object.freeze({ rootId, state: entry.state, generation: entry.generation, lastError: entry.lastError })
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
    generation: ++generation,
    promise: previous?.promise,
    available: false,
    expiresAt: current + ttlMs,
    lastError: message,
    lastLoggedAt: previous?.lastLoggedAt,
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
  registerIsolatedRoot(rootPath)
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
    }
  }
  const key = entryKey(rootPath)
  const current = now()
  const existing = entries.get(key)
  if (existing?.promise) return existing.promise
  if (existing && existing.expiresAt > current) return existing.available

  const stateGeneration = existing?.generation ?? ++generation
  const timeoutMs = uncRootProbeTimeoutMs()
  const promise = (async () => {
    const result = await withIoDeadlineResult(`startup-root-probe:${rootPath}`, () => probeStartupDirectory(rootPath, key, timeoutMs), timeoutMs)
    if (isApplicationClosing() || applicationWorkEpoch() !== workEpoch || entries.get(key)?.generation !== stateGeneration) return false
    if (!result.ok) {
      const error = 'error' in result ? result.error : new Error('startup root probe failed')
      markStartupPathRootUnavailable(rootPath, error, appendLog, reason)
      return false
    }
    if (!result.value) {
      markStartupPathRootUnavailable(rootPath, new Error('root path is not a directory'), appendLog, reason)
      return false
    }
    const latest = entries.get(key)
    if (!latest || latest.generation !== stateGeneration) return false
    const nextGeneration = latest.state === 'online' ? stateGeneration : ++generation
    entries.set(key, { state: 'online', generation: nextGeneration, available: true, expiresAt: now() + Math.max(1000, Math.min(5000, timeoutMs)) })
    return true
  })()

  entries.set(key, {
    state: existing?.state === 'online' ? 'online' : existing?.state === 'offline' || existing?.state === 'recovering' ? 'recovering' : 'checking',
    generation: stateGeneration,
    available: existing?.available || false,
    expiresAt: current + availabilityTtlMs(),
    promise,
    lastError: existing?.lastError,
    lastLoggedAt: existing?.lastLoggedAt,
  })
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
