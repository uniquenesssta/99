import { resolve } from 'node:path'
import { normalizePathForCacheCompare } from '../../path/cachePath'

export type PreviewSharedStorageCircuitBreakerRuntime = {
  canUseSharedStorage: (rootPath: string) => boolean
  recordSharedStorageSuccess: (rootPath: string) => void
  recordSharedStorageFailure: (rootPath: string, error: unknown) => number
}

const DEFAULT_FAILURE_THRESHOLD = 3
const DEFAULT_LONG_FAILURE_THRESHOLD = 10
const DEFAULT_SHORT_OPEN_MS = 30000
const DEFAULT_LONG_OPEN_MS = 120000
const DEFAULT_LOG_THROTTLE_MS = 30000

function parseEnvInt(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const parsed = Number(raw)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.min(max, Math.floor(parsed)))
}

function failureThreshold(): number {
  return parseEnvInt('HFM_SHARED_CACHE_CIRCUIT_FAILURES', DEFAULT_FAILURE_THRESHOLD, 1, 100)
}

function longFailureThreshold(): number {
  return parseEnvInt('HFM_SHARED_CACHE_CIRCUIT_LONG_FAILURES', DEFAULT_LONG_FAILURE_THRESHOLD, 2, 500)
}

function shortOpenMs(): number {
  return parseEnvInt('HFM_SHARED_CACHE_CIRCUIT_OPEN_MS', DEFAULT_SHORT_OPEN_MS, 1000, 10 * 60 * 1000)
}

function longOpenMs(): number {
  return parseEnvInt('HFM_SHARED_CACHE_CIRCUIT_LONG_OPEN_MS', DEFAULT_LONG_OPEN_MS, 5000, 30 * 60 * 1000)
}

function logThrottleMs(): number {
  return parseEnvInt('HFM_SHARED_CACHE_CIRCUIT_LOG_MS', DEFAULT_LOG_THROTTLE_MS, 1000, 10 * 60 * 1000)
}

function rootKey(rootPath: string): string {
  return normalizePathForCacheCompare(resolve(String(rootPath || '')))
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

type CircuitState = {
  failures: number
  openUntil: number
  lastError?: string
  lastLoggedAt?: number
}

export function createPreviewSharedStorageCircuitBreakerRuntime(options: {
  appendStartupLog?: (message: string) => void
  now?: () => number
} = {}): PreviewSharedStorageCircuitBreakerRuntime {
  const states = new Map<string, CircuitState>()
  const now = options.now || (() => Date.now())

  function canUseSharedStorage(rootPath: string): boolean {
    if (!rootPath) return true
    const state = states.get(rootKey(rootPath))
    return !state?.openUntil || state.openUntil <= now()
  }

  function recordSharedStorageSuccess(rootPath: string): void {
    if (!rootPath) return
    states.delete(rootKey(rootPath))
  }

  function recordSharedStorageFailure(rootPath: string, error: unknown): number {
    if (!rootPath) return 0
    const key = rootKey(rootPath)
    const current = now()
    const previous = states.get(key)
    const failures = (previous?.failures || 0) + 1
    const openFor = failures >= longFailureThreshold()
      ? longOpenMs()
      : failures >= failureThreshold()
        ? shortOpenMs()
        : 0
    const openUntil = openFor ? current + openFor : previous?.openUntil || 0
    const message = errorMessage(error)
    const shouldLog = Boolean(openFor) && (!previous?.lastLoggedAt || current - previous.lastLoggedAt >= logThrottleMs() || previous.lastError !== message)

    states.set(key, {
      failures,
      openUntil,
      lastError: message,
      lastLoggedAt: shouldLog ? current : previous?.lastLoggedAt,
    })

    if (shouldLog) {
      options.appendStartupLog?.(`preview shared cache circuit open: ${rootPath}, failures=${failures}, openMs=${openFor}, reason=${message}`)
    }

    return openFor
  }

  return {
    canUseSharedStorage,
    recordSharedStorageSuccess,
    recordSharedStorageFailure,
  }
}
