import { createHash } from 'node:crypto'
import { basename, dirname, extname, resolve } from 'node:path'
import type { FontItem, SystemInstalledFont } from '../../shared/types'
import { sharedFileSystem as fs } from '../path/sharedFileSystemRuntime'
import { normalizePathForCacheCompare as key } from '../path/cachePath'
import { canonicalizeAbsolutePath, isPathInsideAbsoluteBoundary } from '../path/pathBoundaryPolicy'
import type { FontMutationPlan } from './fontMutationProcessRuntime'

export async function readFontMutationIdentity(path: string) {
  const canonical = canonicalizeAbsolutePath(path)
  if (!canonical || canonical.flavor !== 'windows' || !['.ttf', '.otf', '.ttc', '.otc'].includes(extname(path).toLowerCase())) throw new Error('字体操作路径无效。')
  const physical = await fs.realpath(canonical.ioPath)
  const stat = await fs.stat(physical)
  if (!stat.isFile() || stat.size > 256 * 1024 * 1024) throw new Error('字体文件类型或大小不符合操作要求。')
  const bytes = await fs.readFile(physical)
  const magic = bytes.subarray(0, 4).toString("hex")
  if (!["00010000", "4f54544f", "74746366", "74727565", "74797031"].includes(magic)) throw new Error("文件内容不是受支持的字体。")
  const after = await fs.stat(physical)
  if (stat.size !== after.size || stat.mtimeMs !== after.mtimeMs || stat.ino !== after.ino) throw new Error('字体读取过程中发生变化，未执行。')
  return { path: physical, sha256: createHash('sha256').update(bytes).digest('hex'), size: stat.size, modified: stat.mtimeMs, ino: stat.ino }
}

export async function planFontUninstall(item: FontItem, installed: SystemInstalledFont[], registry: SystemInstalledFont[], roots: string[], temporary: (record: SystemInstalledFont) => boolean): Promise<FontMutationPlan[]> {
  const source = await readFontMutationIdentity(item.path)
  const exact = installed.filter(record => record.path && key(record.path) === key(source.path) && !temporary(record))
  const hints = new Set((item.systemInstallMatches || []).map(record => key(record.path || '')))
  const possible = exact.length ? exact : installed.filter(record => record.path && !temporary(record) && (
    basename(record.path).toLowerCase() === basename(item.path).toLowerCase() || hints.has(key(record.path))
  ))
  const matched = new Map<string, Awaited<ReturnType<typeof readFontMutationIdentity>>>()
  for (const record of possible) {
    const path = record.path!
    if (matched.has(key(path))) continue
    const target = await readFontMutationIdentity(path)
    // Display names, stems and renderer matches are hints only. Distinct file
    // contents cannot grant permission to remove an installation.
    if (target.sha256 === source.sha256) matched.set(key(target.path), target)
  }
  if (!exact.length && matched.size > 1) throw new Error('存在多个内容相同的安装副本，无法唯一关联。请从已安装字体页面选择实际安装文件后重试。')
  const plans: FontMutationPlan[] = []
  for (const target of matched.values()) {
    const references = registry.filter(record => record.path && key(record.path) === key(target.path))
    if (references.some(temporary)) throw new Error('此安装文件仍被临时激活记录引用，请先取消关联激活。')
    const deleteFile = roots.some(root => isPathInsideAbsoluteBoundary(target.path, root) && key(dirname(target.path)) === key(resolve(root)))
    const allowReadonlyCopy = deleteFile && key(target.path) !== key(source.path)
      && !!roots[0] && key(dirname(target.path)) === key(resolve(roots[0]))
    // No recursive/prefix deletion, and no removal of an independent source
    // outside the actual installation directories.
    for (const scope of ['HKCU', 'HKLM'] as const) {
      const records = references.filter(record => record.source === scope).map(record => ({ scope, name: record.registryName, value: record.value }))
      if (records.length) plans.push({ path: target.path, sha256: target.sha256, delete_file: false, preflight_file: deleteFile, allow_readonly_copy: allowReadonlyCopy, records })
    }
    if (deleteFile) plans.push({ path: target.path, sha256: target.sha256, delete_file: true, allow_readonly_copy: allowReadonlyCopy, records: [] })
  }
  return plans
}
