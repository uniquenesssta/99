import { win32 } from 'node:path'
import { createHash } from 'node:crypto'
import { normalizeNativePathText } from '../path/pathCanonicalizer'

// Concrete-file identity, distinct from sharedFontId(relativePath, size, mtime).
// Callers must resolve mapped drives through the existing path authority first.
// This function performs no I/O and must never guess a missing/offline mapping.
export function fileRuntimeFontId(filePath: string, size: number, mtimeMs: number): string {
  const native = normalizeNativePathText(filePath)
  const unc = native.startsWith('\\\\')
  const body = (unc ? native.slice(2) : native).replace(/\\+/g, '\\')
  const normalized = (unc ? `\\\\${body}` : body).toLowerCase()
  if ((!/^[a-z]:\\.+/i.test(normalized) && !/^\\\\[^\\]+\\[^\\]+\\.+/.test(normalized))
    || normalized.split('\\').some(part => part === '.' || part === '..')
    || !Number.isSafeInteger(size) || size < 0 || !Number.isFinite(mtimeMs) || Math.abs(mtimeMs) > Number.MAX_SAFE_INTEGER) {
    throw new Error('Concrete font identity requires a canonical absolute file path and valid file stat')
  }
  const signature = `${normalized}|${size}|${Math.round(mtimeMs)}`
  return `file-v2:${createHash('sha1').update(signature).digest('hex')}`
}

export function runtimeFontIdFromEntry(root: string, entry: string, size: number, mtime: number): string {
  return fileRuntimeFontId(win32.isAbsolute(entry) ? entry : win32.join(root, entry), size, mtime)
}

export function registerFileIdentitySql(db: any): void {
  db.function('hfm_file_path', { deterministic: true }, (root: string, entry: string) => normalizeNativePathText(win32.isAbsolute(entry) ? entry : win32.join(root, entry)).toLowerCase())
  db.function('hfm_file_font_id', { deterministic: true }, (root: string, entry: string, size: number, mtime: number) => runtimeFontIdFromEntry(root, entry, size, mtime))
}

// Runtime IDs contain a namespace separator which cannot appear in Windows names.
export function fontFileNameToken(id: string): string {
  return id.replace(/^file-v2:/, '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 12)
    || createHash('sha1').update(id).digest('hex').slice(0, 12)
}
