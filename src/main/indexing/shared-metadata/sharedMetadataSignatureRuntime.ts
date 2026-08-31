import { promises as fsp } from 'node:fs'
import type { SharedFontMetadataRuntimeDeps } from './sharedFontMetadataRuntime'
import { sharedMetadataDbPathForRoot } from './sharedMetadataPathsRuntime'

export interface SharedMetadataSignatureRuntimeDeps {
  runtimeDeps: SharedFontMetadataRuntimeDeps
  openSharedMetadataDb: (rootPath: string, touch?: boolean) => Promise<any>
  readMeta: (db: any, key: string) => string
}

type DbFileState = { size: number; mtimeMs: number }
type SignatureCacheEntry = { value: string; state: string; expiresAt: number }

const SHARED_METADATA_SIGNATURE_TTL_MS = 500
const SHARED_METADATA_SIGNATURE_IN_FLIGHT_LIMIT = 64

async function statPath(filePath: string): Promise<DbFileState> {
  try {
    const stat = await fsp.stat(filePath)
    return { size: stat.size, mtimeMs: Math.floor(stat.mtimeMs) }
  } catch {
    return { size: -1, mtimeMs: 0 }
  }
}

async function sharedMetadataDbFileState(dbPath: string): Promise<string> {
  const [db, wal, shm] = await Promise.all([
    statPath(dbPath),
    statPath(`${dbPath}-wal`),
    statPath(`${dbPath}-shm`),
  ])
  return [db, wal, shm].map((item) => `${item.size}:${item.mtimeMs}`).join('|')
}

export function createSharedMetadataSignatureRuntime(deps: SharedMetadataSignatureRuntimeDeps) {
  const signatureCache = new Map<string, SignatureCacheEntry>()
  const signatureInFlight = new Map<string, Promise<string>>()

  function rememberSignature(dbPath: string, value: string, state: string): string {
    signatureCache.set(dbPath, { value, state, expiresAt: Date.now() + SHARED_METADATA_SIGNATURE_TTL_MS })
    while (signatureCache.size > SHARED_METADATA_SIGNATURE_IN_FLIGHT_LIMIT) {
      const oldest = signatureCache.keys().next().value
      if (!oldest) break
      signatureCache.delete(oldest)
    }
    return value
  }

  async function computeSharedMetadataSignature(rootPath: string, dbPath: string, state: string): Promise<string> {
    const rustResult = await deps.runtimeDeps.runRustSharedMetadataSignature?.({ dbPath }).catch((error) => {
      deps.runtimeDeps.appendStartupLog(`shared metadata rust signature skipped: ${rootPath}, ${error instanceof Error ? error.message : String(error)}`)
      return null
    })
    if (rustResult?.signature) return rememberSignature(dbPath, rustResult.signature, state)

    const db = await deps.openSharedMetadataDb(rootPath, false)
    try {
      const updatedAt = deps.readMeta(db, 'updatedAt')
      const row = db.prepare(`
        SELECT COUNT(*) AS count,
               COALESCE(MAX(revision), 0) AS max_revision,
               COALESCE(MAX(updated_at), '') AS max_updated_at
        FROM font_metadata
      `).get() as { count?: number; max_revision?: number; max_updated_at?: string } | undefined
      const tagOps = db.prepare(`
        SELECT CASE WHEN EXISTS (SELECT 1 FROM sqlite_master WHERE type='table' AND name='shared_tag_ops')
          THEN (SELECT COUNT(*) FROM shared_tag_ops)
          ELSE 0
        END AS op_count,
        CASE WHEN EXISTS (SELECT 1 FROM sqlite_master WHERE type='table' AND name='shared_tag_ops')
          THEN (SELECT COALESCE(MAX(rowid), 0) FROM shared_tag_ops)
          ELSE 0
        END AS max_op_rowid
      `).get() as { op_count?: number; max_op_rowid?: number } | undefined
      return rememberSignature(dbPath, [
        'metadata-v2',
        updatedAt || '',
        Number(row?.count || 0),
        Number(row?.max_revision || 0),
        String(row?.max_updated_at || ''),
        Number(tagOps?.op_count || 0),
        Number(tagOps?.max_op_rowid || 0),
      ].join('|'), state)
    } catch (error) {
      deps.runtimeDeps.appendStartupLog(`shared metadata signature fallback: ${rootPath}, ${error instanceof Error ? error.message : String(error)}`)
      return rememberSignature(dbPath, `metadata:stat:${Date.now()}`, state)
    } finally {
      deps.runtimeDeps.closeSqliteDb(db)
    }
  }

  async function sharedMetadataSignatureForRoot(rootPath: string): Promise<string> {
    const dbPath = sharedMetadataDbPathForRoot(rootPath)
    if (!(await deps.runtimeDeps.exists(dbPath).catch(() => false))) return 'metadata:none'

    const state = await sharedMetadataDbFileState(dbPath)
    const now = Date.now()
    const cached = signatureCache.get(dbPath)
    if (cached && cached.state === state && cached.expiresAt > now) return cached.value

    const existing = signatureInFlight.get(dbPath)
    if (existing) return existing

    let task: Promise<string>
    task = computeSharedMetadataSignature(rootPath, dbPath, state).finally(() => {
      if (signatureInFlight.get(dbPath) === task) signatureInFlight.delete(dbPath)
    })
    signatureInFlight.set(dbPath, task)
    while (signatureInFlight.size > SHARED_METADATA_SIGNATURE_IN_FLIGHT_LIMIT) {
      const oldest = signatureInFlight.keys().next().value
      if (!oldest) break
      signatureInFlight.delete(oldest)
    }
    return task
  }

  return { sharedMetadataSignatureForRoot }
}
