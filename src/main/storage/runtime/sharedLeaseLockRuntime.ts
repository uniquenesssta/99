import { promises as fsp } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import os from 'node:os'

export interface SharedLeaseLockRecord {
  machineId: string
  operation: string
  resourceKey: string
  resourcePath: string
  token: string
  createdAt: number
  expiresAt: number
  pid: number
}

export interface SharedLeaseLockHandle {
  lockPath: string
  token: string
  record: SharedLeaseLockRecord
  release: () => Promise<void>
}

export interface SharedLeaseLockConflictDetails {
  lockPath: string
  requestedResourcePath: string
  lockedResourcePath: string
  machineId: string
  operation: string
  expiresAt: number
  remainingMs: number
}

export class SharedLeaseLockConflictError extends Error {
  details: SharedLeaseLockConflictDetails

  constructor(message: string, details: SharedLeaseLockConflictDetails) {
    super(message)
    this.name = 'SharedLeaseLockConflictError'
    this.details = details
    Object.setPrototypeOf(this, SharedLeaseLockConflictError.prototype)
  }
}

export interface SharedLeaseLockOptions {
  operation: string
  resourcePath: string
  roots?: string[]
  ttlMs?: number
  appendStartupLog?: (message: string) => void
}

export interface SharedLeaseLockManyOptions {
  operation: string
  resourcePaths: string[]
  roots?: string[]
  ttlMs?: number
  appendStartupLog?: (message: string) => void
}

const LOCK_DIR_NAME = '.hfm-locks'
const DEFAULT_TTL_MS = 30000

function leaseLocksDisabled(): boolean {
  return String(process.env.HFM_SHARED_LEASE_LOCKS || '').trim() === '0'
}

function configuredTtlMs(explicit?: number): number {
  if (Number.isFinite(explicit) && explicit && explicit > 0) return Math.max(1000, Math.round(explicit))
  const raw = Number(process.env.HFM_SHARED_LEASE_LOCK_TTL_MS || '')
  if (Number.isFinite(raw) && raw > 0) return Math.max(1000, Math.round(raw))
  return DEFAULT_TTL_MS
}

function normalizePathForLock(filePath: string): string {
  return resolve(String(filePath || '')).replaceAll('/', '\\').replace(/\\+$/g, '').toLowerCase()
}

function sha1(input: string): string {
  return createHash('sha1').update(input).digest('hex')
}

function isInsideRoot(filePath: string, rootPath: string): boolean {
  const file = normalizePathForLock(filePath)
  const root = normalizePathForLock(rootPath)
  return file === root || file.startsWith(`${root}\\`)
}

function nearestRootForResource(resourcePath: string, roots?: string[]): string | undefined {
  const candidates = (roots || [])
    .filter(Boolean)
    .map((root) => resolve(String(root)))
    .filter((root) => isInsideRoot(resourcePath, root))
    .sort((a, b) => normalizePathForLock(b).length - normalizePathForLock(a).length)
  return candidates[0]
}

export function sharedLeaseLockDirForResource(resourcePath: string, roots?: string[]): string {
  const lockRoot = nearestRootForResource(resourcePath, roots) || dirname(resolve(resourcePath))
  return join(lockRoot, LOCK_DIR_NAME)
}

export function sharedLeaseResourceKey(resourcePath: string): string {
  return sha1(normalizePathForLock(resourcePath))
}

function sharedLeaseLockPathForResource(resourcePath: string, roots?: string[]): string {
  const resolvedResourcePath = resolve(resourcePath)
  const lockDir = sharedLeaseLockDirForResource(resolvedResourcePath, roots)
  return join(lockDir, `${sharedLeaseResourceKey(resolvedResourcePath)}.lock.json`)
}

async function readLock(lockPath: string): Promise<SharedLeaseLockRecord | null> {
  try {
    const text = await fsp.readFile(lockPath, 'utf8')
    const parsed = JSON.parse(text) as Partial<SharedLeaseLockRecord>
    if (!parsed || typeof parsed !== 'object') return null
    if (!parsed.token || !parsed.expiresAt) return null
    return parsed as SharedLeaseLockRecord
  } catch {
    return null
  }
}

async function removeExpiredLock(lockPath: string, appendStartupLog?: (message: string) => void): Promise<boolean> {
  const existing = await readLock(lockPath)
  if (!existing) return false
  if (Number(existing.expiresAt || 0) > Date.now()) return false

  try {
    await fsp.unlink(lockPath)
    appendStartupLog?.(`shared lease lock expired and reclaimed: ${lockPath}`)
    return true
  } catch {
    return false
  }
}

async function releaseSharedLeaseLock(handle: SharedLeaseLockHandle, appendStartupLog?: (message: string) => void): Promise<void> {
  const existing = await readLock(handle.lockPath)
  if (!existing || existing.token !== handle.token) return

  try {
    await fsp.unlink(handle.lockPath)
  } catch (error) {
    appendStartupLog?.(`shared lease lock release failed: ${handle.lockPath} ${error instanceof Error ? error.message : String(error)}`)
  }
}

function buildSharedLeaseLockConflictDetails(
  record: SharedLeaseLockRecord,
  lockPath: string,
  requestedResourcePath: string
): SharedLeaseLockConflictDetails {
  const expiresAt = Number(record.expiresAt || 0)
  return {
    lockPath,
    requestedResourcePath,
    lockedResourcePath: record.resourcePath || requestedResourcePath,
    machineId: record.machineId || '未知设备',
    operation: record.operation || '未知操作',
    expiresAt,
    remainingMs: Math.max(0, expiresAt - Date.now())
  }
}

