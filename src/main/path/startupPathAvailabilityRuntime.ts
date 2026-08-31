import { promises as fsp } from 'node:fs'
import { resolve } from 'node:path'
import { normalizePathForCacheCompare } from './cachePath'
import { unavailableRootTtlMs, uncRootProbeTimeoutMs, withIoDeadlineResult } from './ioDeadlineRuntime'

export type StartupPathAvailabilityLogger = (message: string) => void

type AvailabilityEntry = {
  available: boolean
  expiresAt: number
  promise?: Promise<boolean>
  lastError?: string
  lastLoggedAt?: number
}

const entries = new Map<string, AvailabilityEntry>()
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
  return normalizePathForCacheCompare(resolve(String(rootPath || '')))
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
  return Boolean(entry && !entry.available && entry.expiresAt > now())
}

export function markStartupPathRootUnavailable(rootPath: string, error: unknown, appendLog?: StartupPathAvailabilityLogger, reason = 'startup-path'): void {
  if (!rootPath) return
  const key = entryKey(rootPath)
  const current = now()
  const previous = entries.get(key)
  const message = errorMessage(error)
  const ttlMs = availabilityTtlMs()
  entries.set(key, {
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
  if (!rootPath || !isUncLikePath(rootPath)) return true
  const key = entryKey(rootPath)
  const current = now()
  const existing = entries.get(key)
  if (existing?.promise) return existing.promise
  if (existing && existing.expiresAt > current) return existing.available

  const timeoutMs = uncRootProbeTimeoutMs()
  const promise = (async () => {
    const result = await withIoDeadlineResult(`startup-root-probe:${rootPath}`, () => fsp.stat(rootPath), timeoutMs)
    if (!result.ok) {
      const error = 'error' in result ? result.error : new Error('startup root probe failed')
      markStartupPathRootUnavailable(rootPath, error, appendLog, reason)
      return false
    }
    const stat = result.value as { isDirectory: () => boolean }
    if (!stat.isDirectory()) {
      markStartupPathRootUnavailable(rootPath, new Error('root path is not a directory'), appendLog, reason)
      return false
    }
    entries.set(key, { available: true, expiresAt: now() + Math.max(1000, Math.min(5000, timeoutMs)) })
    return true
  })()

  entries.set(key, {
    available: existing?.available || false,
    expiresAt: current + availabilityTtlMs(),
    promise,
    lastError: existing?.lastError,
    lastLoggedAt: existing?.lastLoggedAt,
  })
  return promise
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
