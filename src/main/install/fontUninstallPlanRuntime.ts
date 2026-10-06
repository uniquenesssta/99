import { readFontContentIdentity as readFontMutationIdentity } from '../fonts/fontContentIdentityRuntime'
import { dirname, resolve } from 'node:path'
import type { FontItem, SystemInstalledFont } from '../../shared/types'
import { normalizePathForCacheCompare as key } from '../path/cachePath'
import { isPathInsideAbsoluteBoundary } from '../path/pathBoundaryPolicy'
import type { FontMutationPlan } from './fontMutationProcessRuntime'
import { createInstallCompareRuntime } from './fontInstallCompare'
import { createFontInstallEvidenceSession, independentInstallCopy, type InstallSourceIdentity } from './fontInstallEvidenceRuntime'

export { readFontContentIdentity as readFontMutationIdentity } from '../fonts/fontContentIdentityRuntime'

export async function planFontUninstall(item: FontItem, installed: SystemInstalledFont[], registry: SystemInstalledFont[], roots: string[], temporary: (record: SystemInstalledFont) => boolean, options: { source?: InstallSourceIdentity; appName?: string; report?: (evidence: Record<string, unknown>) => void; onTarget?: (identity: InstallSourceIdentity) => void } = {}): Promise<FontMutationPlan[]> {
  const source: InstallSourceIdentity = options.source || await readFontMutationIdentity(item.path)
  const exact = installed.filter(record => record.path && [item.path, source.path].some(path => key(record.path!) === key(path)) && !temporary(record))
  const compare = createInstallCompareRuntime({ appName: options.appName || '字体管理器' })
  const candidates = exact.length ? { installed: true, by: 'user' as const, matches: exact } : compare.compareFontInstalledWithList(item, installed.filter(record => !temporary(record)))
  const session = createFontInstallEvidenceSession()
  const confirmed = await session.confirm(item, candidates, source)
  const matched = new Map<string, InstallSourceIdentity>()
  const recordPaths = new Map<string, Set<string>>()
  for (const record of confirmed.matches) {
    const target = await session.read(record.path!)
    matched.set(key(target.path), target)
    const aliases = recordPaths.get(key(target.path)) || new Set<string>()
    aliases.add(key(record.path!)); aliases.add(key(target.path)); recordPaths.set(key(target.path), aliases)
  }
  const identities = new Set([...matched.values()].map(target => target.ino > 0 && Number.isFinite(target.dev) ? `${target.dev}:${target.ino}` : key(target.path)))
  options.report?.({ source: item.path, sourceKind: source.historical ? 'main-history' : 'current-file', candidateCount: candidates.matches.length, confirmedCount: matched.size, candidates: candidates.matches.map(record => ({ path: record.path, scope: record.source, name: record.registryName })), confirmed: [...matched.values()].map(target => ({ path: target.path, independentCopy: independentInstallCopy(source, target) })), reason: confirmed.reason, ambiguous: !exact.length && identities.size > 1 })
  if (confirmed.known === false || session.unavailablePaths().length) throw new Error(`安装候选当前不可访问，不能确认唯一卸载目标。${confirmed.reason}`)
  if (!exact.length && identities.size > 1) throw new Error('存在多个内容相同的安装副本，无法唯一关联。请从已安装字体页面选择实际安装文件后重试。')
  const plans: FontMutationPlan[] = []
  for (const target of matched.values()) {
    options.onTarget?.(target)
    const references = registry.filter(record => record.path && recordPaths.get(key(target.path))?.has(key(record.path)))
    if (references.some(temporary)) throw new Error('此安装文件仍被临时激活记录引用，请先取消关联激活。')
    const deleteFile = independentInstallCopy(source, target) && roots.some(root => isPathInsideAbsoluteBoundary(target.path, root) && key(dirname(target.path)) === key(resolve(root)))
    const allowReadonlyCopy = deleteFile
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