async function readSharedLeaseLockConflictDetails(options: SharedLeaseLockOptions): Promise<SharedLeaseLockConflictDetails | null> {
  const resourcePath = resolve(options.resourcePath)
  const lockPath = sharedLeaseLockPathForResource(resourcePath, options.roots)
  const record = await readLock(lockPath)
  if (!record) return null
  if (Number(record.expiresAt || 0) <= Date.now()) return null
  return buildSharedLeaseLockConflictDetails(record, lockPath, resourcePath)
}

function formatSharedLeaseLockConflictMessage(fallbackMessage: string, details: SharedLeaseLockConflictDetails): string {
  const remainingSeconds = Math.max(0, Math.ceil(details.remainingMs / 1000))
  const expiresAtText = details.expiresAt ? new Date(details.expiresAt).toISOString() : '未知'
  return `${fallbackMessage} 锁定设备：${details.machineId}；操作：${details.operation}；剩余约 ${remainingSeconds} 秒；到期：${expiresAtText}；资源：${details.lockedResourcePath}`
}

function formatSharedLeaseLockConflictLog(details: SharedLeaseLockConflictDetails): string {
  const remainingSeconds = Math.max(0, Math.ceil(details.remainingMs / 1000))
  return `shared lease lock conflict: machine=${details.machineId}, operation=${details.operation}, remaining=${remainingSeconds}s, requested=${details.requestedResourcePath}, locked=${details.lockedResourcePath}, lock=${details.lockPath}`
}

async function createSharedLeaseLockConflictError(options: SharedLeaseLockOptions, fallbackMessage: string): Promise<Error> {
  const details = await readSharedLeaseLockConflictDetails(options)
  if (!details) return new Error(fallbackMessage)
  options.appendStartupLog?.(formatSharedLeaseLockConflictLog(details))
  return new SharedLeaseLockConflictError(formatSharedLeaseLockConflictMessage(fallbackMessage, details), details)
}

export async function acquireSharedLeaseLock(options: SharedLeaseLockOptions): Promise<SharedLeaseLockHandle | null> {
  if (leaseLocksDisabled()) return null

  const resourcePath = resolve(options.resourcePath)
  const resourceKey = sharedLeaseResourceKey(resourcePath)
  const lockDir = sharedLeaseLockDirForResource(resourcePath, options.roots)
  const lockPath = sharedLeaseLockPathForResource(resourcePath, options.roots)
  const token = randomUUID()
  const now = Date.now()
  const record: SharedLeaseLockRecord = {
    machineId: `${os.hostname()}-${process.pid}`,
    operation: options.operation,
    resourceKey,
    resourcePath,
    token,
    createdAt: now,
    expiresAt: now + configuredTtlMs(options.ttlMs),
    pid: process.pid
  }

  await fsp.mkdir(lockDir, { recursive: true })

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await fsp.writeFile(lockPath, JSON.stringify(record), { flag: 'wx' })
      return {
        lockPath,
        token,
        record,
        release: () => releaseSharedLeaseLock({ lockPath, token, record, release: async () => undefined }, options.appendStartupLog)
      }
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? String((error as NodeJS.ErrnoException).code) : ''
      if (code !== 'EEXIST') throw error
      const reclaimed = await removeExpiredLock(lockPath, options.appendStartupLog)
      if (!reclaimed) return null
    }
  }

  return null
}

export async function withSharedLeaseLock<T>(options: SharedLeaseLockOptions, fn: () => Promise<T>): Promise<T> {
  if (leaseLocksDisabled()) return fn()

  const handle = await acquireSharedLeaseLock(options)
  if (!handle) {
    throw await createSharedLeaseLockConflictError(options, '其他设备正在操作该字体文件，请稍后再试。')
  }

  try {
    return await fn()
  } finally {
    await handle.release()
  }
}

export async function withSharedLeaseLocks<T>(options: SharedLeaseLockManyOptions, fn: () => Promise<T>): Promise<T> {
  if (leaseLocksDisabled()) return fn()

  const uniquePaths = Array.from(new Set((options.resourcePaths || []).filter(Boolean).map((path) => resolve(path))))
  const sortedPaths = uniquePaths.sort((a, b) => sharedLeaseResourceKey(a).localeCompare(sharedLeaseResourceKey(b)))
  const handles: SharedLeaseLockHandle[] = []

  try {
    for (const resourcePath of sortedPaths) {
      const handle = await acquireSharedLeaseLock({
        operation: options.operation,
        resourcePath,
        roots: options.roots,
        ttlMs: options.ttlMs,
        appendStartupLog: options.appendStartupLog
      })
      if (!handle) {
        throw await createSharedLeaseLockConflictError({
          operation: options.operation,
          resourcePath,
          roots: options.roots,
          ttlMs: options.ttlMs,
          appendStartupLog: options.appendStartupLog
        }, '其他设备正在操作相关字体文件或目录，请稍后再试。')
      }
      handles.push(handle)
    }

    return await fn()
  } finally {
    for (const handle of handles.reverse()) {
      await handle.release()
    }
  }
}

export const SHARED_LEASE_LOCK_DIR_NAME = LOCK_DIR_NAME
