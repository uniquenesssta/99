import { resolve } from 'node:path'
import { normalizePathForCacheCompare } from '../../path/cachePath'
import { unavailableRootTtlMs } from '../../path/ioDeadlineRuntime'
import { ensureStartupPathRootAvailable, getStartupPathRootState } from '../../path/startupPathAvailabilityRuntime'
import { createPreviewSharedStorageCircuitBreakerRuntime } from './previewSharedStorageCircuitBreakerRuntime'

export type PreviewCacheRootAvailabilityLogger = (message: string) => void

export type PreviewCacheRootAvailabilityRuntime = {
  ensureRootPreviewCacheAvailable: (rootPath: string) => Promise<boolean>
  markRootPreviewCacheUnavailable: (rootPath: string, error: unknown) => void
  isRootPreviewCacheUnavailable: (rootPath: string) => boolean
}

type RootAvailabilityEntry = {
  available: boolean
  rootGeneration?: number
  rootId?: string
  expiresAt: number
  promise?: Promise<boolean>
  probeToken?: object
  lastError?: string
  lastLoggedAt?: number
}

const DEFAULT_AVAILABLE_TTL_MS = 5000
const DEFAULT_UNAVAILABLE_TTL_MS = unavailableRootTtlMs()
const DEFAULT_LOG_THROTTLE_MS = 30000

function rootKey(rootPath: string): string {
  return normalizePathForCacheCompare(resolve(String(rootPath || '')))
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function createPreviewCacheRootAvailabilityRuntime(options: {
  appendStartupLog?: PreviewCacheRootAvailabilityLogger
  availableTtlMs?: number
  unavailableTtlMs?: number
  logThrottleMs?: number
  rootProbeTimeoutMs?: number
  now?: () => number
} = {}): PreviewCacheRootAvailabilityRuntime {
  const entries = new Map<string, RootAvailabilityEntry>()
  const availableTtlMs = Math.max(1000, Number(options.availableTtlMs || DEFAULT_AVAILABLE_TTL_MS) || DEFAULT_AVAILABLE_TTL_MS)
  const unavailableTtlMs = Math.max(1000, Number(options.unavailableTtlMs || DEFAULT_UNAVAILABLE_TTL_MS) || DEFAULT_UNAVAILABLE_TTL_MS)
  const logThrottleMs = Math.max(1000, Number(options.logThrottleMs || DEFAULT_LOG_THROTTLE_MS) || DEFAULT_LOG_THROTTLE_MS)
  const now = options.now || (() => Date.now())
  const circuitBreaker = createPreviewSharedStorageCircuitBreakerRuntime({
    appendStartupLog: options.appendStartupLog,
    now,
  })

  function logUnavailable(rootPath: string, key: string, message: string): void {
    const current = now()
    const previous = entries.get(key)
    if (previous?.lastLoggedAt && current - previous.lastLoggedAt < logThrottleMs && previous.lastError === message) return
    options.appendStartupLog?.(`preview cache root unavailable: ${rootPath}, ${message}; shared preview cache access is short-circuited for ${unavailableTtlMs}ms`)
    const existing = entries.get(key)
    if (existing) {
      existing.lastLoggedAt = current
      existing.lastError = message
    }
  }

  function markRootPreviewCacheUnavailable(rootPath: string, error: unknown): void {
    if (!rootPath) return
    const key = rootKey(rootPath)
    const message = errorMessage(error)
    const current = now()
    const previous = entries.get(key)
    const circuitOpenMs = circuitBreaker.recordSharedStorageFailure(rootPath, error)
    const unavailableForMs = Math.max(unavailableTtlMs, circuitOpenMs || 0)
    entries.set(key, {
      available: false,
      expiresAt: current + unavailableForMs,
      lastError: message,
      lastLoggedAt: previous?.lastLoggedAt,
    })
    logUnavailable(rootPath, key, message)
  }

  function isRootPreviewCacheUnavailable(rootPath: string): boolean {
    if (!rootPath) return false
    const entry = entries.get(rootKey(rootPath))
    return Boolean(entry && !entry.available && entry.expiresAt > now())
  }

  async function ensureRootPreviewCacheAvailable(rootPath: string): Promise<boolean> {
    if (!rootPath) return true
    if (!circuitBreaker.canUseSharedStorage(rootPath)) return false
    const key = rootKey(rootPath)
    const current = now()
    const existing = entries.get(key)
    if (existing?.promise) return existing.promise
    if (existing && existing.expiresAt > current) {
      if (!existing.available) return false
      const state = getStartupPathRootState(rootPath)
      if (state.state === 'online' && existing.rootGeneration === state.generation && existing.rootId === state.rootId) return true
    }

    const probeToken = {}
    const promise = (async () => {
      try {
        const rootAvailable = await ensureStartupPathRootAvailable(rootPath, options.appendStartupLog, 'preview-cache-root')
        if (entries.get(key)?.probeToken !== probeToken) return false
        if (!rootAvailable) {
          const rootState = getStartupPathRootState(rootPath)
          if (rootState.state === 'offline') {
            markRootPreviewCacheUnavailable(rootPath, new Error(rootState.lastError || 'shared root unavailable'))
          } else {
            entries.delete(key)
          }
          return false
        }
        circuitBreaker.recordSharedStorageSuccess(rootPath)
        const state = getStartupPathRootState(rootPath)
        entries.set(key, { available: true, rootGeneration: state.generation, rootId: state.rootId, expiresAt: now() + availableTtlMs })
        return true
      } catch (error) {
        if (entries.get(key)?.probeToken === probeToken) markRootPreviewCacheUnavailable(rootPath, error)
        return false
      }
    })()

    entries.set(key, {
      available: existing?.available || false,
      expiresAt: current + unavailableTtlMs,
      promise,
      probeToken,
      lastError: existing?.lastError,
      lastLoggedAt: existing?.lastLoggedAt,
    })
    return promise
  }

  return {
    ensureRootPreviewCacheAvailable,
    markRootPreviewCacheUnavailable,
    isRootPreviewCacheUnavailable,
  }
}
