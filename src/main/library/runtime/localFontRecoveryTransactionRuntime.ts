import { recordOperationWork } from '../../logging/operationTraceContext'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import { normalizePathForCacheCompare as key } from '../../path/cachePath'
import type { FontTagBatchItem, FontRecoveryStateMove, FontTagRecoveryFile, FontTagRecoveryMissing } from '../../../shared/types'
import { localTagFontPath } from './localFontTagIdentityRuntime'

export function validateRecoveryTagWrites(db: any, items: FontTagBatchItem[]): void {
  for (const entry of items) {
    if (!entry.expectedTagNames) continue
    const current = db.prepare('SELECT DISTINCT tag_name FROM local_font_tags WHERE font_path = ?').all(localTagFontPath(entry.item)) as Array<{ tag_name: string }>
    const clean = (tags: string[]) => JSON.stringify([...new Set(tags.map(tag => tag.trim()).filter(Boolean))].sort())
    if (clean(current.map(row => row.tag_name)) !== clean(entry.expectedTagNames)) throw new Error('恢复期间本地标签已变化，原关联已保留，请重试。')
  }
}

// Main-process verified content moves only; tag IPC does not accept these options.
// Keep source decisions for another tag scope/retry and never overwrite a target favorite.
export function preserveLocalRecoveryState(db: any, moves: FontRecoveryStateMove[]): void {
  const exists = (name: string) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name)
  const favorites = exists('local_font_favorites'), protection = exists('local_font_protection')
  for (const { from, to } of moves) {
    if (from === to) continue
    if (favorites) db.prepare(`INSERT OR IGNORE INTO local_font_favorites(font_id, font_path, favorite)
      SELECT ?, ?, favorite FROM local_font_favorites WHERE font_path = ?
      AND NOT EXISTS (SELECT 1 FROM local_font_favorites WHERE font_path = ?) ORDER BY rowid DESC LIMIT 1`).run(`local-path:${to}`, to, from, to)
    if (protection) db.prepare(`INSERT INTO local_font_protection(font_path, protected)
      SELECT ?, protected FROM local_font_protection WHERE font_path = ? AND protected = 1
      ON CONFLICT(font_path) DO UPDATE SET protected = MAX(protected, excluded.protected)`).run(to, from)
  }
}

export function validateRecoveryFiles(files: FontTagRecoveryFile[]): void {
  for (const file of files) {
    const physical = fs.realpathSync(file.path)
    if (key(physical) !== key(file.physicalPath)) throw new Error('准备后的字体文件已变化，原关联已保留。')
    const bytes = fs.readFileSync(physical)
    recordOperationWork({ reads: 1, sourceBytes: bytes.length })
    if (key(physical) !== key(file.physicalPath) || createHash('sha256').update(bytes).digest('hex') !== file.sha256) throw new Error('准备后的字体文件已变化，原关联已保留。')
  }
}

export function validateRecoveryMissingSources(sources: FontTagRecoveryMissing[]): void {
  for (const source of sources) {
    try { fs.statSync(source.path); throw new Error('原字体路径已恢复，未修改关联。') }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    if (!fs.statSync(source.rootPath).isDirectory()) throw new Error('原字体根目录暂不可访问，未修改关联。')
  }
}
