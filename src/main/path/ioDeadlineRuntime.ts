import { promises as fsp } from 'node:fs'
export class IoDeadlineTimeoutError extends Error {
  readonly timeoutMs: number
  readonly label: string

  constructor(label: string, timeoutMs: number) {
    super(`${label} timed out after ${timeoutMs}ms`)
    this.name = 'IoDeadlineTimeoutError'
    this.label = label
    this.timeoutMs = timeoutMs
  }
}

export type IoDeadlineResult<T> =
  | { ok: true; value: T; timedOut: false }
  | { ok: false; error: unknown; timedOut: boolean }

export const DEFAULT_UNC_ROOT_PROBE_TIMEOUT_MS = 500
export const DEFAULT_PREVIEW_CACHE_QUERY_TIMEOUT_MS = 2000
export const DEFAULT_FILE_EXISTS_TIMEOUT_MS = 500
export const DEFAULT_SHARED_METADATA_QUERY_TIMEOUT_MS = 500
export const DEFAULT_UNAVAILABLE_ROOT_TTL_MS = 30000

function parseEnvTimeoutMs(name: string, fallbackMs: number): number {
  const raw = process.env[name]
  if (!raw) return fallbackMs
  const parsed = Number(raw)
  if (!Number.isFinite(parsed)) return fallbackMs
  return Math.max(100, Math.min(30000, Math.floor(parsed)))
}

export function uncRootProbeTimeoutMs(): number {
  return parseEnvTimeoutMs('HFM_UNC_ROOT_PROBE_TIMEOUT_MS', parseEnvTimeoutMs('HFM_IO_DEADLINE_MS', DEFAULT_UNC_ROOT_PROBE_TIMEOUT_MS))
}

export function previewCacheQueryTimeoutMs(): number {
  return parseEnvTimeoutMs('HFM_PREVIEW_CACHE_QUERY_TIMEOUT_MS', parseEnvTimeoutMs('HFM_IO_DEADLINE_MS', DEFAULT_PREVIEW_CACHE_QUERY_TIMEOUT_MS))
}

export function fileExistsTimeoutMs(): number {
  return parseEnvTimeoutMs('HFM_FILE_EXISTS_TIMEOUT_MS', DEFAULT_FILE_EXISTS_TIMEOUT_MS)
}

export function sharedMetadataQueryTimeoutMs(): number {
  return parseEnvTimeoutMs('HFM_SHARED_METADATA_QUERY_TIMEOUT_MS', parseEnvTimeoutMs('HFM_IO_DEADLINE_MS', DEFAULT_SHARED_METADATA_QUERY_TIMEOUT_MS))
}

export function unavailableRootTtlMs(): number {
  return parseEnvTimeoutMs('HFM_UNAVAILABLE_ROOT_TTL_MS', DEFAULT_UNAVAILABLE_ROOT_TTL_MS)
}

export function isIoDeadlineTimeout(error: unknown): error is IoDeadlineTimeoutError {
  return error instanceof IoDeadlineTimeoutError || (error instanceof Error && error.name === 'IoDeadlineTimeoutError')
}

export async function withIoDeadlineResult<T>(label: string, operation: () => Promise<T>, timeoutMs: number): Promise<IoDeadlineResult<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const boundedTimeoutMs = Math.max(100, Math.min(30000, Math.floor(Number(timeoutMs) || DEFAULT_UNC_ROOT_PROBE_TIMEOUT_MS)))
  const operationPromise = Promise.resolve().then(operation)
  operationPromise.catch(() => null)

  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new IoDeadlineTimeoutError(label, boundedTimeoutMs)), boundedTimeoutMs)
  })

  try {
    const value = await Promise.race([operationPromise, timeoutPromise])
    return { ok: true, value, timedOut: false }
  } catch (error) {
    return { ok: false, error, timedOut: isIoDeadlineTimeout(error) }
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export async function fileExistsWithDeadline(filePath: string, timeoutMs = fileExistsTimeoutMs()): Promise<boolean> {
  const result = await withIoDeadlineResult(`file-exists:${filePath}`, async () => {
    await fsp.access(filePath)
    return true
  }, timeoutMs)
  return result.ok ? result.value : false
}
