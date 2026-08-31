export function parseSqliteJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string') return fallback
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

export function sqliteTableColumns(db: any, table: string): Set<string> {
  return new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name))
}

export function ensureSqliteColumn(
  db: any,
  table: string,
  column: string,
  declaration: string,
  appendLog?: (message: string) => void
): void {
  const columns = sqliteTableColumns(db, table)
  if (columns.has(column)) return
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${declaration};`)
  appendLog?.(`sqlite schema upgraded: added ${table}.${column}`)
}

export function sqliteTableExists(db: any, tableName: string): boolean {
  try {
    return db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(tableName) !== undefined
  } catch {
    return false
  }
}

export function sqlText(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

export function sqlNullableText(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null
}

export function sqlNumber(value: unknown, fallback = 0): number {
  return Number.isFinite(Number(value)) ? Number(value) : fallback
}

export function sqlNullableNumber(value: unknown): number | null {
  return Number.isFinite(Number(value)) ? Number(value) : null
}

export function sqlBool(value: unknown): number {
  return value ? 1 : 0
}

export function sqlJson(value: unknown, fallback: unknown): string {
  try {
    return JSON.stringify(value ?? fallback)
  } catch {
    return JSON.stringify(fallback)
  }
}

export function setSqliteMeta(db: any, key: string, value: string): void {
  db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(key, value)
}

export function getSqliteMeta(db: any, key: string, fallback = ''): string {
  try {
    const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value?: string } | undefined
    return typeof row?.value === 'string' ? row.value : fallback
  } catch {
    return fallback
  }
}
