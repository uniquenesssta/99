import { relative } from 'node:path'
import { normalizePathForCacheCompare } from '../path/cachePath'
import type { FontItem } from '../../shared/types'

export class FontProtectionError extends Error {
  constructor(readonly reason: 'protected' | 'unknown', detail = '') {
    super(reason === 'protected' ? '已加入手动保护，未执行。' : `保护状态未知，未执行。${detail}`)
    this.name = 'FontProtectionError'
  }
}

export function readSharedFontProtection(db: any, item: FontItem, root: string): boolean {
  const relativePath = relative(root, item.path).replaceAll('\\', '/').toLowerCase()
  const pathKey = item.path.replaceAll('\\', '/').toLowerCase()
  const rows = db.prepare("SELECT delete_protected FROM font_metadata WHERE lower(replace(relative_path, char(92), '/')) = ? OR lower(replace(path_key, char(92), '/')) = ?").all(relativePath, pathKey) as Array<{ delete_protected: number }>
  if (rows.some(row => row.delete_protected !== 0 && row.delete_protected !== 1)) throw new FontProtectionError('unknown', '保护记录格式无效。')
  if (rows.some(row => row.delete_protected === 1)) return true
  if (db.prepare("SELECT 1 FROM font_metadata WHERE delete_protected = 1 AND COALESCE(relative_path, '') = '' AND COALESCE(path_key, '') = '' AND font_id IN (?, ?)").get(item.id, item.sourceId || item.id)) throw new FontProtectionError('unknown', '存在尚未归属到路径的历史保护记录。')
  if (!rows.length && !db.prepare("SELECT value FROM meta WHERE key = 'legacyRootIndexMetadataImportedAt'").get()?.value) throw new FontProtectionError('unknown', '历史保护迁移尚未确认。')
  return false
}

export function createFontProtectionAuthorityRuntime(deps: {
  roots: () => Promise<string[]>
  read: (item: FontItem, roots: string[]) => Promise<boolean>
  lock: <T>(items: FontItem[], roots: string[], action: () => Promise<T>) => Promise<T>
  log: (message: string) => void
}) {
  // Protection writes and destructive operations share one local order. Network
  // writers additionally take the same metadata-resource lease in lock().
  let tail: Promise<unknown> = Promise.resolve()
  let writeRevision = 0
  function serial<T>(action: () => Promise<T>): Promise<T> {
    const result = tail.then(action)
    tail = result.catch(() => undefined)
    return result
  }
  function targets(items: FontItem[]): FontItem[] {
    if (!items.length || items.some(item => !item?.id || !item.path)) throw new FontProtectionError('unknown', '目标标识或路径为空。')
    return [...new Map(items.map(item => [normalizePathForCacheCompare(item.path), { ...item }])).values()]
  }
  function rootKey(roots: string[]): string { return roots.map(normalizePathForCacheCompare).sort().join('\n') }
  async function locked<T>(items: FontItem[], action: (check: () => Promise<void>) => Promise<T>, revision?: number): Promise<T> {
    const roots = await deps.roots()
    return deps.lock(items, roots, async () => {
      const started = Date.now()
      const check = async () => {
        try {
          if (revision !== undefined && revision !== writeRevision) throw new Error('保护修改正在等待提交，请重试。')
          if (rootKey(await deps.roots()) !== rootKey(roots)) throw new Error('保护存储范围已变化，请重试。')
          for (const item of items) {
            if (await deps.read(item, roots)) throw new FontProtectionError('protected')
          }
          if (revision !== undefined && revision !== writeRevision) throw new Error('保护修改正在等待提交，请重试。')
          // Stop before the 120s shared lease can expire, including slow reads.
          if (Date.now() - started >= 90000) throw new Error('保护核验租约已接近到期，请重试。')
        } catch (error) {
          const failure = error instanceof FontProtectionError ? error : new FontProtectionError('unknown', String(error))
          deps.log(`font protection blocked: reason=${failure.reason}, targets=${items.length}, detail=${failure.message}`)
          throw failure
        }
      }
      return action(check)
    })
  }
  function mutate<T>(items: FontItem[], action: () => Promise<T>): Promise<T> {
    writeRevision += 1
    return serial(() => locked(targets(items), () => action()))
  }
  function guard<T>(items: FontItem[], action: (check: () => Promise<void>) => Promise<T>): Promise<T> {
    const revision = writeRevision
    return serial(async () => {
      try {
        deps.log(`font protection check: targets=${items.length}, ids=${items.slice(0, 12).map(item => item?.id).join(',')}`)
        return await locked(targets(items), async check => { await check(); return action(check) }, revision)
      } catch (error) {
        if (error instanceof FontProtectionError) throw error
        throw new FontProtectionError('unknown', String(error))
      }
    })
  }
  return { guard, mutate }
}
