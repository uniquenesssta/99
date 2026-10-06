import { parse } from 'node:path'
import type { SystemInstalledFont } from '../../shared/types'
import { sharedFileSystem as fs } from '../path/sharedFileSystemRuntime'
import { normalizePathForCacheCompare as key } from '../path/cachePath'

export function fontRegistryRecordKey(record: { scope: string; name: string }): string {
  return `${record.scope}:${record.name.toLowerCase()}`
}

// One fresh gate snapshot owns one deduplicated, bounded set of read-only alias
// resolutions. Never reuse it across gates: a junction may have been retargeted.
export async function resolveFontRegistryPaths(records: SystemInstalledFont[]): Promise<Map<string, string>> {
  const paths = [...new Set(records.map(record => record.path || '').filter(Boolean))]
  if (records.some(record => !record.path)) throw new Error('安装引用缺少文件路径，未允许文件或属性清理。')
  const resolved = new Map<string, string>()
  let index = 0
  await Promise.all(Array.from({ length: Math.min(8, paths.length) }, async () => {
    for (;;) {
      const path = paths[index++]
      if (path === undefined) return
      try { resolved.set(key(path), key(await fs.realpath(path))) }
      catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
          try { if ((await fs.stat(parse(path).root)).isDirectory()) continue } catch { /* Unavailable is not absence. */ }
        }
        throw new Error(`安装引用路径无法核实，文件及属性保留：${path}；${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }))
  return resolved
}
