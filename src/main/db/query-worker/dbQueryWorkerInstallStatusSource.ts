export function buildDbQueryWorkerInstallStatusSource(): string {
  return String.raw`
function ensureInstallStatusColumns(db) {
  const columns = db.prepare('PRAGMA table_info(install_status)').all()
  const names = new Set(columns.map((column) => column.name))
  const addColumn = (name, definition) => {
    if (!names.has(name)) {
      db.prepare('ALTER TABLE install_status ADD COLUMN ' + name + ' ' + definition).run()
      names.add(name)
    }
  }
  addColumn('signature', "TEXT NOT NULL DEFAULT ''")
  addColumn('installed', 'INTEGER NOT NULL DEFAULT 0')
  addColumn('by_type', "TEXT NOT NULL DEFAULT 'none'")
  addColumn('matches_json', "TEXT NOT NULL DEFAULT '[]'")
  addColumn('checked_at', 'TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP')
  addColumn('system_default', 'INTEGER NOT NULL DEFAULT 0')
}
function setMeta(db, key, value) {
  db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(key, String(value))
}
function initializeMachineInstallDb(db, rootPath) {
  db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS install_status (font_id TEXT PRIMARY KEY, signature TEXT NOT NULL DEFAULT '', installed INTEGER NOT NULL DEFAULT 0, by_type TEXT NOT NULL DEFAULT 'none', matches_json TEXT NOT NULL DEFAULT '[]', checked_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, system_default INTEGER NOT NULL DEFAULT 0);")
  ensureInstallStatusColumns(db)
  db.exec('CREATE INDEX IF NOT EXISTS idx_install_status_installed ON install_status(installed); CREATE INDEX IF NOT EXISTS idx_install_status_by_type ON install_status(by_type); CREATE INDEX IF NOT EXISTS idx_install_status_system_default ON install_status(system_default);')
  setMeta(db, 'schemaVersion', '1')
  setMeta(db, 'cacheArchitecture', 'v1-clean-machine-install')
  setMeta(db, 'rootPath', rootPath)
}
function normalizeInstallCompareResult(result) {
  if (!result || typeof result !== 'object') return null
  const by = ['managed', 'system', 'both', 'user', 'none'].includes(result.by) ? result.by : 'none'
  return { installed: !!result.installed, by, matches: Array.isArray(result.matches) ? result.matches : [] }
}
function readInstallStatusIndex(payload) {
  const startedAt = nowMs()
  const results = Object.create(null)
  const missingIds = []
  const timings = { groups: 0, rows: 0 }
  for (const group of payload.groups || []) {
    const items = group.items || []
    if (!items.length) continue
    timings.groups += 1
    if (!fs.existsSync(group.dbPath)) {
      for (const item of items) missingIds.push(item.id)
      continue
    }
    const db = new Database(group.dbPath, { readonly: true, fileMustExist: true })
    try {
      db.pragma('query_only = ON')
      const select = db.prepare('SELECT signature, installed, by_type, matches_json FROM install_status WHERE font_id = ?')
      for (const item of items) {
        const row = select.get(item.id)
        timings.rows += 1
        if (row && row.signature === item.signature) {
          const result = normalizeInstallCompareResult({ installed: !!row.installed, by: row.by_type, matches: parseJson(row.matches_json, []) })
          if (result) {
            results[item.id] = result
            continue
          }
        }
        missingIds.push(item.id)
      }
    } finally {
      db.close()
    }
  }
  timings.elapsed = nowMs() - startedAt
  return { results, missingIds, timings }
}
function saveInstallStatusIndex(payload) {
  const startedAt = nowMs()
  let written = 0
  let groupCount = 0
  const checkedAt = new Date().toISOString()
  for (const group of payload.groups || []) {
    const rows = group.rows || []
    if (!rows.length) continue
    fs.mkdirSync(path.dirname(group.dbPath), { recursive: true })
    const db = new Database(group.dbPath)
    try {
      initializeMachineInstallDb(db, group.rootPath || group.rootLabel || 'local-fallback')
      const insert = db.prepare('INSERT OR REPLACE INTO install_status (font_id, signature, installed, by_type, matches_json, checked_at, system_default) VALUES (?, ?, ?, ?, ?, ?, ?)')
      db.exec('BEGIN IMMEDIATE')
      try {
        for (const row of rows) {
          insert.run(row.fontId, row.signature || '', row.installed ? 1 : 0, row.by || 'none', JSON.stringify(row.matches || []), checkedAt, row.systemDefault ? 1 : 0)
          written += 1
        }
        setMeta(db, 'updatedAt', checkedAt)
        db.exec('COMMIT')
        groupCount += 1
      } catch (error) {
        try { db.exec('ROLLBACK') } catch {}
        throw error
      }
    } finally {
      db.close()
    }
  }
  return { written, groups: groupCount, timings: { elapsed: nowMs() - startedAt } }
}
`;
}
