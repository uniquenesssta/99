import { sharedIoAvailabilityRoot, sharedIoResourceKeysSnapshot } from '../rust-core/rustSharedIoCommandRuntime'
import { awaitPhysicalIoClose } from '../path/ioDeadlineRuntime'
import { createOptionalMaintenanceAdmission, OptionalMaintenanceDeferred } from './optionalMaintenanceAdmissionRuntime'
import { join } from 'node:path'
import { sharedFileSystem as fsp } from '../path/sharedFileSystemRuntime'
import { readSharedDirectoryMetadata } from '../path/sharedDirectoryMetadataRuntime'
import { isIsoOlderThan } from './databaseMaintenanceHelpers'
import type { DatabaseMaintenanceRuntimeOptions, PreviewMaintenanceReport } from './databaseMaintenanceTypes'
import type { RustPreviewCacheMaintenanceInput } from '../rust-core/rustCoreWorkerContracts'

export interface PreviewCacheMaintenanceRuntimeDeps {
  isForegroundBusy?: () => boolean
  appendStartupLog?: (message: string) => void
  previewOkRetentionMs: number
  openPreviewDb: DatabaseMaintenanceRuntimeOptions['openPreviewDb']
  previewSqlitePath: DatabaseMaintenanceRuntimeOptions['previewSqlitePath']
  previewSqliteSchemaVersion: DatabaseMaintenanceRuntimeOptions['previewSqliteSchemaVersion']
  collectPreviewMaintenanceDirs: DatabaseMaintenanceRuntimeOptions['collectPreviewMaintenanceDirs']
  normalizePathForCacheCompare: DatabaseMaintenanceRuntimeOptions['normalizePathForCacheCompare']
  runRustPreviewCacheMaintenance?: DatabaseMaintenanceRuntimeOptions['runRustPreviewCacheMaintenance']
}

