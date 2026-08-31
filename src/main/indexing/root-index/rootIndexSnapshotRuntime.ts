import { promises as fsp } from 'node:fs'
import { basename, join } from 'node:path'
import { sqliteSidecarPaths } from '../../cache/cachePaths'
import { ROOT_INDEX_DB_DIR_NAME, ROOT_INDEX_DB_FILE_NAME, ROOT_INDEX_SNAPSHOT_KEEP_COUNT } from '../../cache/constants'
import { normalizePathForCacheCompare } from '../../path/cachePath'

export interface RootIndexSnapshotRuntimeDeps {
  appendStartupLog: (line: string) => void
  resolveActiveRootIndexDbPath: (cacheDir: string, defaultDbPath: string) => Promise<string>
}

export interface RootIndexSnapshotInfo {
  path: string
  name: string
  mtimeMs: number
  sizeBytes: number
  active: boolean
  sidecars: string[]
  sidecarBytes: number
}

export interface RootIndexSnapshotMaintenanceReport {
  ok: boolean
  cacheDir: string
  activeDbPath: string
  defaultDbPath: string
  activeExists: boolean
  snapshotCount: number
  staleSnapshotCount: number
  orphanSidecarCount: number
  tmpFileCount: number
  totalSnapshotBytes: number
  totalSidecarBytes: number
  deletedFiles: string[]
  warnings: string[]
  suggestedActions: string[]
  snapshots: RootIndexSnapshotInfo[]
}

async function safeFileStat(filePath: string): Promise<{ isFile(): boolean; mtimeMs: number; size: number } | null> {
  return fsp.stat(filePath).catch(() => null)
}

function rootIndexTmpRetentionMs(): number {
  const value = Number(process.env.HFM_ROOT_INDEX_TMP_RETENTION_MS || 30 * 60 * 1000)
  return Math.max(5 * 60 * 1000, Math.min(24 * 60 * 60 * 1000, Number.isFinite(value) ? value : 30 * 60 * 1000))
}

async function removeIfOlderThan(filePath: string, retentionMs: number, deletedFiles: string[]): Promise<void> {
  const stat = await safeFileStat(filePath)
  if (!stat?.isFile()) return
  if (Date.now() - Number(stat.mtimeMs || 0) < retentionMs) return
  await fsp.rm(filePath, { force: true }).then(() => deletedFiles.push(filePath)).catch(() => undefined)
}

async function existingFileSize(filePath: string): Promise<number> {
  const stat = await safeFileStat(filePath)
  return stat?.isFile() ? Number(stat.size || 0) : 0
}

