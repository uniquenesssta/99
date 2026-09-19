import { createRequire } from 'node:module'
import os from 'node:os'
import { sharedIoResourceKeys } from '../../rust-core/rustSharedIoCommandRuntime'
import { SharedIoProcessError } from '../../path/sharedIoProcessRuntime'
import type { RustSharedMetadataOverlayReadInput, RustSharedMetadataOverlayReadResult, RustSharedMetadataMaintenanceSnapshot } from '../../rust-core/rustCoreWorkerContracts'
import { createSharedMetadataDbRuntime } from './sharedMetadataDbRuntime'
import { sharedMetadataDbPathForRoot } from './sharedMetadataPathsRuntime'

const tables = ['font_metadata', 'shared_tag_ops', 'shared_tag_ops_archive', 'metadata_events', 'meta'] as const
export type SharedMetadataMaintenanceSnapshotOwner = { exists: boolean; db?: any; commit: () => Promise<void>; close: () => void }
export function createSharedMetadataMaintenanceSnapshotRuntime(
  run: (input: RustSharedMetadataOverlayReadInput) => Promise<RustSharedMetadataOverlayReadResult | null>,
  openMemoryDb = (): any => { const Database = createRequire(__filename)('better-sqlite3'); return new Database(':memory:') },
) {
  async function openIsolatedSnapshot(rootPath: string): Promise<SharedMetadataMaintenanceSnapshotOwner | undefined> {
    if (!(await sharedIoResourceKeys([rootPath])).length) return undefined
    const input = { rootPath, dbPath: sharedMetadataDbPathForRoot(rootPath), entries: [] }
    const common = { updatedAt: new Date().toISOString(), updatedBy: os.hostname(), writerPid: process.pid }
    const result = await run({ ...input, preflight: { ...common, phase: 'maintenance-snapshot' } })
    const snapshot = result?.preflight?.maintenance
    if (result?.preflight?.phase !== 'maintenance-snapshot' || result.preflight.version !== 1 || !snapshot || typeof snapshot.exists !== 'boolean' || !snapshot.token) throw new SharedIoProcessError('共享维护快照未确认。', 'unknown', 'invalid-receipt')
    if (!snapshot.exists) return { exists: false, close() {}, commit: async () => { throw new Error('不存在的共享库不能提交维护。') } }
    if (Object.keys(snapshot.tables).sort().join('|') !== [...tables].sort().join('|')) throw new Error('共享维护快照表不完整。')
    const db = openMemoryDb()
    try {
      createSharedMetadataDbRuntime({ openStableSqliteDb: () => { throw new Error('维护计划只能使用内存数据库。') }, appendStartupLog() {} }).initializeSharedMetadataDb(db)
      for (const table of tables) {
        const expected = new Set(['__rowid', ...db.prepare(`PRAGMA table_info(${table})`).all().map((column: {name: string}) => column.name)])
        db.exec(`DELETE FROM ${table}`)
        if (!Array.isArray(snapshot.tables[table])) throw new Error('共享维护快照条目无效。')
        for (const row of snapshot.tables[table]) {
          const keys = Object.keys(row)
          if (keys.length !== expected.size || keys.some(key => !expected.has(key))) throw new Error('共享维护快照结构不兼容。')
          const columns = keys.map(key => `"${key === '__rowid' ? 'rowid' : key.replaceAll('"', '""')}"`)
          db.prepare(`INSERT INTO ${table} (${columns.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...keys.map(key => row[key]))
        }
      }
    } catch (error) { db.close(); throw error }
    let submitted = false
    return { exists: true, db, close: () => db.close(), commit: async () => {
      if (submitted) throw new Error('共享维护提交不能重复发送。')
      const next: RustSharedMetadataMaintenanceSnapshot = { ...snapshot, tables: Object.fromEntries(tables.map(table => [table, db.prepare(`SELECT rowid AS __rowid, * FROM ${table} ORDER BY rowid`).all()])) }
      submitted = true
      const committed = await run({ ...input, preflight: { ...common, phase: 'maintenance-commit', token: snapshot.token, maintenance: next } })
      if (committed?.preflight?.version !== 1 || committed.preflight.phase !== 'maintenance-commit') throw new SharedIoProcessError('共享维护提交结果未知，未重发。', 'unknown', 'invalid-receipt')
    } }
  }
  return { openIsolatedSnapshot }
}
