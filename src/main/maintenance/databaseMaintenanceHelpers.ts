import fs, { promises as fsp } from 'node:fs'
import { extname, join } from 'node:path'

export function sqliteStringLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

export function timestampForFileName(date = new Date()): string {
  return date.toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 23)
}

export function readSqliteQuickCheckMessage(db: any): string {
  const row = db.prepare('PRAGMA quick_check').get() as Record<string, unknown> | undefined
  return row ? String(Object.values(row)[0] || '') : ''
}

export function isoBefore(ms: number): string {
  return new Date(Date.now() - ms).toISOString()
}

export function isIsoOlderThan(value: string | null | undefined, thresholdMs: number): boolean {
  if (!value) return false
  const time = Date.parse(value)
  return Number.isFinite(time) && time < Date.now() - thresholdMs
}

export async function walkPreviewPngFiles(dir: string, visit: (filePath: string) => Promise<void>): Promise<void> {
  let entries: fs.Dirent[]
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true })
  } catch {
    return
  }

  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      await walkPreviewPngFiles(full, visit)
    } else if (entry.isFile() && extname(entry.name).toLowerCase() === '.png') {
      await visit(full)
    }
  }
}