export function createRootIndexSnapshotRuntime(deps: RootIndexSnapshotRuntimeDeps) {
  function rootIndexSnapshotDbPath(cacheDir: string): string {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 23)
    return join(cacheDir, ROOT_INDEX_DB_DIR_NAME, `index.${stamp}.${process.pid}.sqlite`)
  }

  async function cleanupOldRootIndexSnapshots(cacheDir: string, activeDbPath: string): Promise<void> {
    try {
      const dbDir = join(cacheDir, ROOT_INDEX_DB_DIR_NAME)
      const files = await fsp.readdir(dbDir)
      const activeNormalized = normalizePathForCacheCompare(activeDbPath)
      const snapshots: Array<{ path: string; mtimeMs: number }> = []
      for (const file of files) {
        if (!/^index\..+\.sqlite$/i.test(file)) continue
        const filePath = join(dbDir, file)
        if (normalizePathForCacheCompare(filePath) === activeNormalized) continue
        const stat = await fsp.stat(filePath).catch(() => null)
        if (stat?.isFile()) snapshots.push({ path: filePath, mtimeMs: stat.mtimeMs })
      }
      snapshots.sort((a, b) => b.mtimeMs - a.mtimeMs)
      for (const snapshot of snapshots.slice(ROOT_INDEX_SNAPSHOT_KEEP_COUNT)) {
        for (const filePath of sqliteSidecarPaths(snapshot.path)) await fsp.rm(filePath, { force: true }).catch(() => undefined)
      }
    } catch (error) {
      deps.appendStartupLog(`root index snapshot cleanup skipped: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  async function inspectRootIndexSnapshotMaintenance(cacheDir: string, defaultDbPath: string): Promise<RootIndexSnapshotMaintenanceReport> {
    const dbDir = join(cacheDir, ROOT_INDEX_DB_DIR_NAME)
    const activeDbPath = await deps.resolveActiveRootIndexDbPath(cacheDir, defaultDbPath).catch(() => defaultDbPath)
    const activeNormalized = normalizePathForCacheCompare(activeDbPath)
    const activeExists = !!(await safeFileStat(activeDbPath))
    const warnings: string[] = []
    const suggestedActions: string[] = []
    const snapshots: RootIndexSnapshotInfo[] = []
    let tmpFileCount = 0
    let orphanSidecarCount = 0
    let totalSnapshotBytes = 0
    let totalSidecarBytes = 0

    let names: string[] = []
    try {
      names = await fsp.readdir(dbDir)
    } catch {
      warnings.push('root index database directory missing')
      suggestedActions.push('run a root scan to create shared index snapshot directory')
    }

    const nameSet = new Set(names)
    for (const name of names) {
      const lower = name.toLowerCase()
      const filePath = join(dbDir, name)
      if (lower.endsWith('.tmp') || lower.includes('.tmp-') || lower.endsWith('.sqlite.tmp')) tmpFileCount += 1
      if (!/^index\..+\.sqlite$/i.test(name) && lower !== ROOT_INDEX_DB_FILE_NAME) {
        if ((lower.endsWith('-wal') || lower.endsWith('-shm')) && !nameSet.has(name.replace(/-(wal|shm)$/i, ''))) orphanSidecarCount += 1
        continue
      }
      const stat = await safeFileStat(filePath)
      if (!stat?.isFile()) continue
      const sidecars = sqliteSidecarPaths(filePath).filter((sidecar) => sidecar !== filePath)
      let sidecarBytes = 0
      const existingSidecars: string[] = []
      for (const sidecar of sidecars) {
        const size = await existingFileSize(sidecar)
        if (size > 0) {
          existingSidecars.push(sidecar)
          sidecarBytes += size
        }
      }
      const active = normalizePathForCacheCompare(filePath) === activeNormalized
      snapshots.push({
        path: filePath,
        name: basename(filePath),
        mtimeMs: Number(stat.mtimeMs || 0),
        sizeBytes: Number(stat.size || 0),
        active,
        sidecars: existingSidecars,
        sidecarBytes,
      })
      totalSnapshotBytes += Number(stat.size || 0)
      totalSidecarBytes += sidecarBytes
    }

    snapshots.sort((a, b) => b.mtimeMs - a.mtimeMs)
    const inactiveSnapshots = snapshots.filter((snapshot) => !snapshot.active && /^index\..+\.sqlite$/i.test(snapshot.name))
    const staleSnapshotCount = Math.max(0, inactiveSnapshots.length - ROOT_INDEX_SNAPSHOT_KEEP_COUNT)

    const uninitialized = !activeExists && snapshots.length === 0 && tmpFileCount === 0 && orphanSidecarCount === 0
    if (!activeExists) {
      warnings.push(uninitialized ? 'root index has not been built yet' : 'active root index database missing')
      suggestedActions.push(uninitialized
        ? 'run the first root scan to create the shared index snapshot'
        : 'rebuild root index or repair latest pointer before serving shared index reads')
    }
    if (staleSnapshotCount > 0) suggestedActions.push('run root index snapshot maintenance cleanup to prune old inactive snapshots')
    if (tmpFileCount > 0) suggestedActions.push('remove stale root index tmp files after confirming no scan is running')
    if (orphanSidecarCount > 0) suggestedActions.push('remove orphan sqlite -wal/-shm sidecars for deleted snapshots')
    if (!suggestedActions.length) suggestedActions.push('no snapshot maintenance action required')

    return {
      ok: (activeExists || uninitialized) && staleSnapshotCount === 0 && tmpFileCount === 0 && orphanSidecarCount === 0,
      cacheDir,
      activeDbPath,
      defaultDbPath,
      activeExists,
      snapshotCount: snapshots.length,
      staleSnapshotCount,
      orphanSidecarCount,
      tmpFileCount,
      totalSnapshotBytes,
      totalSidecarBytes,
      deletedFiles: [],
      warnings,
      suggestedActions,
      snapshots,
    }
  }

  async function cleanupRootIndexSnapshotMaintenance(cacheDir: string, defaultDbPath: string): Promise<RootIndexSnapshotMaintenanceReport> {
    const before = await inspectRootIndexSnapshotMaintenance(cacheDir, defaultDbPath)
    const activeNormalized = normalizePathForCacheCompare(before.activeDbPath)
    const inactiveSnapshots = before.snapshots
      .filter((snapshot) => !snapshot.active && /^index\..+\.sqlite$/i.test(snapshot.name))
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
    const deletedFiles: string[] = []
    for (const snapshot of inactiveSnapshots.slice(ROOT_INDEX_SNAPSHOT_KEEP_COUNT)) {
      if (normalizePathForCacheCompare(snapshot.path) === activeNormalized) continue
      for (const filePath of sqliteSidecarPaths(snapshot.path)) {
        await fsp.rm(filePath, { force: true }).then(() => deletedFiles.push(filePath)).catch(() => undefined)
      }
    }

    const tmpRetentionMs = rootIndexTmpRetentionMs()
    const dbDir = join(cacheDir, ROOT_INDEX_DB_DIR_NAME)
    let names: string[] = []
    try { names = await fsp.readdir(dbDir) } catch { names = [] }
    const nameSet = new Set(names)
    for (const name of names) {
      const lower = name.toLowerCase()
      const filePath = join(dbDir, name)
      if (lower.endsWith('.tmp') || lower.includes('.tmp-') || lower.endsWith('.sqlite.tmp')) {
        await removeIfOlderThan(filePath, tmpRetentionMs, deletedFiles)
        continue
      }
      if ((lower.endsWith('-wal') || lower.endsWith('-shm')) && !nameSet.has(name.replace(/-(wal|shm)$/i, ''))) {
        await removeIfOlderThan(filePath, tmpRetentionMs, deletedFiles)
      }
    }

    const after = await inspectRootIndexSnapshotMaintenance(cacheDir, defaultDbPath)
    return { ...after, deletedFiles }
  }

  async function listRootIndexDatabaseFiles(cacheDir: string, defaultDbPath: string): Promise<string[]> {
    const files = new Set<string>([defaultDbPath])
    const activePath = await deps.resolveActiveRootIndexDbPath(cacheDir, defaultDbPath).catch(() => defaultDbPath)
    files.add(activePath)
    try {
      const dbDir = join(cacheDir, ROOT_INDEX_DB_DIR_NAME)
      const names = await fsp.readdir(dbDir)
      for (const name of names) {
        if (name.toLowerCase() === ROOT_INDEX_DB_FILE_NAME || /^index\..+\.sqlite$/i.test(name)) files.add(join(dbDir, name))
      }
    } catch {
      // ignore missing cache database dir
    }
    return Array.from(files)
  }

  return {
    rootIndexSnapshotDbPath,
    cleanupOldRootIndexSnapshots,
    inspectRootIndexSnapshotMaintenance,
    cleanupRootIndexSnapshotMaintenance,
    listRootIndexDatabaseFiles,
  }
}
