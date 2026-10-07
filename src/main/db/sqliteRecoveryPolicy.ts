// Recovery is decided by the owning derived store, never by an arbitrary open
// failure or filename. Application/user-state stores must fail closed.
export class DerivedSqliteIncompatibleError extends Error {
  readonly code = 'HFM_DERIVED_SQLITE_INCOMPATIBLE'
}
export class SqliteIntegrityError extends Error {
  readonly code = 'HFM_SQLITE_INTEGRITY'
}
export class UnsupportedSqliteVersionError extends Error {
  readonly code = 'HFM_SQLITE_VERSION_UNSUPPORTED'
}
export function isRecoverableDerivedSqliteError(error: unknown): boolean {
  const value = error as { code?: string; errcode?: number; cause?: unknown; sharedIo?: boolean; reason?: string }
  if (value?.sharedIo) return value.reason === 'SQLITE_CORRUPT' || value.reason === 'SQLITE_NOTADB'
  if (value?.code === 'HFM_DERIVED_SQLITE_INCOMPATIBLE' || value?.code === 'HFM_SQLITE_INTEGRITY') return true
  if (value?.code === 'SQLITE_CORRUPT' || value?.code?.startsWith('SQLITE_CORRUPT_') || value?.code === 'SQLITE_NOTADB') return true
  if (value?.code === 'ERR_SQLITE_ERROR' && [11, 26].includes(Number(value.errcode) & 255)) return true
  return !!value?.cause && value.cause !== error && isRecoverableDerivedSqliteError(value.cause)
}

export function assertSupportedSqliteVersion(db: any, keys: string[], supported: number, label: string): void {
  const meta = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='meta'").get()
  if (!meta) return // Pre-versioning legacy shapes are validated by their owner.
  for (const key of keys) {
    const row = db.prepare('SELECT value FROM meta WHERE key=?').get(key) as { value?: string } | undefined
    if (!row) continue
    const version = Number(row.value)
    if (!/^\d+$/.test(String(row.value)) || !Number.isSafeInteger(version) || version > supported) {
      throw new UnsupportedSqliteVersionError(`${label} 数据库版本不受支持，已保留原文件：${key}=${row.value}`)
    }
  }
}

export function assertSqliteIntegrity(db: any): void {
  const rows = db.prepare('PRAGMA quick_check').all() as Array<Record<string, unknown>>
  if (rows.length !== 1 || String(Object.values(rows[0] || {})[0]).toLowerCase() !== 'ok') {
    throw new SqliteIntegrityError('SQLite quick_check 未通过，保留原数据库。')
  }
}

export function assertOwnedSqliteTables(db: any, allowed: string[], label: string): void {
  const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as Array<{name: string}>
  if (names.some(row => !allowed.includes(row.name))) throw new UnsupportedSqliteVersionError(`${label} 存在未识别数据表，保留原数据库。`)
}