type MaintenanceRow = { preview_key: string; output_path: string; accessed_at?: string; generated_at?: string; updated_at?: string }
const BATCH_SIZE = 32
const ORPHAN_RETENTION_MS = 7 * 24 * 60 * 60 * 1000
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error)
const absent = (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT'

export function createPreviewCacheMaintenanceRuntime(deps: PreviewCacheMaintenanceRuntimeDeps) {
  async function runPreviewCacheMaintenance(): Promise<PreviewMaintenanceReport> {
    const report: PreviewMaintenanceReport = { checkedRows: 0, staleRows: 0, removedFiles: 0, removedOrphanFiles: 0, errors: [], complete: true, deferred: [] }
    const admission = createOptionalMaintenanceAdmission({ caller: 'preview-maintenance', isForegroundBusy: deps.isForegroundBusy, appendStartupLog: deps.appendStartupLog })
    const recordDeferred = (error: OptionalMaintenanceDeferred) => {
      report.complete = false
      if (report.deferred!.length < 32 && !report.deferred!.some(item => item.rootHash === error.detail.rootHash && item.blocker === error.detail.blocker && item.phase === error.detail.phase)) report.deferred!.push(error.detail)
    }
    return admission.run(async () => {
    try { await admission.checkpoint('open-local-db') }
    catch (error) { if (!(error instanceof OptionalMaintenanceDeferred)) throw error; recordDeferred(error); return report }
    const db = await deps.openPreviewDb()
    const locations = await deps.collectPreviewMaintenanceDirs()
    const input = { dbPath: deps.previewSqlitePath(), schemaVersion: deps.previewSqliteSchemaVersion,
      now: new Date().toISOString(), previewDirs: [], previewOkRetentionMs: deps.previewOkRetentionMs, orphanRetentionMs: ORPHAN_RETENTION_MS }
    const normalize = deps.normalizePathForCacheCompare
    const referenced = () => new Set<string>((db.prepare("SELECT output_path FROM preview_cache WHERE output_path != '' AND status IN ('ok', 'pending', 'generating')").all() as Array<{ output_path: string }>).map(row => normalize(row.output_path)))

    const roots = [...new Set(locations.map(location => location.rootPath).filter((root): root is string => !!root))].sort((a, b) => b.length - a.length)
    const contains = (parent: string, path: string) => {
      const value = normalize(path).replace(/\\/g, '/'), base = normalize(parent).replace(/\\/g, '/').replace(/\/$/, '')
      return value === base || value.startsWith(base + '/')
    }
    const rootForPath = (path: string): string | undefined => {
      const configured = roots.find(root => contains(root, path))
      if (configured) return configured
      if (!path || locations.some(location => !location.rootPath && contains(location.dirPath, path))) return undefined
      // Historical rows may contain a mapped drive's physical UNC alias. Use
      // the existing identity owner's snapshot, never refresh mappings here.
      const resources = sharedIoResourceKeysSnapshot([path])
      if (resources?.length === 0) return undefined
      return sharedIoAvailabilityRoot(path) || path
    }

    async function runBatch(batch: NonNullable<RustPreviewCacheMaintenanceInput['batch']>, rootPath?: string): Promise<void> {
      // Release admission/physical ownership between bounded calls, giving queued
      // foreground work a turn. Never replay a batch with an uncertain receipt.
      await admission.checkpoint('batch', rootPath)
      const native = await deps.runRustPreviewCacheMaintenance?.({ ...input, batch })
      if (native) {
        for (const key of ['checkedRows', 'staleRows', 'removedFiles', 'removedOrphanFiles'] as const) report[key] += native[key]
        report.errors.push(...native.errors)
        admission.assertCurrent('batch-result', rootPath)
        return
      }
      // Preserve the existing local Node fallback for old/unavailable workers.
      for (const declared of batch.rows) {
        await admission.checkpoint('row', rootPath)
        const row = db.prepare("SELECT preview_key, output_path, accessed_at, generated_at, updated_at FROM preview_cache WHERE preview_key = ? AND status = 'ok'").get(declared.previewKey) as MaintenanceRow | undefined
        if (!row || row.output_path !== declared.outputPath) continue
        report.checkedRows++
        try {
          let missing = !row.output_path
          if (!missing) {
            try {
              const stat = await fsp.lstat(row.output_path)
              if (stat.isSymbolicLink()) throw new Error('预览文件为符号链接，保留。')
              missing = !stat.isFile()
            } catch (error) { if (absent(error)) missing = true; else throw error }
          }
          const expired = !missing && isIsoOlderThan(row.accessed_at || row.generated_at || row.updated_at, deps.previewOkRetentionMs)
          // A concurrent preview touch/publish owns its newer row.
          const current = db.prepare('SELECT output_path, accessed_at, updated_at FROM preview_cache WHERE preview_key = ?').get(row.preview_key)
          if (!current || current.output_path !== row.output_path || current.accessed_at !== row.accessed_at || current.updated_at !== row.updated_at) continue
          admission.assertCurrent('row-write', rootPath)
          if (expired) { await fsp.rm(row.output_path, { force: true }); report.removedFiles++ }
          if (missing || expired) {
            const changed = db.prepare("UPDATE preview_cache SET status = 'stale', message = ?, updated_at = ? WHERE preview_key = ? AND output_path = ? AND updated_at IS ? AND accessed_at IS ?")
              .run(missing ? '预览文件不存在，已标记为需要重建。' : '预览缓存长期未访问，已标记为需要重建。', input.now, row.preview_key, row.output_path, row.updated_at, row.accessed_at)
            report.staleRows += Number(changed.changes || 0)
          }
        } catch (error) { if (error instanceof OptionalMaintenanceDeferred) throw error; await awaitPhysicalIoClose(error); report.errors.push(`预览维护失败，保留索引：${row.output_path} ${errorText(error)}`) }
      }
      if (!batch.orphanFiles.length) return
      if (batch.referenceDbPath && normalize(batch.referenceDbPath) !== normalize(input.dbPath)) {
        throw new Error('共享/回退预览孤立文件维护需要支持 bounded-v1 的 worker；未验证索引前保留文件。')
      }
      const paths = referenced()
      for (const path of batch.orphanFiles) {
        await admission.checkpoint('orphan', rootPath)
        if (paths.has(normalize(path))) continue
        try {
          const stat = await fsp.lstat(path)
          if (stat.isSymbolicLink() || !stat.isFile() || Date.now() - stat.mtimeMs < ORPHAN_RETENTION_MS) continue
          admission.assertCurrent('orphan-write', rootPath)
          await fsp.rm(path, { force: true })
          report.removedOrphanFiles++
        } catch (error) { if (error instanceof OptionalMaintenanceDeferred) throw error; await awaitPhysicalIoClose(error); if (!absent(error)) report.errors.push(`清理孤立预览失败：${path} ${errorText(error)}`) }
      }
    }

    // Keyset paging is stable while earlier rows become stale. No OFFSET skip,
    // full-tree write reservation or per-file process for directory enumeration.
    let cursor = ''
    while (true) {
      const rows = db.prepare("SELECT preview_key, output_path FROM preview_cache WHERE status = 'ok' AND preview_key > ? ORDER BY preview_key LIMIT ?").all(cursor, BATCH_SIZE) as MaintenanceRow[]
      if (!rows.length) break
      const groups = new Map<string | undefined, MaintenanceRow[]>()
      for (const row of rows) {
        const root = rootForPath(row.output_path)
        groups.set(root, [...(groups.get(root) || []), row])
      }
      let stopRows = false
      for (const [root, group] of groups) {
        try { await runBatch({ rows: group.map(row => ({ previewKey: row.preview_key, outputPath: row.output_path })), orphanFiles: [] }, root) }
        catch (error) {
          await awaitPhysicalIoClose(error)
          if (error instanceof OptionalMaintenanceDeferred) {
            recordDeferred(error)
            if (error.detail.blocker === 'foreground' || error.detail.blocker === 'closing') { stopRows = true; break }
          } else { report.errors.push(`预览维护批次失败：${errorText(error)}`); stopRows = true; break }
        }
      }
      if (stopRows) break
      cursor = rows[rows.length - 1].preview_key
    }

    const knownPaths = referenced()
    for (const location of locations) {
      let pending: string[] = []
      async function flush(): Promise<void> {
        if (!pending.length) return
        const files = pending; pending = []
        await runBatch({ rows: [], orphanFiles: files, referenceDbPath: location.referenceDbPath }, location.rootPath)
      }
      async function walk(dir: string): Promise<void> {
        await admission.checkpoint('directory', location.rootPath)
        const receipt = await readSharedDirectoryMetadata(dir)
        const entries = receipt?.entries ?? await fsp.readdir(dir, { withFileTypes: true })
        let visited = 0
        for (const entry of entries) {
          if (visited++ % BATCH_SIZE === 0) await admission.checkpoint('directory-batch', location.rootPath)
          admission.assertCurrent('directory-entry', location.rootPath)
          if (entry.isSymbolicLink()) continue
          const path = join(dir, entry.name)
          if (entry.isDirectory()) { await walk(path); continue }
          if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.png') || knownPaths.has(normalize(path))) continue
          if (!('stat' in entry && entry.stat)) await admission.checkpoint('directory-file', location.rootPath)
          const stat = 'stat' in entry && entry.stat ? entry.stat : await fsp.stat(path)
          if (Date.now() - stat.mtimeMs < ORPHAN_RETENTION_MS) continue
          pending.push(path)
          if (pending.length >= BATCH_SIZE) await flush()
        }
      }
      try { await walk(location.dirPath); await flush() }
      catch (error) {
        await awaitPhysicalIoClose(error)
        if (error instanceof OptionalMaintenanceDeferred) recordDeferred(error)
        else if (!absent(error)) report.errors.push(`预览目录维护失败：${location.dirPath} ${errorText(error)}`)
      }
    }
    report.complete = report.complete && report.errors.length === 0
    return report
    })
  }
  return { runPreviewCacheMaintenance }
}
